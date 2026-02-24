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
	gameName: string | null;
	recordingDir: string;
	offset: number;
	sourceType: 'live' | 'vod';
	parentStreamId: string | null;
	platform: 'twitch' | 'douyu';
	sourceUrl: string | null;
	chatComplete: boolean;
	durationSeconds: number | null;
}

export interface ChatMessage {
	username: string;
	text: string;
	timestamp: number; // stream-local seconds (seconds since capture startedAt)
	color?: string | null; // user's chat color (hex string like "#FF69B4")
	badges?: string | null; // comma-separated badge set IDs (e.g. "moderator,subscriber")
	twitchId: string; // Twitch-assigned globally unique message ID (UUID)
}

export type ChatCallback = (streamId: string, msg: ChatMessage) => void;

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
	gameName: string | null;
	createdAt: string | null;
	vodId: string | null;
}
