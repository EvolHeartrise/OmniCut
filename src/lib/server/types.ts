import type { ClipRegion } from '../types.js';

export type { ClipRegion };

export interface StreamInfo {
	id: string;
	channel: string;
	status: 'starting' | 'capturing' | 'error' | 'stopped';
	startedAt: number;
	error?: string;
	segmentCount: number;
	diskUsageBytes: number;
	viewerCount: number | null;
	streamTitle: string | null;
	recordingDir: string;
	offset: number;
	sourceType: 'live' | 'vod';
	parentStreamId: string | null;
}

export interface ChatMessage {
	username: string;
	text: string;
	timestamp: number; // stream-local seconds (seconds since capture startedAt)
}

export interface CaptureHandle {
	info: StreamInfo;
	kill: () => void;
	segmentWatchInterval: ReturnType<typeof setInterval> | null;
	stopChat?: () => void;
	/** Guard flag: true once startTranscription has been called for this capture */
	transcriptionStarted?: boolean;
	/** Guard flag: true once chat collection has been started for this capture */
	chatStarted?: boolean;
}

export interface StreamMeta {
	viewerCount: number | null;
	title: string | null;
	createdAt: string | null;
	vodId: string | null;
}

export interface SessionExport {
	version: 1;
	exportedAt: number;
	streams: Array<{
		id: string;
		channel: string;
		startedAt: number;
		viewerCount: number | null;
		streamTitle: string | null;
		recordingDir: string;
		offset: number;
		sourceType: 'live' | 'vod';
		parentStreamId: string | null;
	}>;
	transcriptions: Record<string, Array<{ text: string; startTime: number; endTime: number }>>;
	clipRegions: ClipRegion[];
	chatMessages?: Record<string, ChatMessage[]>;
}
