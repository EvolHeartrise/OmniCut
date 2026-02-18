import * as path from 'node:path';
import * as fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { startCapture, fetchStreamMeta, type CaptureHandle } from './captureProcess.js';
import { startTranscription, stopTranscription, shutdownTranscriber } from './transcriber.js';
import { startChatCollection } from './chatCollector.js';
import { exportVideo as exportVideoImpl } from './exporter.js';
import type { StreamInfo, ClipRegion, SessionExport, ChatMessage } from './types.js';
import * as db from './persistence.js';

const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

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

function broadcastChatMessage(streamId: string, msg: ChatMessage) {
	// Persist in memory
	let messages = streamChatMessages.get(streamId);
	if (!messages) {
		messages = [];
		streamChatMessages.set(streamId, messages);
	}
	messages.push(msg);

	// Persist to SQLite
	db.saveChatMessage(streamId, msg);

	broadcast(
		JSON.stringify({
			type: 'chat-message',
			streamId,
			username: msg.username,
			text: msg.text,
			timestamp: msg.timestamp
		})
	);
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
		offset: info.offset,
		sourceType: info.sourceType,
		parentStreamId: info.parentStreamId
	};
}

// --- Stream management ---

/**
 * Start capturing a Twitch channel.
 * Returns the stream info with an assigned ID.
 * Automatically spawns a VOD capture if the streamer has an ongoing archive.
 */
export async function addStream(channel: string): Promise<StreamInfo> {
	// Check if we're already capturing this channel (live track only — allow VOD alongside)
	for (const [, handle] of captures) {
		if (
			handle.info.channel.toLowerCase() === channel.toLowerCase() &&
			handle.info.sourceType === 'live' &&
			handle.info.status !== 'stopped'
		) {
			throw new Error(`Already capturing channel: ${channel}`);
		}
	}

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
			});

			// Start chat collection for live streams (guarded — only once per capture)
			if (info.sourceType === 'live' && !handle.chatStarted) {
				handle.chatStarted = true;
				handle.stopChat = startChatCollection(id, channel, info.startedAt, (_streamId, msg) => {
					broadcastChatMessage(id, msg);
				});
			}
		}
	});

	captures.set(id, handle);

	// Persist initial stream state
	db.saveStream(handle.info);

	// Auto-spawn VOD capture if available
	try {
		const meta = await fetchStreamMeta(channel);
		if (meta.vodId && meta.createdAt) {
			const vodId = uuidv4();
			const vodUrl = `https://twitch.tv/videos/${meta.vodId}`;

			const vodHandle = startCapture(channel, vodId, RECORDINGS_DIR, (info) => {
				broadcastUpdate(info);
				db.saveStream(info);
			}, vodUrl);

			vodHandle.info.startedAt = Date.parse(meta.createdAt);
			vodHandle.info.parentStreamId = id;
			captures.set(vodId, vodHandle);

			// Persist VOD stream
			db.saveStream(vodHandle.info);

			console.log(`[vod:${channel}] Auto-spawned VOD capture (video ${meta.vodId}), startedAt=${meta.createdAt}`);
		}
	} catch (err) {
		console.error(`[vod:${channel}] Failed to check/spawn VOD capture:`, err);
	}

	return handle.info;
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
 * Remove a stream entirely by ID.
 */
export function removeStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;

	stopTranscription(id);
	handle.stopChat?.();
	handle.kill();
	captures.delete(id);

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
 * Get the recording directory path for a stream.
 */
export function getStreamRecordingDir(id: string): string | null {
	const handle = captures.get(id);
	if (!handle) return null;
	return handle.info.recordingDir;
}

// --- Session import/export ---

/**
 * Export all session state to a portable JSON structure.
 */
export function exportSession(): SessionExport {
	const streams: SessionExport['streams'] = [];
	for (const [, handle] of captures) {
		const info = handle.info;
		streams.push({
			id: info.id,
			channel: info.channel,
			startedAt: info.startedAt,
			viewerCount: info.viewerCount,
			streamTitle: info.streamTitle,
			recordingDir: path.relative(RECORDINGS_DIR, info.recordingDir),
			offset: info.offset,
			sourceType: info.sourceType,
			parentStreamId: info.parentStreamId
		});
	}

	const transcriptions: SessionExport['transcriptions'] = {};
	for (const [id, entries] of streamTranscriptions) {
		transcriptions[id] = entries;
	}

	const chatMessages: SessionExport['chatMessages'] = {};
	for (const [id, messages] of streamChatMessages) {
		if (messages.length > 0) {
			chatMessages[id] = messages;
		}
	}

	return {
		version: 1,
		exportedAt: Date.now(),
		streams,
		transcriptions,
		clipRegions: [...clipRegionsStore],
		chatMessages
	};
}

/**
 * Import session state from a previously exported JSON structure.
 * Clears existing state and replaces with imported data.
 */
export function importSession(data: SessionExport): { imported: number; errors: string[] } {
	if (data.version !== 1) {
		return { imported: 0, errors: [`Unsupported export version: ${data.version}`] };
	}

	// Clear existing state
	for (const [id, handle] of captures) {
		stopTranscription(id);
		handle.stopChat?.();
		handle.kill();
	}
	captures.clear();
	streamTranscriptions.clear();
	streamChatMessages.clear();
	clipRegionsStore.length = 0;

	// Clear SQLite
	db.clearAll();

	const errors: string[] = [];
	let imported = 0;

	for (const stream of data.streams) {
		const recordingDir = path.join(RECORDINGS_DIR, stream.recordingDir);

		// Verify recording directory exists
		if (!fs.existsSync(recordingDir)) {
			errors.push(`Recording directory missing for ${stream.channel} (${stream.recordingDir})`);
			continue;
		}

		// Verify playlist exists
		const playlistPath = path.join(recordingDir, 'playlist.m3u8');
		if (!fs.existsSync(playlistPath)) {
			errors.push(`playlist.m3u8 missing for ${stream.channel} (${stream.recordingDir})`);
			continue;
		}

		// Recount segments and disk usage from disk
		let segmentCount = 0;
		let diskUsageBytes = 0;
		try {
			const files = fs.readdirSync(recordingDir);
			for (const file of files) {
				if (file.endsWith('.ts')) {
					segmentCount++;
				}
				const stat = fs.statSync(path.join(recordingDir, file));
				diskUsageBytes += stat.size;
			}
		} catch {
			// Non-fatal: just use zeros
		}

		const info: StreamInfo = {
			id: stream.id,
			channel: stream.channel,
			status: 'stopped',
			startedAt: stream.startedAt,
			segmentCount,
			diskUsageBytes,
			viewerCount: stream.viewerCount,
			streamTitle: stream.streamTitle,
			recordingDir,
			offset: stream.offset,
			sourceType: stream.sourceType,
			parentStreamId: stream.parentStreamId
		};

		// Create stub CaptureHandle (no process, just data)
		const stubHandle: CaptureHandle = {
			info,
			kill: () => {},
			segmentWatchInterval: null
		};

		captures.set(stream.id, stubHandle);

		// Persist to SQLite
		db.saveStream(info);

		imported++;
	}

	// Restore transcriptions (only for successfully imported streams)
	if (data.transcriptions) {
		for (const [streamId, entries] of Object.entries(data.transcriptions)) {
			if (captures.has(streamId)) {
				streamTranscriptions.set(streamId, [...entries]);
				db.bulkImportTranscriptions(streamId, entries);
			}
		}
	}

	// Restore clip regions (only for successfully imported streams)
	if (data.clipRegions) {
		const validRegions: ClipRegion[] = [];
		for (const region of data.clipRegions) {
			if (captures.has(region.streamId)) {
				clipRegionsStore.push({ ...region });
				validRegions.push(region);
			}
		}
		if (validRegions.length > 0) {
			db.bulkImportClipRegions(validRegions);
		}
	}

	// Restore chat messages (only for successfully imported streams)
	if (data.chatMessages) {
		for (const [streamId, messages] of Object.entries(data.chatMessages)) {
			if (captures.has(streamId)) {
				streamChatMessages.set(streamId, [...messages]);
				db.bulkImportChatMessages(streamId, messages);
			}
		}
	}

	return { imported, errors };
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
