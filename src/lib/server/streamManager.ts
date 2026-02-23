import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { startCapture, fetchStreamMeta, fetchVodMeta, type CaptureHandle } from './captureProcess.js';
import { startTranscription, stopTranscription, transcribeFullRecording, shutdownTranscriber } from './transcriber.js';
import { startChatCollection } from './chatCollector.js';
import { startVodChatFetch, extractVideoId, extractDouyuRoomId } from './vodChatFetcher.js';
import { detectNvenc } from './exporter.js';
import type { StreamInfo, ChatMessage } from './types.js';
import * as db from './persistence.js';
import {
	addSSEClient as sseAddClient,
	broadcastUpdate,
	broadcastTranscription,
	persistChatMessage,
	persistChatMessagesBatch,
	broadcastTranscriptionCleared,
	serializeStreamInfo,
	initCounts,
	deleteCounts,
	resetTranscriptionCount,
	broadcast
} from './sseBroadcaster.js';
import {
	restoreClipRegions,
	addClipRegion,
	removeClipRegion,
	getAllClipRegions,
	getClipRegion,
	getClipRegionCount
} from './clipManager.js';
import {
	setLookups,
	restoreEncodeState,
	shutdownEncoder,
	getClipEncodeStatus as clipEncodeStatusLookup
} from './clipEncoder.js';
import type { ClipEncodeStatus } from './clipEncoder.js';
import {
	createAndQueueExport,
	restoreExportQueue,
	shutdownExportQueue,
	loadExport,
	loadAllExports
} from './exportQueue.js';

const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings'));

// ---------------------------------------------------------------------------
// Shared callback builder for capture status changes.
// All addStream/addVodStream/addVodByUrl routes share this pattern:
//   broadcastUpdate → saveStream → (on capturing) start transcription/chat → (on stopped) full transcription
// ---------------------------------------------------------------------------

interface CaptureCallbackOpts {
	/** The handle returned by startCapture (assigned after creation). */
	getHandle: () => CaptureHandle;
	id: string;
	language: string | null;
	/** Live chat: provide channel + platform to start IRC collection. */
	liveChat?: { channel: string; platform: 'twitch' | 'douyu' };
	/** VOD chat: provide videoId to start VOD chat download. */
	vodChat?: { videoId: string };
	/** If true, run full-file transcription when status transitions to 'stopped'. */
	fullTranscribeOnStop?: boolean;
	/** If true, start streaming transcription when status transitions to 'capturing'. */
	streamTranscribeOnCapturing?: boolean;
}

function createStatusCallback(opts: CaptureCallbackOpts): (info: StreamInfo) => void {
	return (info: StreamInfo) => {
		broadcastUpdate(info);
		db.saveStream(info);

		const handle = opts.getHandle();

		// Start streaming transcription on capturing (for live streams & addVodStream)
		if (info.status === 'capturing' && opts.streamTranscribeOnCapturing && !handle.transcriptionStarted) {
			handle.transcriptionStarted = true;
			startTranscription(
				opts.id,
				info.recordingDir,
				(_sid, text, startTime, endTime, words) => {
					broadcastTranscription(opts.id, text, startTime, endTime, words);
				},
				opts.language
			);
		}

		// Start live chat collection (Twitch IRC) — guarded, only once per capture
		if (info.status === 'capturing' && opts.liveChat && !handle.chatStarted) {
			handle.chatStarted = true;
			if (opts.liveChat.platform === 'twitch') {
				handle.stopChat = startChatCollection(opts.id, opts.liveChat.channel, info.startedAt, (_sid, msg) => {
					persistChatMessage(opts.id, msg);
				});
			}
		}

		// Start VOD chat download — guarded, only once per capture
		if (info.status === 'capturing' && opts.vodChat && !handle.chatStarted) {
			handle.chatStarted = true;
			handle.stopChat = startVodChatFetch(
				opts.id,
				opts.vodChat.videoId,
				(_sid, msg) => {
					persistChatMessage(opts.id, msg);
				},
				(success) => {
					if (success) {
						handle.info.chatComplete = true;
						db.saveStream(handle.info);
						broadcastUpdate(handle.info);
					}
				},
				(_sid, msgs) => {
					persistChatMessagesBatch(opts.id, msgs);
				}
			);
		}

		// Full-file transcription when VOD download completes
		if (info.status === 'stopped' && opts.fullTranscribeOnStop && !handle.transcriptionStarted) {
			handle.transcriptionStarted = true;
			transcribeFullRecording(
				opts.id,
				info.recordingDir,
				(_sid, text, startTime, endTime, words) => {
					broadcastTranscription(opts.id, text, startTime, endTime, words);
				},
				opts.language
			).catch((err) => {
				console.error(`[transcribe:${info.channel}] Full transcription failed:`, err);
			});
		}
	};
}

// In-memory store of active captures (hot cache; persisted to SQLite on changes)
const captures = new Map<string, CaptureHandle>();

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

		// Backfill VOD duration from HLS playlist if not stored yet
		if (info.sourceType === 'vod' && info.durationSeconds == null) {
			const playlistPath = path.join(info.recordingDir, 'playlist.m3u8');
			const dur = parsePlaylistDuration(playlistPath);
			if (dur > 0) {
				info.durationSeconds = dur;
				db.saveStream(info);
			}
		}

		const stubHandle: CaptureHandle = {
			info,
			kill: () => {},
			segmentWatchInterval: null
		};
		captures.set(info.id, stubHandle);
	}

	// Restore clip regions (all clips, including orphans from deleted streams)
	restoreClipRegions();

	// Initialize chat message counts and transcription counts
	for (const [, handle] of captures) {
		initCounts(handle.info.id);
	}

	// Wire up clip encoder lookups (avoids circular imports)
	setLookups(
		(clipId) => getClipRegion(clipId),
		(streamId) => {
			const handle = captures.get(streamId);
			return handle ? handle.info : null;
		},
		detectNvenc
	);

	// Restore pre-encoded clip state from disk
	const allClipIds = getAllClipRegions().map((c) => c.id);
	restoreEncodeState(allClipIds);

	// Mark any incomplete exports from a previous session as error
	restoreExportQueue();

	const streamCount = captures.size;
	console.log(`[init] Restored ${streamCount} streams, ${getClipRegionCount()} clip regions`);
}

// Re-export SSE client management
export const addSSEClient = sseAddClient;

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
export async function addStream(
	channel: string,
	language?: string | null,
	platform: 'twitch' | 'douyu' = 'twitch'
): Promise<StreamInfo> {
	if (findActiveCapture(channel, platform, 'live')) {
		throw new Error(`Already capturing channel: ${channel}`);
	}

	const transcriptionLanguage = language ?? db.getChannelSettings(channel)?.language ?? null;
	const id = crypto.randomUUID();

	let handle!: CaptureHandle;
	const onStatus = createStatusCallback({
		getHandle: () => handle,
		id,
		language: transcriptionLanguage,
		streamTranscribeOnCapturing: true,
		liveChat: { channel, platform }
	});

	handle = startCapture(channel, id, RECORDINGS_DIR, onStatus, undefined, platform);
	captures.set(id, handle);
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

	if (findCaptureBySourceUrl(vodUrl)) {
		throw new Error(`VOD already added: ${vodUrl}`);
	}
	if (findActiveCapture(channel, 'twitch', 'vod')) {
		throw new Error(`Already capturing VOD for channel: ${channel}`);
	}

	const vodId = crypto.randomUUID();
	const twitchVideoId = extractVideoId(vodUrl);

	let vodHandle!: CaptureHandle;
	const onStatus = createStatusCallback({
		getHandle: () => vodHandle,
		id: vodId,
		language: transcriptionLanguage,
		streamTranscribeOnCapturing: true,
		vodChat: twitchVideoId ? { videoId: twitchVideoId } : undefined
	});

	vodHandle = startCapture(channel, vodId, RECORDINGS_DIR, onStatus, vodUrl);
	vodHandle.info.startedAt = Date.parse(meta.createdAt);

	// Link to the live capture if one exists
	for (const [id, handle] of captures) {
		if (handle.info.channel.toLowerCase() === channel.toLowerCase() && handle.info.sourceType === 'live') {
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
	// Detect platform and extract IDs using shared extractors
	const douyuRoomId = extractDouyuRoomId(vodUrl);
	const twitchVideoId = extractVideoId(vodUrl);
	const isDouyu = !!douyuRoomId;

	// Normalize the source URL for dedup: extract canonical form
	const canonicalUrl = isDouyu
		? `https://douyu.com/${douyuRoomId}`
		: twitchVideoId
			? `https://twitch.tv/videos/${twitchVideoId}`
			: vodUrl.trim();

	// Check for duplicate VOD by source URL
	if (findCaptureBySourceUrl(canonicalUrl)) {
		throw new Error(`VOD already added: ${canonicalUrl}`);
	}

	if (isDouyu) {
		const roomId = douyuRoomId!;
		const transcriptionLanguage = language ?? db.getChannelSettings(roomId)?.language ?? null;
		const id = crypto.randomUUID();

		let vodHandle!: CaptureHandle;
		const onStatus = createStatusCallback({
			getHandle: () => vodHandle,
			id,
			language: transcriptionLanguage,
			fullTranscribeOnStop: true
		});

		vodHandle = startCapture(roomId, id, RECORDINGS_DIR, onStatus, vodUrl, 'douyu');
		captures.set(id, vodHandle);
		db.saveStream(vodHandle.info);

		console.log(`[vod:douyu:${roomId}] Started Douyu VOD capture`);
		return vodHandle.info;
	}

	// Twitch VOD
	if (!twitchVideoId) {
		throw new Error('Invalid VOD URL — expected twitch.tv/videos/<id>');
	}
	const videoId = twitchVideoId;

	const meta = await fetchVodMeta(videoId);
	if (!meta.channel) {
		throw new Error(`VOD not found: ${videoId}`);
	}

	const channel = meta.channel;
	const transcriptionLanguage = language ?? db.getChannelSettings(channel)?.language ?? null;
	const id = crypto.randomUUID();
	const fullVodUrl = `https://twitch.tv/videos/${videoId}`;

	let vodHandle!: CaptureHandle;
	const onStatus = createStatusCallback({
		getHandle: () => vodHandle,
		id,
		language: transcriptionLanguage,
		vodChat: { videoId },
		fullTranscribeOnStop: true
	});

	vodHandle = startCapture(channel, id, RECORDINGS_DIR, onStatus, fullVodUrl, 'twitch');

	if (meta.createdAt) {
		vodHandle.info.startedAt = Date.parse(meta.createdAt);
	}
	vodHandle.info.streamTitle = meta.title;
	vodHandle.info.durationSeconds = meta.durationSeconds;

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

	let newHandle!: CaptureHandle;
	const baseCallback = createStatusCallback({
		getHandle: () => newHandle,
		id,
		language,
		fullTranscribeOnStop: true
	});

	newHandle = startCapture(
		channel,
		id,
		RECORDINGS_DIR,
		(info) => {
			// Preserve original metadata across status changes
			info.startedAt = originalStartedAt;
			info.streamTitle = originalStreamTitle;
			info.gameName = originalGameName;
			info.parentStreamId = originalParentStreamId;
			baseCallback(info);
		},
		sourceUrl,
		'twitch',
		hlsStartOffset
	);

	// Don't re-fetch chat on resume
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

	handle.stopChat = startVodChatFetch(
		id,
		videoId,
		(_sid, msg) => {
			persistChatMessage(id, msg);
		},
		(success) => {
			if (success) {
				handle.info.chatComplete = true;
				db.saveStream(handle.info);
				broadcastUpdate(handle.info);
			}
		},
		(_sid, msgs) => {
			persistChatMessagesBatch(id, msgs);
		}
	);

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
	resetTranscriptionCount(id);
	broadcastTranscriptionCleared(id);

	// Resolve language
	const language = db.getChannelSettings(handle.info.channel)?.language ?? null;

	// Full transcription with error logging
	transcribeFullRecording(
		id,
		handle.info.recordingDir,
		(_streamId, text, startTime, endTime, words) => {
			broadcastTranscription(id, text, startTime, endTime, words);
		},
		language
	).catch((err) => {
		console.error(`[retranscribe:${handle.info.channel}] Full transcription failed:`, err);
	});

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

	// Remove from in-memory caches (but keep clip regions — they survive stream deletion)
	deleteCounts(id);

	// Remove from SQLite (cascades to transcriptions and chat, but NOT clip regions)
	db.deleteStream(id);

	// Delete recording files from disk (async with error logging)
	const recordingDir = handle.info.recordingDir;
	if (recordingDir && fs.existsSync(recordingDir)) {
		fs.promises.rm(recordingDir, { recursive: true, force: true }).catch((err) => {
			console.error(`[removeStream] Failed to delete recording dir ${recordingDir}:`, err);
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

// --- Clip regions (delegated to clipManager.ts) ---
export { addClipRegion, createClipRegion, removeClipRegion, getAllClipRegions } from './clipManager.js';

// --- Clip encoding status (delegated to clipEncoder.ts) ---
export { getClipEncodeStatus, getEncodedClipPath } from './clipEncoder.js';
export type { ClipEncodeStatus } from './clipEncoder.js';

/**
 * Get encode statuses for multiple clip IDs at once.
 */
export function getClipEncodeStatuses(clipIds: string[]): Record<string, ClipEncodeStatus> {
	const result: Record<string, ClipEncodeStatus> = {};
	for (const id of clipIds) {
		const status = clipEncodeStatusLookup(id);
		if (status) result[id] = status;
	}
	return result;
}

export function getTranscriptionsInRange(
	id: string,
	fromTime: number,
	toTime: number,
	query?: string
): Array<{ id: number; text: string; startTime: number; endTime: number }> {
	return db.loadTranscriptionsInRange(id, fromTime, toTime, query);
}

/**
 * Get chat messages for a stream within a time range (stream-local seconds).
 */
export function getChatMessagesInRange(
	id: string,
	fromTime: number,
	toTime: number,
	query?: string,
	limit?: number
): (ChatMessage & { id: number })[] {
	return db.loadChatMessagesInRange(id, fromTime, toTime, query, limit);
}

/**
 * Get pre-bucketed chat heatmap data for a stream.
 */
export function getChatHeatmap(
	id: string,
	bucketSeconds: number
): { buckets: Array<{ time: number; count: number }>; max: number } {
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
 * Export all clip regions as a single stitched video file (UI path).
 * Sorts clips by startTime and goes through the export queue for consistency.
 */
export { createAndQueueExport, loadExport, loadAllExports } from './exportQueue.js';

// --- Shutdown ---

/**
 * Clean up all captures on shutdown.
 */
export function shutdownAll() {
	shutdownExportQueue();
	shutdownEncoder();
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
