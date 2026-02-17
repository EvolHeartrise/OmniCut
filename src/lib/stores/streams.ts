import { writable } from 'svelte/store';

export interface StreamState {
	id: string;
	channel: string;
	status: 'starting' | 'capturing' | 'error' | 'stopped';
	startedAt: number;
	error?: string;
	segmentCount: number;
}

export const streams = writable<StreamState[]>([]);
export const focusedStreamId = writable<string | null>(null);

/**
 * Fetch all streams from the API and update the store.
 */
export async function refreshStreams() {
	try {
		const res = await fetch('/api/streams');
		const data = await res.json();
		streams.set(data.streams);
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
 * Remove/stop a stream by ID.
 */
export async function removeStream(id: string): Promise<void> {
	try {
		await fetch(`/api/streams/${id}`, { method: 'DELETE' });
		await refreshStreams();
	} catch (err) {
		console.error('Failed to remove stream:', err);
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
