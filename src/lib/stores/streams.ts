import { writable, get } from 'svelte/store';
import type { ClipRegion } from '$lib/types.js';

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

// Per-stream chat messages
export interface ChatMessageEntry {
	username: string;
	text: string;
	timestamp: number; // stream-local seconds
}
export const chatMessages = writable<Record<string, ChatMessageEntry[]>>({});

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

// External seek request: allows components outside NLETimeline to request a playhead seek.
// NLETimeline watches the seq and updates its internal masterCurrentTimeState accordingly.
export const seekRequest = writable<{ time: number; seq: number }>({ time: 0, seq: 0 });

/**
 * Fetch all streams from the API and update the store.
 * Also restores saved offsets from the server.
 */
export async function refreshStreams() {
	try {
		const res = await fetch('/api/streams');
		const data = await res.json();
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

		// Restore transcriptions from server
		if (data.transcriptions) {
			transcriptions.update((current) => {
				const merged = { ...current };
				for (const [streamId, entries] of Object.entries(data.transcriptions as Record<string, TranscriptionEntry[]>)) {
					// Server has the full history; replace if client has fewer entries
					const existing = merged[streamId] || [];
					if (entries.length > existing.length) {
						merged[streamId] = entries;
					}
				}
				return merged;
			});
		}

		// Restore chat messages from server
		if (data.chatMessages) {
			chatMessages.update((current) => {
				const merged = { ...current };
				for (const [streamId, msgs] of Object.entries(data.chatMessages as Record<string, ChatMessageEntry[]>)) {
					const existing = merged[streamId] || [];
					if (msgs.length > existing.length) {
						merged[streamId] = msgs;
					}
				}
				return merged;
			});
		}
	} catch (err) {
		console.error('Failed to refresh streams:', err);
	}
}

/**
 * Add a new stream by channel name.
 */
export async function addStream(channel: string): Promise<StreamState | null> {
	try {
		const res = await fetch('/api/streams', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ channel })
		});
		const data = await res.json();
		if (!res.ok) {
			throw new Error(data.error || 'Failed to add stream');
		}
		await refreshStreams();
		return data.stream;
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
		await fetch(`/api/streams/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ stop: true })
		});
		await refreshStreams();
	} catch (err) {
		console.error('Failed to stop stream:', err);
	}
}

/**
 * Remove/stop a stream by ID.
 */
export async function removeStream(id: string): Promise<void> {
	try {
		await fetch(`/api/streams/${id}`, { method: 'DELETE' });
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
				await fetch(`/api/streams/${id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ offset })
				});
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
		await fetch(`/api/streams/${region.streamId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ addClipRegion: region })
		});
	} catch (err) {
		console.error('Failed to save clip region:', err);
	}
}

/**
 * Delete a clip region from the server.
 */
export async function deleteClipRegion(id: string, streamId: string) {
	try {
		await fetch(`/api/streams/${streamId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ removeClipRegionId: id })
		});
	} catch (err) {
		console.error('Failed to delete clip region:', err);
	}
}

/**
 * Clear the entire session (all streams, transcriptions, chat, clips).
 * Calls the backend to wipe SQLite and resets all frontend stores.
 */
export async function clearSession() {
	await fetch('/api/session', { method: 'DELETE' });
	streams.set([]);
	clipRegions.set([]);
	transcriptions.set({});
	chatMessages.set({});
	syncOffsets.set({});
	streamPlaybackStates.set({});
	focusedStreamId.set(null);
	soloStreamId.set(null);
	exportLog.set([]);
	appMode.set('sources');
}

/**
 * Export the current session as a JSON file download.
 */
export async function exportSessionFile() {
	const res = await fetch('/api/session');
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `omnicut-session-${Date.now()}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Import a session from a JSON file. Refreshes streams after import.
 */
export async function importSessionFile(file: File): Promise<{ imported: number; total: number; errors: string[] }> {
	const text = await file.text();
	const res = await fetch('/api/session', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: text
	});
	const result = await res.json();
	if (!res.ok && !result.imported) {
		throw new Error(result.error || 'Import failed');
	}
	await refreshStreams();
	return result;
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
				transcriptions.update((current) => {
					const entries = current[data.streamId] || [];
					return {
						...current,
						[data.streamId]: [
							...entries,
							{ text: data.text, startTime: data.startTime, endTime: data.endTime }
						]
					};
				});
			} else if (data.type === 'chat-message') {
				chatMessages.update((current) => {
					const entries = current[data.streamId] || [];
					return {
						...current,
						[data.streamId]: [
							...entries,
							{ username: data.username, text: data.text, timestamp: data.timestamp }
						]
					};
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
