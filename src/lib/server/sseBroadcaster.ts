/**
 * SSE (Server-Sent Events) broadcaster module.
 * Manages connected SSE clients and provides typed broadcast helpers.
 */

import type { StreamInfo, ChatMessage } from './types.js';
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

export function initCounts(streamId: string): void {
	chatMessageCounts.set(streamId, db.countChatMessages(streamId));
	transcriptionCounts.set(streamId, db.countTranscriptions(streamId));
}

export function deleteCounts(streamId: string): void {
	chatMessageCounts.delete(streamId);
	transcriptionCounts.delete(streamId);
}

export function getChatMessageCount(streamId: string): number {
	return chatMessageCounts.get(streamId) ?? 0;
}

export function getTranscriptionCount(streamId: string): number {
	return transcriptionCounts.get(streamId) ?? 0;
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
		chatComplete: info.chatComplete
	};
}

export function broadcastUpdate(info: StreamInfo) {
	broadcast(JSON.stringify({ type: 'stream-update', stream: serializeStreamInfo(info) }));
}

export function broadcastTranscription(streamId: string, text: string, startTime: number, endTime: number) {
	db.saveTranscription(streamId, text, startTime, endTime);
	transcriptionCounts.set(streamId, (transcriptionCounts.get(streamId) ?? 0) + 1);
	broadcast(JSON.stringify({ type: 'transcription', streamId, text, startTime, endTime }));
}

export function persistChatMessage(streamId: string, msg: ChatMessage) {
	try {
		db.saveChatMessage(streamId, msg);
		chatMessageCounts.set(streamId, (chatMessageCounts.get(streamId) ?? 0) + 1);
	} catch (err) {
		console.error(`[chat] Failed to save message for stream ${streamId}:`, err);
	}
}

export function broadcastExportProgress(message: string, step: number, totalSteps: number) {
	broadcast(JSON.stringify({ type: 'export-progress', message, step, totalSteps }));
}

export function broadcastTranscriptionCleared(streamId: string) {
	broadcast(JSON.stringify({ type: 'transcription-cleared', streamId }));
}
