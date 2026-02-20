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

/**
 * Normalize a channel input — strips common Twitch/Douyu URL prefixes,
 * trailing path segments, and lowercases the result.
 */
export function normalizeChannel(input: string): string {
	return input
		.replace(/^https?:\/\/(www\.)?(twitch\.tv|douyu\.com)\//, '')
		.replace(/\/.*$/, '')
		.trim()
		.toLowerCase();
}

/** Twitch-style username color palette (from Twitch's default set). */
const USERNAME_COLORS = [
	'#ff0000', '#0000ff', '#008000', '#b22222', '#ff7f50',
	'#9acd32', '#ff4500', '#2e8b57', '#daa520', '#d2691e',
	'#5f9ea0', '#1e90ff', '#ff69b4', '#8a2be2', '#00ff7f'
];

/** Deterministic color for a username (hash-based). */
export function usernameColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return USERNAME_COLORS[Math.abs(hash) % USERNAME_COLORS.length];
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
