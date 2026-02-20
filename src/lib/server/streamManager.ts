import * as path from 'node:path';
import * as fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { startCapture, fetchStreamMeta, fetchDouyuStreamMeta, fetchVodMeta, type CaptureHandle } from './captureProcess.js';
import { startTranscription, stopTranscription, transcribeFullRecording, shutdownTranscriber } from './transcriber.js';
import { startChatCollection } from './chatCollector.js';
import { startVodChatFetch, extractVideoId } from './vodChatFetcher.js';
import { exportVideo as exportVideoImpl } from './exporter.js';
import type { StreamInfo, ClipRegion, ChatMessage } from './types.js';
import * as db from './persistence.js';

const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings'));

// In-memory store of active captures (hot cache; persisted to SQLite on changes)
const captures = new Map<string, CaptureHandle>();

// In-memory store of transcriptions per stream (hot cache; persisted to SQLite)
const streamTranscriptions = new Map<string, Array<{ text: string; startTime: number; endTime: number }>>();

// In-memory store of chat messages per stream (hot cache; persisted to SQLite)
const streamChatMessages = new Map<string, ChatMessage[]>();

// In-memory store of clip regions (hot cache; persisted to SQLite)
const clipRegionsStore: ClipRegion[] = [];

// SSE clients for real-time updates
const sseClients = new Set<(data: string) => void>();

export function getRecordingsDir(): string {
	return RECORDINGS_DIR;
}

// --- Initialization: restore state from SQLite ---

/**
 * Initialize the stream manager by restoring persisted state from SQLite.
 * Should be called once at server startup.
 */
export async function initStreamManager(): Promise<void> {
	await db.initDatabase();

	// Restore streams as stopped stub handles
	const savedStreams = db.loadAllStreams();
	for (const info of savedStreams) {
		// Verify recording directory still exists
		if (!fs.existsSync(info.recordingDir)) {
			console.warn(`[init] Skipping stream ${info.channel} — recording dir missing: ${info.recordingDir}`);
			db.deleteStream(info.id);
			continue;
		}

		// Mark all restored streams as stopped (processes are gone after restart)
		info.status = 'stopped';

		const stubHandle: CaptureHandle = {
			info,
			kill: () => {},
			segmentWatchInterval: null
		};
		captures.set(info.id, stubHandle);
	}

	// Restore transcriptions
	const savedTranscriptions = db.loadAllTranscriptions();
	for (const [streamId, entries] of Object.entries(savedTranscriptions)) {
		if (captures.has(streamId)) {
			streamTranscriptions.set(streamId, entries);
		}
	}

	// Restore chat messages
	const savedChat = db.loadAllChatMessages();
	for (const [streamId, messages] of Object.entries(savedChat)) {
		if (captures.has(streamId)) {
			streamChatMessages.set(streamId, messages);
		}
	}

	// Restore clip regions
	const savedClips = db.loadAllClipRegions();
	for (const region of savedClips) {
		if (captures.has(region.streamId)) {
			clipRegionsStore.push(region);
		}
	}

	const streamCount = captures.size;
	const transcriptionCount = Object.values(savedTranscriptions).reduce((n, e) => n + e.length, 0);
	const chatCount = Object.values(savedChat).reduce((n, m) => n + m.length, 0);
	console.log(`[init] Restored ${streamCount} streams, ${transcriptionCount} transcriptions, ${chatCount} chat messages, ${clipRegionsStore.length} clip regions`);
}

// --- Broadcasting ---

function broadcast(data: string) {
	for (const send of sseClients) {
		try {
			send(data);
		} catch {
			sseClients.delete(send);
		}
	}
}

function broadcastUpdate(info: StreamInfo) {
	broadcast(JSON.stringify({ type: 'stream-update', stream: serializeStreamInfo(info) }));
}

function broadcastTranscription(streamId: string, text: string, startTime: number, endTime: number) {
	// Persist in memory
	let entries = streamTranscriptions.get(streamId);
	if (!entries) {
		entries = [];
		streamTranscriptions.set(streamId, entries);
	}
	entries.push({ text, startTime, endTime });

	// Persist to SQLite
	db.saveTranscription(streamId, text, startTime, endTime);

	broadcast(JSON.stringify({ type: 'transcription', streamId, text, startTime, endTime }));
}

// --- Batched chat message buffering ---
// Buffer chat messages per stream and flush periodically to avoid
// per-message SQLite INSERTs and SSE broadcasts during VOD chat download.
const CHAT_FLUSH_INTERVAL_MS = 500;
const chatBuffers = new Map<string, ChatMessage[]>();
const chatFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushChatBuffer(streamId: string) {
	const buf = chatBuffers.get(streamId);
	if (!buf || buf.length === 0) return;
	const msgs = buf.splice(0);

	// Persist in memory
	let messages = streamChatMessages.get(streamId);
	if (!messages) {
		messages = [];
		streamChatMessages.set(streamId, messages);
	}
	messages.push(...msgs);

	// Persist to SQLite in a single transaction
	db.saveChatMessagesBatch(streamId, msgs);
}

function broadcastChatMessage(streamId: string, msg: ChatMessage) {
	let buf = chatBuffers.get(streamId);
	if (!buf) {
		buf = [];
		chatBuffers.set(streamId, buf);
	}
	buf.push(msg);

	// Schedule flush if not already pending
	if (!chatFlushTimers.has(streamId)) {
		chatFlushTimers.set(
			streamId,
			setTimeout(() => {
				chatFlushTimers.delete(streamId);
				flushChatBuffer(streamId);
			}, CHAT_FLUSH_INTERVAL_MS)
		);
	}
}

function broadcastExportProgress(message: string, step: number, totalSteps: number) {
	broadcast(JSON.stringify({ type: 'export-progress', message, step, totalSteps }));
}

export function addSSEClient(send: (data: string) => void): () => void {
	sseClients.add(send);
	return () => sseClients.delete(send);
}

function serializeStreamInfo(info: StreamInfo) {
	return {
		id: info.id,
		channel: info.channel,
		status: info.status,
		startedAt: info.startedAt,
		error: info.error,
		segmentCount: info.segmentCount,
		diskUsageBytes: info.diskUsageBytes,
		viewerCount: info.viewerCount,
		streamTitle: info.streamTitle,
		gameName: info.gameName,
		offset: info.offset,
		sourceType: info.sourceType,
		parentStreamId: info.parentStreamId,
		platform: info.platform,
		sourceUrl: info.sourceUrl,
		chatMessageCount: streamChatMessages.get(info.id)?.length ?? 0
	};
}

// --- Stream management ---

/**
 * Start capturing a Twitch channel.
 * Returns the stream info with an assigned ID.
 * Automatically spawns a VOD capture if the streamer has an ongoing archive.
 */
export async function addStream(channel: string, language?: string | null, platform: 'twitch' | 'douyu' = 'twitch'): Promise<StreamInfo> {
	// Check if we're already capturing this channel (live track only — allow VOD alongside)
	for (const [, handle] of captures) {
		if (
			handle.info.channel.toLowerCase() === channel.toLowerCase() &&
			handle.info.platform === platform &&
			handle.info.sourceType === 'live' &&
			handle.info.status !== 'stopped'
		) {
			throw new Error(`Already capturing channel: ${channel}`);
		}
	}

	// Resolve transcription language: explicit arg > DB setting > null (auto-detect)
	const transcriptionLanguage = language ?? db.getChannelSettings(channel)?.language ?? null;

	const id = uuidv4();

	// Ensure recordings directory exists
	fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	const handle = startCapture(channel, id, RECORDINGS_DIR, (info) => {
		broadcastUpdate(info);

		// Persist stream state changes to SQLite
		db.saveStream(info);

		// Start transcription once segments begin appearing (guarded — only once per capture)
		if (info.status === 'capturing' && !handle.transcriptionStarted) {
			handle.transcriptionStarted = true;
			startTranscription(id, info.recordingDir, (_streamId, text, startTime, endTime) => {
				broadcastTranscription(id, text, startTime, endTime);
			}, transcriptionLanguage);

			// Start chat collection for live streams (Twitch only — guarded)
			if (info.sourceType === 'live' && platform === 'twitch' && !handle.chatStarted) {
				handle.chatStarted = true;
				handle.stopChat = startChatCollection(id, channel, info.startedAt, (_streamId, msg) => {
					broadcastChatMessage(id, msg);
				});
			}
		}
	}, undefined, platform);

	captures.set(id, handle);

	// Persist initial stream state
	db.saveStream(handle.info);

	return handle.info;
}

/**
 * Start capturing the VOD archive for a currently-live Twitch channel.
 * Fetches stream metadata to find the VOD ID, then starts a VOD capture.
 */
export async function addVodStream(channel: string, language?: string | null): Promise<StreamInfo> {
	const transcriptionLanguage = language ?? db.getChannelSettings(channel)?.language ?? null;

	const meta = await fetchStreamMeta(channel);
	if (!meta.vodId || !meta.createdAt) {
		throw new Error(`No VOD available for channel: ${channel}`);
	}

	const vodUrl = `https://twitch.tv/videos/${meta.vodId}`;

	// Check if this VOD is already added (by source URL or active channel capture)
	for (const [, handle] of captures) {
		if (handle.info.sourceUrl === vodUrl) {
			throw new Error(`VOD already added: ${vodUrl}`);
		}
		if (
			handle.info.channel.toLowerCase() === channel.toLowerCase() &&
			handle.info.sourceType === 'vod' &&
			handle.info.status !== 'stopped'
		) {
			throw new Error(`Already capturing VOD for channel: ${channel}`);
		}
	}

	const vodId = uuidv4();

	fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	const vodHandle = startCapture(channel, vodId, RECORDINGS_DIR, (info) => {
		broadcastUpdate(info);
		db.saveStream(info);

		if (info.status === 'capturing' && !vodHandle.transcriptionStarted) {
			vodHandle.transcriptionStarted = true;
			startTranscription(vodId, info.recordingDir, (_streamId, text, startTime, endTime) => {
				broadcastTranscription(vodId, text, startTime, endTime);
			}, transcriptionLanguage);

			// Start VOD chat download (guarded — only once per capture)
			if (!vodHandle.chatStarted) {
				vodHandle.chatStarted = true;
				const twitchVideoId = extractVideoId(vodUrl);
				if (twitchVideoId) {
					vodHandle.stopChat = startVodChatFetch(vodId, twitchVideoId, (_sid, msg) => {
						broadcastChatMessage(vodId, msg);
					});
				}
			}
		}
	}, vodUrl);

	vodHandle.info.startedAt = Date.parse(meta.createdAt);

	// Link to the live capture if one exists
	for (const [id, handle] of captures) {
		if (
			handle.info.channel.toLowerCase() === channel.toLowerCase() &&
			handle.info.sourceType === 'live'
		) {
			vodHandle.info.parentStreamId = id;
			break;
		}
	}

	captures.set(vodId, vodHandle);
	db.saveStream(vodHandle.info);

	console.log(`[vod:${channel}] Started VOD capture (video ${meta.vodId}), startedAt=${meta.createdAt}`);

	return vodHandle.info;
}

/**
 * Start capturing a Twitch VOD by its URL (e.g. https://twitch.tv/videos/12345).
 * Fetches VOD metadata to determine the channel and start time.
 */
export async function addVodByUrl(vodUrl: string, language?: string | null): Promise<StreamInfo> {
	// Detect platform from URL
	const isDouyu = /douyu\.com/.test(vodUrl);
	const platform: 'twitch' | 'douyu' = isDouyu ? 'douyu' : 'twitch';

	// Normalize the source URL for dedup: extract canonical form
	let canonicalUrl: string;
	if (isDouyu) {
		const douyuMatch = vodUrl.match(/douyu\.com\/(\d+)/);
		canonicalUrl = douyuMatch ? `https://douyu.com/${douyuMatch[1]}` : vodUrl.trim();
	} else {
		const twitchMatch = vodUrl.match(/(?:twitch\.tv\/videos\/|^)(\d+)/);
		canonicalUrl = twitchMatch ? `https://twitch.tv/videos/${twitchMatch[1]}` : vodUrl.trim();
	}

	// Check for duplicate VOD by source URL
	for (const [, handle] of captures) {
		if (handle.info.sourceUrl === canonicalUrl) {
			throw new Error(`VOD already added: ${canonicalUrl}`);
		}
	}

	if (isDouyu) {
		// Douyu VOD URL — extract room ID, capture via yt-dlp
		const douyuMatch = vodUrl.match(/douyu\.com\/(\d+)/);
		if (!douyuMatch) {
			throw new Error('Invalid Douyu URL — expected douyu.com/<roomId>');
		}
		const roomId = douyuMatch[1];
		const transcriptionLanguage = language ?? db.getChannelSettings(roomId)?.language ?? null;

		const id = uuidv4();
		fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

		const vodHandle = startCapture(roomId, id, RECORDINGS_DIR, (info) => {
			broadcastUpdate(info);
			db.saveStream(info);

			// Full-file transcription once VOD download completes
			if (info.status === 'stopped' && !vodHandle.transcriptionStarted) {
				vodHandle.transcriptionStarted = true;
				transcribeFullRecording(id, info.recordingDir, (_streamId, text, startTime, endTime) => {
					broadcastTranscription(id, text, startTime, endTime);
				}, transcriptionLanguage);
			}
		}, vodUrl, 'douyu');

		captures.set(id, vodHandle);
		db.saveStream(vodHandle.info);

		console.log(`[vod:douyu:${roomId}] Started Douyu VOD capture`);
		return vodHandle.info;
	}

	// Twitch VOD
	const match = vodUrl.match(/(?:twitch\.tv\/videos\/|^)(\d+)/);
	if (!match) {
		throw new Error('Invalid VOD URL — expected twitch.tv/videos/<id>');
	}
	const videoId = match[1];

	const meta = await fetchVodMeta(videoId);
	if (!meta.channel) {
		throw new Error(`VOD not found: ${videoId}`);
	}

	const channel = meta.channel;
	const transcriptionLanguage = language ?? db.getChannelSettings(channel)?.language ?? null;

	const id = uuidv4();
	const fullVodUrl = `https://twitch.tv/videos/${videoId}`;

	fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	const vodHandle = startCapture(channel, id, RECORDINGS_DIR, (info) => {
		broadcastUpdate(info);
		db.saveStream(info);

		if (info.status === 'capturing') {
			// Start VOD chat download (guarded — only once per capture)
			if (!vodHandle.chatStarted) {
				vodHandle.chatStarted = true;
				vodHandle.stopChat = startVodChatFetch(id, videoId, (_sid, msg) => {
					broadcastChatMessage(id, msg);
				});
			}
		}

		// Full-file transcription once VOD download completes
		if (info.status === 'stopped' && !vodHandle.transcriptionStarted) {
			vodHandle.transcriptionStarted = true;
			transcribeFullRecording(id, info.recordingDir, (_streamId, text, startTime, endTime) => {
				broadcastTranscription(id, text, startTime, endTime);
			}, transcriptionLanguage);
		}
	}, fullVodUrl, 'twitch');

	if (meta.createdAt) {
		vodHandle.info.startedAt = Date.parse(meta.createdAt);
	}
	vodHandle.info.streamTitle = meta.title;

	captures.set(id, vodHandle);
	db.saveStream(vodHandle.info);

	console.log(`[vod:${channel}] Started VOD capture by URL (video ${videoId}), title=${meta.title}`);

	return vodHandle.info;
}

/**
 * Stop a stream's capture process but keep it in the map for playback.
 */
export function stopStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	if (handle.info.status === 'stopped') return true;
	stopTranscription(id);
	handle.stopChat?.();
	handle.kill();

	// Persist stopped status
	db.saveStream(handle.info);

	return true;
}

/**
 * Re-transcribe a stopped stream using full-file transcription.
 * Clears existing transcriptions and starts fresh.
 */
export function retranscribeStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	if (handle.info.status !== 'stopped') return false;

	// Clear existing transcriptions
	streamTranscriptions.delete(id);
	db.deleteTranscriptions(id);
	broadcast(JSON.stringify({ type: 'transcription-cleared', streamId: id }));

	// Resolve language
	const language = db.getChannelSettings(handle.info.channel)?.language ?? null;

	// Fire-and-forget full transcription
	transcribeFullRecording(id, handle.info.recordingDir, (_streamId, text, startTime, endTime) => {
		broadcastTranscription(id, text, startTime, endTime);
	}, language);

	return true;
}

/**
 * Remove a stream entirely by ID.
 */
export function removeStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;

	stopTranscription(id);
	handle.stopChat?.();
	handle.transcriptionStarted = true; // prevent full transcription from firing on kill
	handle.kill();
	captures.delete(id);

	// Cancel any pending chat flush and discard buffer
	const pendingFlush = chatFlushTimers.get(id);
	if (pendingFlush) clearTimeout(pendingFlush);
	chatFlushTimers.delete(id);
	chatBuffers.delete(id);

	// Remove from in-memory caches
	streamTranscriptions.delete(id);
	streamChatMessages.delete(id);
	const clipIndicesToRemove: number[] = [];
	for (let i = clipRegionsStore.length - 1; i >= 0; i--) {
		if (clipRegionsStore[i].streamId === id) {
			clipRegionsStore.splice(i, 1);
		}
	}

	// Remove from SQLite (cascades to transcriptions, chat, clips)
	db.deleteStream(id);

	// Delete recording files from disk
	const recordingDir = handle.info.recordingDir;
	if (recordingDir && fs.existsSync(recordingDir)) {
		fs.rm(recordingDir, { recursive: true, force: true }, (err) => {
			if (err) console.error(`Failed to delete recording dir ${recordingDir}:`, err);
		});
	}

	return true;
}

/**
 * List all current streams (active and recently stopped).
 */
export function listStreams(): ReturnType<typeof serializeStreamInfo>[] {
	const results: ReturnType<typeof serializeStreamInfo>[] = [];
	for (const [, handle] of captures) {
		results.push(serializeStreamInfo(handle.info));
	}
	return results;
}

/**
 * Get a single stream's info.
 */
export function getStream(id: string): ReturnType<typeof serializeStreamInfo> | null {
	const handle = captures.get(id);
	if (!handle) return null;
	return serializeStreamInfo(handle.info);
}

/**
 * Update a stream's timeline offset.
 */
export function updateStreamOffset(id: string, offset: number): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	handle.info.offset = offset;

	// Persist to SQLite
	db.updateStreamOffset(id, offset);

	return true;
}

// --- Clip regions ---

/**
 * Add or update a clip region (upsert by ID).
 * Validates that startTime < endTime.
 */
export function addClipRegion(region: ClipRegion): void {
	if (region.startTime >= region.endTime) {
		throw new Error(`Invalid clip region: startTime (${region.startTime}) must be less than endTime (${region.endTime})`);
	}
	const idx = clipRegionsStore.findIndex((r) => r.id === region.id);
	if (idx !== -1) {
		clipRegionsStore[idx] = region;
	} else {
		clipRegionsStore.push(region);
	}

	// Persist to SQLite
	db.saveClipRegion(region);
}

/**
 * Remove a clip region by ID.
 */
export function removeClipRegion(id: string): boolean {
	const idx = clipRegionsStore.findIndex((r) => r.id === id);
	if (idx === -1) return false;
	clipRegionsStore.splice(idx, 1);

	// Remove from SQLite
	db.deleteClipRegion(id);

	return true;
}

/**
 * Get all clip regions.
 */
export function getAllClipRegions(): ClipRegion[] {
	return clipRegionsStore;
}

/**
 * Get all stored transcriptions for a stream.
 */
export function getTranscriptions(id: string): Array<{ text: string; startTime: number; endTime: number }> {
	return streamTranscriptions.get(id) || [];
}

/**
 * Get all stored chat messages for a stream.
 */
export function getChatMessages(id: string): ChatMessage[] {
	return streamChatMessages.get(id) || [];
}

/**
 * Get chat messages for a stream within a time range (stream-local seconds).
 */
export function getChatMessagesInRange(id: string, fromTime: number, toTime: number): ChatMessage[] {
	return db.loadChatMessagesInRange(id, fromTime, toTime);
}

/**
 * Get pre-bucketed chat heatmap data for a stream.
 */
export function getChatHeatmap(id: string, bucketSeconds: number): { buckets: Array<{ time: number; count: number }>; max: number } {
	const rows = db.loadChatHeatmap(id, bucketSeconds);
	let max = 0;
	const buckets = rows.map((r) => {
		if (r.count > max) max = r.count;
		return { time: r.bucket, count: r.count };
	});
	return { buckets, max };
}

/**
 * Get the recording directory path for a stream.
 */
export function getStreamRecordingDir(id: string): string | null {
	const handle = captures.get(id);
	if (!handle) return null;
	return handle.info.recordingDir;
}

// --- Video export ---

/**
 * Export all clip regions as a single stitched video file.
 */
export async function exportVideo(filename: string): Promise<{ outputPath: string }> {
	return exportVideoImpl(
		clipRegionsStore,
		filename,
		(streamId) => {
			const handle = captures.get(streamId);
			return handle ? handle.info : null;
		},
		broadcastExportProgress
	);
}

// --- Shutdown ---

/**
 * Clean up all captures on shutdown.
 */
export function shutdownAll() {
	shutdownTranscriber();
	for (const [, handle] of captures) {
		handle.stopChat?.();
		handle.kill();
	}
	captures.clear();
	db.closeDatabase();
}

// Cleanup on process exit
process.on('SIGINT', () => {
	shutdownAll();
	process.exit(0);
});
process.on('SIGTERM', () => {
	shutdownAll();
	process.exit(0);
});
