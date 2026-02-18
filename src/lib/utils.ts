import type Hls from 'hls.js';

/** Format seconds as m:ss. */
export function formatDuration(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Shared HLS.js configuration for all players. */
export function createHlsConfig(): Partial<ConstructorParameters<typeof Hls>[0]> {
	return {
		enableWorker: true,
		lowLatencyMode: false,
		backBufferLength: 120,
		maxBufferLength: 30,
		maxMaxBufferLength: 600
	};
}
