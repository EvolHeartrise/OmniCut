import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { startCapture, fetchStreamMeta, fetchVodMeta, type CaptureHandle } from './captureProcess.js';
import { startTranscription, stopTranscription, transcribeFullRecording, shutdownTranscriber } from './transcriber.js';
import { startChatCollection } from './chatCollector.js';
import { startVodChatFetch, extractVideoId } from './vodChatFetcher.js';
import { exportVideo as exportVideoImpl } from './exporter.js';
import type { StreamInfo, ClipRegion, ChatMessage } from './types.js';
import * as db from './persistence.js';

const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings'));

// In-memory store of active captures (hot cache; persisted to SQLite on changes)
const captures = new Map<string, CaptureHandle>();

// In-memory store of clip regions (hot cache; persisted to SQLite)
const clipRegionsStore: ClipRegion[] = [];

// In-memory cache of chat message counts per stream (avoids COUNT(*) on every broadcast)
const chatMessageCounts = new Map<string, number>();

// In-memory cache of transcription counts per stream
const transcriptionCounts = new Map<string, number>();

// SSE clients for real-time updates
const sseClients = new Set<(data: string) => void>();

// --- Initialization: restore state from SQLite ---

/**
 * Initialize the stream manager by restoring persisted state from SQLite.
 * Should be called once at server startup.
 */
export async function initStreamManager(): Promise<void> {
	await db.initDatabase();
	fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

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

	// Restore clip regions
	const savedClips = db.loadAllClipRegions();
	for (const region of savedClips) {
		if (captures.has(region.streamId)) {
			clipRegionsStore.push(region);
		}
	}

	// Initialize chat message counts and transcription counts
	for (const [, handle] of captures) {
		chatMessageCounts.set(handle.info.id, db.countChatMessages(handle.info.id));
		transcriptionCounts.set(handle.info.id, db.countTranscriptions(handle.info.id));
	}

	const streamCount = captures.size;
	console.log(`[init] Restored ${streamCount} streams, ${clipRegionsStore.length} clip regions`);
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
	db.saveTranscription(streamId, text, startTime, endTime);
	transcriptionCounts.set(streamId, (transcriptionCounts.get(streamId) ?? 0) + 1);
	broadcast(JSON.stringify({ type: 'transcription', streamId, text, startTime, endTime }));
}

function persistChatMessage(streamId: string, msg: ChatMessage) {
	try {
		db.saveChatMessage(streamId, msg);
		chatMessageCounts.set(streamId, (chatMessageCounts.get(streamId) ?? 0) + 1);
	} catch (err) {
		console.error(`[chat] Failed to save message for stream ${streamId}:`, err);
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
		chatMessageCount: chatMessageCounts.get(info.id) ?? 0,
		transcriptionCount: transcriptionCounts.get(info.id) ?? 0,
		chatComplete: info.chatComplete
	};
}

// --- Duplicate capture guards ---

function findActiveCapture(channel: string, platform: string, sourceType: 'live' | 'vod'): CaptureHandle | undefined {
	for (const [, handle] of captures) {
		if (
			handle.info.channel.toLowerCase() === channel.toLowerCase() &&
			handle.info.platform === platform &&
			handle.info.sourceType === sourceType &&
			handle.info.status !== 'stopped'
		) {
			return handle;
		}
	}
	return undefined;
}

function findCaptureBySourceUrl(url: string): CaptureHandle | undefined {
	for (const [, handle] of captures) {
		if (handle.info.sourceUrl === url) return handle;
	}
	return undefined;
}

// --- Stream management ---

/**
 * Start capturing a Twitch channel.
 * Returns the stream info with an assigned ID.
 * Automatically spawns a VOD capture if the streamer has an ongoing archive.
 */
export async function addStream(channel: string, language?: string | null, platform: 'twitch' | 'douyu' = 'twitch'): Promise<StreamInfo> {
	// Check if we're already capturing this channel (live track only — allow VOD alongside)
	if (findActiveCapture(channel, platform, 'live')) {
		throw new Error(`Already capturing channel: ${channel}`);
	}

	// Resolve transcription language: explicit arg > DB setting > null (auto-detect)
	const transcriptionLanguage = language ?? db.getChannelSettings(channel)?.language ?? null;

	const id = crypto.randomUUID();

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
					persistChatMessage(id, msg);
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
	if (findCaptureBySourceUrl(vodUrl)) {
		throw new Error(`VOD already added: ${vodUrl}`);
	}
	if (findActiveCapture(channel, 'twitch', 'vod')) {
		throw new Error(`Already capturing VOD for channel: ${channel}`);
	}

	const vodId = crypto.randomUUID();

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
						persistChatMessage(vodId, msg);
					}, (success) => {
						if (success) {
							vodHandle.info.chatComplete = true;
							db.saveStream(vodHandle.info);
							broadcastUpdate(vodHandle.info);
						}
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
	if (findCaptureBySourceUrl(canonicalUrl)) {
		throw new Error(`VOD already added: ${canonicalUrl}`);
	}

	if (isDouyu) {
		// Douyu VOD URL — extract room ID, capture via yt-dlp
		const douyuMatch = vodUrl.match(/douyu\.com\/(\d+)/);
		if (!douyuMatch) {
			throw new Error('Invalid Douyu URL — expected douyu.com/<roomId>');
		}
		const roomId = douyuMatch[1];
		const transcriptionLanguage = language ?? db.getChannelSettings(roomId)?.language ?? null;

		const id = crypto.randomUUID();

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

	const id = crypto.randomUUID();
	const fullVodUrl = `https://twitch.tv/videos/${videoId}`;

	const vodHandle = startCapture(channel, id, RECORDINGS_DIR, (info) => {
		broadcastUpdate(info);
		db.saveStream(info);

		if (info.status === 'capturing') {
			// Start VOD chat download (guarded — only once per capture)
			if (!vodHandle.chatStarted) {
				vodHandle.chatStarted = true;
				vodHandle.stopChat = startVodChatFetch(id, videoId, (_sid, msg) => {
					persistChatMessage(id, msg);
				}, (success) => {
					if (success) {
						vodHandle.info.chatComplete = true;
						db.saveStream(vodHandle.info);
						broadcastUpdate(vodHandle.info);
					}
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
 * Parse an HLS playlist and return the total duration in seconds.
 * Returns 0 if the file doesn't exist or has no segments.
 */
function parsePlaylistDuration(playlistPath: string): number {
	if (!fs.existsSync(playlistPath)) return 0;
	const content = fs.readFileSync(playlistPath, 'utf-8');
	const lines = content.split('\n');
	let total = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('#EXTINF:')) {
			const val = parseFloat(trimmed.split(':')[1].replace(',', ''));
			if (!isNaN(val)) total += val;
		}
	}
	return total;
}

/**
 * Resume a stopped Twitch VOD capture from where it left off.
 * Reads the existing playlist duration and restarts streamlink with --hls-start-offset.
 */
export function resumeVodStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	if (handle.info.status !== 'stopped') return false;
	if (handle.info.sourceType !== 'vod') return false;
	if (handle.info.platform !== 'twitch') return false;
	if (!handle.info.sourceUrl) return false;

	const playlistPath = path.join(handle.info.recordingDir, 'playlist.m3u8');
	const playlistDuration = parsePlaylistDuration(playlistPath);
	const hlsStartOffset = Math.max(0, playlistDuration - 5);

	// Preserve original metadata
	const originalStartedAt = handle.info.startedAt;
	const originalStreamTitle = handle.info.streamTitle;
	const originalGameName = handle.info.gameName;
	const originalParentStreamId = handle.info.parentStreamId;
	const sourceUrl = handle.info.sourceUrl;
	const channel = handle.info.channel;

	// Clear old stub handle's interval
	if (handle.segmentWatchInterval) clearInterval(handle.segmentWatchInterval);

	// Resolve language
	const language = db.getChannelSettings(channel)?.language ?? null;

	const newHandle = startCapture(channel, id, RECORDINGS_DIR, (info) => {
		// Preserve original metadata across status changes
		info.startedAt = originalStartedAt;
		info.streamTitle = originalStreamTitle;
		info.gameName = originalGameName;
		info.parentStreamId = originalParentStreamId;

		broadcastUpdate(info);
		db.saveStream(info);

		// Full-file transcription when download completes
		if (info.status === 'stopped' && !newHandle.transcriptionStarted) {
			newHandle.transcriptionStarted = true;
			transcribeFullRecording(id, info.recordingDir, (_streamId, text, startTime, endTime) => {
				broadcastTranscription(id, text, startTime, endTime);
			}, language);
		}
	}, sourceUrl, 'twitch', hlsStartOffset);

	// Don't re-fetch chat
	newHandle.chatStarted = true;

	captures.set(id, newHandle);

	console.log(`[vod:${channel}] Resumed VOD capture with offset ${hlsStartOffset.toFixed(1)}s`);

	return true;
}

/**
 * Refetch VOD chat for a stopped Twitch VOD.
 * Existing messages are skipped via INSERT OR IGNORE in the DB.
 */
export function refetchVodChat(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	if (handle.info.sourceType !== 'vod') return false;
	if (handle.info.platform !== 'twitch') return false;
	if (!handle.info.sourceUrl) return false;

	const videoId = extractVideoId(handle.info.sourceUrl);
	if (!videoId) return false;

	// Stop any existing chat fetch
	handle.stopChat?.();

	handle.info.chatComplete = false;
	db.saveStream(handle.info);
	broadcastUpdate(handle.info);

	handle.stopChat = startVodChatFetch(id, videoId, (_sid, msg) => {
		persistChatMessage(id, msg);
	}, (success) => {
		if (success) {
			handle.info.chatComplete = true;
			db.saveStream(handle.info);
			broadcastUpdate(handle.info);
		}
	});

	console.log(`[vod-chat:${handle.info.channel}] Refetching chat for video ${videoId}`);
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
	db.deleteTranscriptions(id);
	transcriptionCounts.set(id, 0);
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

	// Remove from in-memory caches
	for (let i = clipRegionsStore.length - 1; i >= 0; i--) {
		if (clipRegionsStore[i].streamId === id) {
			clipRegionsStore.splice(i, 1);
		}
	}

	chatMessageCounts.delete(id);
	transcriptionCounts.delete(id);

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

export function getTranscriptionsInRange(id: string, fromTime: number, toTime: number): Array<{ id: number; text: string; startTime: number; endTime: number }> {
	return db.loadTranscriptionsInRange(id, fromTime, toTime);
}

/**
 * Get all stored chat messages for a stream.
 */
/**
 * Get chat messages for a stream within a time range (stream-local seconds).
 */
export function getChatMessagesInRange(id: string, fromTime: number, toTime: number): (ChatMessage & { id: number })[] {
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
