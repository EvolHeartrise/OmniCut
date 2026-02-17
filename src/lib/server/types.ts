import type { Subprocess } from 'bun';

export interface StreamInfo {
	id: string;
	channel: string;
	status: 'starting' | 'capturing' | 'error' | 'stopped';
	startedAt: number;
	error?: string;
	segmentCount: number;
	recordingDir: string;
}

export interface CaptureHandle {
	info: StreamInfo;
	streamlinkProc: Subprocess | null;
	ffmpegProc: Subprocess | null;
	segmentWatchInterval: ReturnType<typeof setInterval> | null;
}
