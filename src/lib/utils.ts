import type Hls from 'hls.js';

/** Format seconds as m:ss. */
export function formatDuration(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format byte counts as human-readable strings. */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

/** Shared HLS.js configuration for all players. */
export function createHlsConfig(isLive: boolean): Partial<ConstructorParameters<typeof Hls>[0]> {
	return {
		enableWorker: true,
		lowLatencyMode: false,
		backBufferLength: 120,
		maxBufferLength: isLive ? 30 : 60,
		maxMaxBufferLength: 600,
		...(isLive ? { liveSyncDurationCount: 3 } : {})
	};
}
