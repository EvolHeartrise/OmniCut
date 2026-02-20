import { writable, get } from 'svelte/store';
import type { ClipRegion } from '$lib/types.js';
import {
	getStreams,
	addStreamCmd,
	stopStreamCmd,
	removeStreamCmd,
	retranscribeCmd,
	refetchVodChatCmd,
	resumeVodCmd,
	updateOffsetCmd,
	saveClipCmd,
	deleteClipCmd
} from '$lib/streams.remote';

export type { ClipRegion };

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
	sourceType: 'live' | 'vod';
	parentStreamId: string | null;
	platform: 'twitch' | 'douyu';
	sourceUrl?: string | null;
	chatMessageCount: number;
	chatComplete: boolean;
}

export type AppMode = 'sources' | 'clipping' | 'cleaning' | 'export';
export const appMode = writable<AppMode>('sources');

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
export function deriveVisibleStreams(allStreams: StreamState[], offsets: Record<string, number>, focused: string | null, COLORS: readonly string[]) {
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

	} catch (err) {
		console.error('Failed to refresh streams:', err);
	}
}

/**
 * Add a new stream by channel name.
 */
export async function addStream(channel: string, opts?: { language?: string | null; vod?: boolean; vodUrl?: string; platform?: 'twitch' | 'douyu' }): Promise<void> {
	try {
		await addStreamCmd({
			channel,
			language: opts?.language,
			vod: opts?.vod,
			vodUrl: opts?.vodUrl,
			platform: opts?.platform
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
 * Save a new clip region to the server.
 */
export async function saveClipRegion(region: ClipRegion) {
	try {
		await saveClipCmd(region);
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
			} else if (data.type === 'transcription-cleared') {
				transcriptions.update((current) => {
					const { [data.streamId]: _, ...rest } = current;
					return rest;
				});
			} else if (data.type === 'export-progress') {
				exportLog.update((log) => [
					...log,
					{ message: data.message, step: data.step, totalSteps: data.totalSteps, timestamp: Date.now() }
				]);
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
