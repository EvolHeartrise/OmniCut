import * as path from 'node:path';
import * as fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { startCapture, type CaptureHandle } from './captureProcess.js';
import type { StreamInfo } from './types.js';

const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

// In-memory store of active captures
const captures = new Map<string, CaptureHandle>();

// SSE clients for real-time updates
const sseClients = new Set<(data: string) => void>();

export function getRecordingsDir(): string {
	return RECORDINGS_DIR;
}

function broadcastUpdate(info: StreamInfo) {
	const data = JSON.stringify({ type: 'stream-update', stream: serializeStreamInfo(info) });
	for (const send of sseClients) {
		try {
			send(data);
		} catch {
			sseClients.delete(send);
		}
	}
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
		segmentCount: info.segmentCount
	};
}

/**
 * Start capturing a Twitch channel.
 * Returns the stream info with an assigned ID.
 */
export function addStream(channel: string): StreamInfo {
	// Check if we're already capturing this channel
	for (const [, handle] of captures) {
		if (handle.info.channel.toLowerCase() === channel.toLowerCase() && handle.info.status !== 'stopped') {
			throw new Error(`Already capturing channel: ${channel}`);
		}
	}

	const id = uuidv4();

	// Ensure recordings directory exists
	fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	const handle = startCapture(channel, id, RECORDINGS_DIR, (info) => {
		broadcastUpdate(info);
	});

	captures.set(id, handle);
	return handle.info;
}

/**
 * Stop capturing a stream by ID.
 */
export function removeStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;

	handle.kill();
	captures.delete(id);
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
 * Get the recording directory path for a stream.
 */
export function getStreamRecordingDir(id: string): string | null {
	const handle = captures.get(id);
	if (!handle) return null;
	return handle.info.recordingDir;
}

/**
 * Clean up all captures on shutdown.
 */
export function shutdownAll() {
	for (const [id, handle] of captures) {
		handle.kill();
		captures.delete(id);
	}
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
