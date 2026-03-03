import { writable, get } from 'svelte/store';
import type { ClipRegion, VideoRecord } from '$lib/types.js';
import {
	getStreams,
	addStreamCmd,
	stopStreamCmd,
	removeStreamCmd,
	retranscribeCmd,
	refetchVodChatCmd,
	resumeVodCmd,
	updateOffsetCmd,
	createClipCmd,
	updateClipCmd,
	deleteClipCmd,
	saveCameraBoundsCmd,
	getCameraBounds as getCameraBoundsQuery,
	deleteCameraBoundsCmd,
	listVideos
} from '$lib/streams.remote';
import type { CameraBoundsEntry } from '$lib/types.js';

export type { ClipRegion, VideoRecord };

export interface StreamState {
	id: string;
	channel: string;
	status: 'starting' | 'capturing' | 'error' | 'stopped';
	startedAt: number;
	error?: string;
	segmentCount: number;
	diskUsageBytes: number;
	viewerCount: number | null;
	streamTitle: string | null;
	gameName: string | null;
	offset: number;
	sourceType: 'vod';
	parentStreamId: string | null;
	platform: 'twitch';
	sourceUrl?: string | null;
	chatMessageCount: number;
	transcriptionCount: number;
	chatComplete: boolean;
	durationSeconds: number | null;
}

export const streams = writable<StreamState[]>([]);
export const focusedStreamId = writable<string | null>(null);
export const soloStreamId = writable<string | null>(null);

// Per-stream sync offsets in seconds (stream local time = master time + offset)
export const syncOffsets = writable<Record<string, number>>({});

// Each StreamTile reports its playback state here
export interface PlaybackState {
	currentTime: number;
	duration: number;
	paused: boolean;
}
export const streamPlaybackStates = writable<Record<string, PlaybackState>>({});

// Current master time in epoch seconds (written by NLETimeline, read by StreamGrid for intersection)
export const masterTime = writable(Date.now() / 1000);

// Whether the master timeline transport is playing (independent of any stream)
export const masterPlaying = writable(false);

// Per-stream timestamped transcription captions
export interface TranscriptionEntry {
	id: number;
	text: string;
	startTime: number; // stream-local seconds
	endTime: number;
}
export const transcriptions = writable<Record<string, TranscriptionEntry[]>>({});

// Clip regions marked by the user (W key hold-to-mark)
export const clipRegions = writable<ClipRegion[]>([]);

// Master playback rate (1 = normal speed)
export const masterPlaybackRate = writable(1);

// Export progress log (fed by SSE)
export interface ExportLogEntry {
	message: string;
	step: number;
	totalSteps: number;
	timestamp: number;
}
export const exportLog = writable<ExportLogEntry[]>([]);

// Export records status updates (fed by SSE export-status events)
export interface ExportStatusEvent {
	exportId: string;
	status: string;
	outputPath?: string;
	error?: string;
}
export const exportStatusEvents = writable<ExportStatusEvent[]>([]);

// YouTube upload status updates (fed by SSE youtube-upload-status events)
export interface YouTubeUploadStatusEvent {
	uploadId: string;
	status: string;
	progress?: number;
	youtubeVideoId?: string;
	error?: string;
}
export const youtubeUploadEvents = writable<YouTubeUploadStatusEvent[]>([]);

// Video compositions
export const videos = writable<VideoRecord[]>([]);

// Master timeline control: streams react to seq changes
export const masterControl = writable<{
	action: 'seek' | 'play' | 'pause' | 'step';
	time: number;
	direction: number;
	seq: number;
}>({ action: 'seek', time: 0, direction: 0, seq: 0 });

// Transcript panel toggle state (visible in clipping mode)
export const transcriptPanelOpen = writable(false);

// Chat panel toggle state (visible in clipping mode)
export const chatPanelOpen = writable(false);

// External seek request: allows components outside NLETimeline to request a playhead seek.
// NLETimeline watches the seq and updates its internal masterCurrentTimeState accordingly.
export const seekRequest = writable<{ time: number; seq: number }>({ time: 0, seq: 0 });

/** Build visible stream metadata for panels (TranscriptPanel, ChatPanel). */
export function deriveVisibleStreams(
	allStreams: StreamState[],
	offsets: Record<string, number>,
	focused: string | null,
	COLORS: readonly string[]
) {
	return allStreams
		.filter((s) => !focused || s.id === focused)
		.map((s, i) => ({
			id: s.id,
			channel: s.channel,
			anchor: s.startedAt / 1000,
			offset: offsets[s.id] || 0,
			color: COLORS[allStreams.indexOf(s) % COLORS.length]
		}));
}

/**
 * Fetch all streams from the API and update the store.
 * Also restores saved offsets from the server.
 */
export async function refreshStreams() {
	try {
		const data = await getStreams();
		streams.set(data.streams);

		// Restore offsets from server (only set offsets we don't already have locally)
		const currentOffsets = get(syncOffsets);
		const restoredOffsets: Record<string, number> = { ...currentOffsets };
		let changed = false;
		for (const s of data.streams) {
			if (s.offset !== 0 && !(s.id in currentOffsets)) {
				restoredOffsets[s.id] = s.offset;
				changed = true;
			}
		}
		if (changed) {
			syncOffsets.set(restoredOffsets);
		}

		// Restore clip regions from server
		if (data.clipRegions) {
			clipRegions.set(data.clipRegions);
		}

		// Load videos
		try {
			const videoList = await listVideos();
			videos.set(videoList);
		} catch {
			// Non-critical — videos may not be available yet
		}
	} catch (err) {
		console.error('Failed to refresh streams:', err);
	}
}

/**
 * Add a new VOD stream by channel name or URL.
 */
export async function addStream(
	channel: string,
	opts?: { language?: string | null; vod?: boolean; vodUrl?: string }
): Promise<void> {
	try {
		await addStreamCmd({
			channel,
			language: opts?.language,
			vod: opts?.vod ?? true,
			vodUrl: opts?.vodUrl
		});
		await refreshStreams();
		return;
	} catch (err) {
		console.error('Failed to add stream:', err);
		throw err;
	}
}

/**
 * Stop a stream's download without removing it.
 */
export async function stopStream(id: string): Promise<void> {
	try {
		await stopStreamCmd({ id });
		await refreshStreams();
	} catch (err) {
		console.error('Failed to stop stream:', err);
	}
}

/**
 * Re-transcribe a stopped stream using full-file transcription.
 */
export async function retranscribeStream(id: string): Promise<void> {
	try {
		await retranscribeCmd({ id });
	} catch (err) {
		console.error('Failed to retranscribe stream:', err);
	}
}

/**
 * Refetch VOD chat for a Twitch VOD.
 */
export async function refetchVodChat(id: string): Promise<void> {
	try {
		await refetchVodChatCmd({ id });
	} catch (err) {
		console.error('Failed to refetch VOD chat:', err);
	}
}

/**
 * Resume a stopped Twitch VOD capture from where it left off.
 */
export async function resumeVodStream(id: string): Promise<void> {
	try {
		await resumeVodCmd({ id });
		await refreshStreams();
	} catch (err) {
		console.error('Failed to resume VOD stream:', err);
	}
}

/**
 * Remove/stop a stream by ID.
 */
export async function removeStream(id: string): Promise<void> {
	try {
		await removeStreamCmd({ id });
		await refreshStreams();
		streamPlaybackStates.update((s) => {
			const { [id]: _, ...rest } = s;
			return rest;
		});
		syncOffsets.update((o) => {
			const { [id]: _, ...rest } = o;
			return rest;
		});
	} catch (err) {
		console.error('Failed to remove stream:', err);
	}
}

// Debounced offset saving to server
const pendingOffsetSaves = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Save a stream's offset to the server (debounced).
 */
export function saveOffset(id: string, offset: number) {
	const existing = pendingOffsetSaves.get(id);
	if (existing) clearTimeout(existing);

	pendingOffsetSaves.set(
		id,
		setTimeout(async () => {
			pendingOffsetSaves.delete(id);
			try {
				await updateOffsetCmd({ id, offset });
			} catch (err) {
				console.error(`Failed to save offset for ${id}:`, err);
			}
		}, 300)
	);
}

/**
 * Create a new clip region on the server. Returns the full ClipRegion with server-generated ID.
 */
export async function createClipRegion(data: Omit<ClipRegion, 'id'>): Promise<ClipRegion> {
	return await createClipCmd(data);
}

/**
 * Update an existing clip region on the server (ID required).
 */
export async function saveClipRegion(region: ClipRegion) {
	try {
		await updateClipCmd(region);
	} catch (err) {
		console.error('Failed to save clip region:', err);
	}
}

/**
 * Delete a clip region from the server.
 */
export async function deleteClipRegion(id: string) {
	try {
		await deleteClipCmd({ id });
	} catch (err) {
		console.error('Failed to delete clip region:', err);
	}
}

/**
 * Save camera bounds for a channel at a specific timestamp.
 */
export async function saveCameraBounds(
	channel: string,
	timestamp: number,
	camX: number,
	camY: number,
	camW: number,
	camH: number
): Promise<CameraBoundsEntry> {
	return await saveCameraBoundsCmd({ channel, timestamp, camX, camY, camW, camH });
}

/**
 * Resolve camera bounds for a channel at a timestamp (most recent entry at or before).
 */
export async function getCameraBounds(channel: string, timestamp: number): Promise<CameraBoundsEntry | null> {
	const result = await getCameraBoundsQuery({ channel, timestamp });
	return result.bounds;
}

/**
 * Delete a camera bounds entry by ID.
 */
export async function removeCameraBounds(id: number): Promise<void> {
	await deleteCameraBoundsCmd({ id });
}

/**
 * Connect to SSE endpoint for real-time updates.
 */
export function connectSSE(): () => void {
	const eventSource = new EventSource('/api/events');

	eventSource.onmessage = (event) => {
		try {
			const data = JSON.parse(event.data);
			if (data.type === 'stream-update') {
				streams.update((current) => {
					const idx = current.findIndex((s) => s.id === data.stream.id);
					if (idx >= 0) {
						current[idx] = data.stream;
						return [...current];
					} else {
						return [...current, data.stream];
					}
				});
			} else if (data.type === 'transcription') {
				streams.update((current) => {
					const idx = current.findIndex((s) => s.id === data.streamId);
					if (idx >= 0) {
						current[idx] = { ...current[idx], transcriptionCount: current[idx].transcriptionCount + 1 };
						return [...current];
					}
					return current;
				});
			} else if (data.type === 'transcription-cleared') {
				transcriptions.update((current) => {
					const { [data.streamId]: _, ...rest } = current;
					return rest;
				});
			} else if (data.type === 'clip-upsert') {
				clipRegions.update((current) => {
					const idx = current.findIndex((c) => c.id === data.clip.id);
					if (idx >= 0) {
						current[idx] = data.clip;
						return [...current];
					}
					return [...current, data.clip];
				});
			} else if (data.type === 'clip-delete') {
				clipRegions.update((current) => current.filter((c) => c.id !== data.id));
			} else if (data.type === 'export-progress') {
				exportLog.update((log) => [
					...log,
					{ message: data.message, step: data.step, totalSteps: data.totalSteps, timestamp: Date.now() }
				]);
			} else if (data.type === 'export-status') {
				exportStatusEvents.update((events) => [
					...events,
					{
						exportId: data.exportId,
						status: data.status,
						outputPath: data.outputPath,
						error: data.error
					}
				]);
			} else if (data.type === 'youtube-upload-status') {
				youtubeUploadEvents.update((events) => [
					...events,
					{
						uploadId: data.uploadId,
						status: data.status,
						progress: data.progress,
						youtubeVideoId: data.youtubeVideoId,
						error: data.error
					}
				]);
			} else if (data.type === 'video-create') {
				videos.update((current) => [...current, data.video]);
			} else if (data.type === 'video-update') {
				videos.update((current) => {
					const idx = current.findIndex((v) => v.id === data.video.id);
					if (idx >= 0) {
						current[idx] = data.video;
						return [...current];
					}
					return [...current, data.video];
				});
			} else if (data.type === 'video-delete') {
				videos.update((current) => current.filter((v) => v.id !== data.id));
			}
		} catch {
			// Ignore parse errors (keepalive pings etc)
		}
	};

	eventSource.onerror = () => {
		console.warn('SSE connection error, will reconnect...');
	};

	return () => eventSource.close();
}
