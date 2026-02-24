/**
 * SSE (Server-Sent Events) broadcaster module.
 * Manages connected SSE clients and provides typed broadcast helpers.
 */

import type { StreamInfo, ChatMessage } from './types.js';
import type { WordTimestamp } from './transcriber.js';
import * as db from './persistence.js';

// SSE clients for real-time updates
const sseClients = new Set<(data: string) => void>();

// In-memory cache of chat message counts per stream (avoids COUNT(*) on every broadcast)
const chatMessageCounts = new Map<string, number>();

// In-memory cache of transcription counts per stream
const transcriptionCounts = new Map<string, number>();

// --- Client management ---

export function addSSEClient(send: (data: string) => void): () => void {
	sseClients.add(send);
	return () => sseClients.delete(send);
}

export function broadcast(data: string) {
	for (const send of sseClients) {
		try {
			send(data);
		} catch {
			sseClients.delete(send);
		}
	}
}

// --- Count management ---

function incrementCount(map: Map<string, number>, key: string, delta = 1): void {
	map.set(key, (map.get(key) ?? 0) + delta);
}

export function initCounts(streamId: string): void {
	chatMessageCounts.set(streamId, db.countChatMessages(streamId));
	transcriptionCounts.set(streamId, db.countTranscriptions(streamId));
}

export function deleteCounts(streamId: string): void {
	chatMessageCounts.delete(streamId);
	transcriptionCounts.delete(streamId);
	lastBroadcast.delete(streamId);
}

export function resetTranscriptionCount(streamId: string): void {
	transcriptionCounts.set(streamId, 0);
}

// --- Typed broadcast helpers ---

export function serializeStreamInfo(info: StreamInfo) {
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
		chatComplete: info.chatComplete,
		durationSeconds: info.durationSeconds
	};
}

// Cache last broadcast payload per stream to skip no-op SSE pushes
const lastBroadcast = new Map<string, string>();

export function broadcastUpdate(info: StreamInfo) {
	const payload = JSON.stringify({ type: 'stream-update', stream: serializeStreamInfo(info) });
	if (lastBroadcast.get(info.id) === payload) return;
	lastBroadcast.set(info.id, payload);
	broadcast(payload);
}

export function broadcastTranscription(
	streamId: string,
	text: string,
	startTime: number,
	endTime: number,
	words?: WordTimestamp[]
) {
	db.saveTranscription(streamId, text, startTime, endTime, words);
	incrementCount(transcriptionCounts, streamId);
	broadcast(JSON.stringify({ type: 'transcription', streamId, text, startTime, endTime }));
}

export function persistChatMessage(streamId: string, msg: ChatMessage) {
	try {
		db.saveChatMessage(streamId, msg);
		incrementCount(chatMessageCounts, streamId);
	} catch (err) {
		console.error(`[chat] Failed to save message for stream ${streamId}:`, err);
	}
}

export function persistChatMessagesBatch(streamId: string, messages: ChatMessage[]) {
	if (messages.length === 0) return;
	try {
		db.saveChatMessagesBatch(streamId, messages);
		incrementCount(chatMessageCounts, streamId, messages.length);
	} catch (err) {
		console.error(`[chat] Failed to save ${messages.length} messages for stream ${streamId}:`, err);
	}
}

export function broadcastTranscriptionCleared(streamId: string) {
	broadcast(JSON.stringify({ type: 'transcription-cleared', streamId }));
}

export function broadcastClipRegionsChanged(
	clipRegions: Array<{
		id: string;
		streamId: string;
		startTime: number;
		endTime: number;
		createdBy?: string;
		title?: string;
		notes?: string;
	}>
) {
	broadcast(JSON.stringify({ type: 'clip-regions-changed', clipRegions }));
}

export function broadcastClipEncodeStatus(
	clipId: string,
	status: 'pending' | 'encoding' | 'ready' | 'error',
	error?: string
) {
	broadcast(JSON.stringify({ type: 'clip-encode-status', clipId, status, ...(error && { error }) }));
}

export function broadcastExportStatus(exportId: string, status: string, outputPath?: string, error?: string) {
	broadcast(
		JSON.stringify({
			type: 'export-status',
			exportId,
			status,
			...(outputPath && { outputPath }),
			...(error && { error })
		})
	);
}
