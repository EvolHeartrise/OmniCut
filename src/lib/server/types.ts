import type { Subprocess } from 'bun';

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
	clipRegions: Array<{ id: string; streamId: string; startTime: number; endTime: number }>;
}

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

export interface CaptureHandle {
	info: StreamInfo;
	streamlinkProc: Subprocess | null;
	ffmpegProc: Subprocess | null;
	segmentWatchInterval: ReturnType<typeof setInterval> | null;
}
