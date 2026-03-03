import * as path from 'node:path';
import * as fs from 'node:fs';
import type { StreamInfo, CaptureHandle, StreamMeta } from './types.js';
import { twitchGql, STREAM_META_GQL, VOD_META_GQL } from './twitchApi.js';

export type { CaptureHandle };

export async function fetchStreamMeta(channel: string): Promise<StreamMeta> {
	try {
		const data = await twitchGql<{ data?: { user?: { stream?: Record<string, unknown> } } }>(STREAM_META_GQL, {
			login: channel
		});
		const stream = data?.data?.user?.stream as
			| {
					viewersCount?: number;
					title?: string;
					game?: { name: string };
					createdAt?: string;
					archiveVideo?: { id: string };
			  }
			| undefined;
		return {
			viewerCount: stream?.viewersCount ?? null,
			title: stream?.title ?? null,
			gameName: stream?.game?.name ?? null,
			createdAt: stream?.createdAt ?? null,
			vodId: stream?.archiveVideo?.id ?? null
		};
	} catch {
		return { viewerCount: null, title: null, gameName: null, createdAt: null, vodId: null };
	}
}

export interface VodMeta {
	channel: string;
	title: string | null;
	createdAt: string | null;
	durationSeconds: number | null;
}

export async function fetchVodMeta(vodId: string): Promise<VodMeta> {
	try {
		const data = await twitchGql<{ data?: { video?: Record<string, unknown> } }>(VOD_META_GQL, { id: vodId });
		const video = data?.data?.video as
			| { owner?: { login: string }; title?: string; createdAt?: string; lengthSeconds?: number }
			| undefined;
		if (!video) {
			return { channel: '', title: null, createdAt: null, durationSeconds: null };
		}
		return {
			channel: video.owner?.login ?? '',
			title: video.title ?? null,
			createdAt: video.createdAt ?? null,
			durationSeconds: video.lengthSeconds ?? null
		};
	} catch {
		return { channel: '', title: null, createdAt: null, durationSeconds: null };
	}
}

/**
 * Starts capturing a stream, outputting HLS segments to the given recording directory.
 *
 * Pipeline:  streamlink (stdout) -> FFmpeg (stdin) -> HLS segments
 */
export function startCapture(
	channel: string,
	id: string,
	recordingsBase: string,
	onStatusChange: (info: StreamInfo) => void,
	vodUrl?: string,
	hlsStartOffset?: number
): CaptureHandle {
	const recordingDir = path.join(recordingsBase, id);
	fs.mkdirSync(recordingDir, { recursive: true });

	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	const segmentPattern = path.join(recordingDir, 'seg%06d.ts');

	const info: StreamInfo = {
		id,
		channel,
		status: 'starting',
		startedAt: Date.now(),
		segmentCount: 0,
		diskUsageBytes: 0,
		viewerCount: null,
		streamTitle: null,
		gameName: null,
		recordingDir,
		offset: 0,
		sourceType: 'vod',
		parentStreamId: null,
		platform: 'twitch',
		sourceUrl: vodUrl || null,
		chatComplete: false,
		durationSeconds: null
	};

	// Processes to track (populated differently per platform)
	let sourceProc: ReturnType<typeof Bun.spawn> | null = null;
	let ffmpegProc: ReturnType<typeof Bun.spawn> | null = null;

	// Segment watcher: probes for the next expected sequential file (seg%06d.ts)
	// instead of readdir-ing the whole directory every second.
	let nextSegIndex = 0;
	let cumulativeDiskUsage = 0;
	const segmentWatchInterval = setInterval(async () => {
		if (info.status === 'stopped' || info.status === 'error') return;
		try {
			// Probe sequentially for new segments
			while (true) {
				const segName = `seg${String(nextSegIndex).padStart(6, '0')}.ts`;
				const segPath = path.join(recordingDir, segName);
				try {
					const stat = await fs.promises.stat(segPath);
					cumulativeDiskUsage += stat.size;
					nextSegIndex++;
				} catch (err: unknown) {
					if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
						console.warn(`[capture] stat failed for ${segPath}: ${(err as Error).message}`);
					}
					break; // File doesn't exist yet — stop probing
				}
			}

			info.segmentCount = nextSegIndex;
			info.diskUsageBytes = cumulativeDiskUsage;

			if (nextSegIndex > 0 && info.status === 'starting') {
				info.status = 'capturing';
			}
			onStatusChange(info);
		} catch {
			// Directory may not exist yet
		}
	}, 1000);

	function clearPolling() {
		if (segmentWatchInterval) clearInterval(segmentWatchInterval);
	}

	const kill = () => {
		info.status = 'stopped';
		clearPolling();
		try {
			sourceProc?.kill();
		} catch {
			/* already dead */
		}
		try {
			ffmpegProc?.kill();
		} catch {
			/* already dead */
		}
		onStatusChange(info);
	};

	// Collect last stderr line containing "error" for better error messages
	const lastErrors: Record<string, string> = {};

	function logStderr(proc: ReturnType<typeof Bun.spawn>, label: string) {
		(async () => {
			const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const msg = decoder.decode(value);
					if (msg.includes('error') || msg.includes('Error')) {
						console.error(`[${label}:${channel}] ${msg.trim()}`);
						// Keep last meaningful error line for process exit messages
						const lines = msg.trim().split('\n');
						const errLine = lines.findLast((l: string) => /error/i.test(l));
						if (errLine) lastErrors[label] = errLine.trim().slice(0, 200);
					}
				}
			} catch {
				/* stream closed */
			}
		})();
	}

	{
		const twitchUrl = vodUrl || `https://twitch.tv/${channel}`;
		const streamlinkArgs = [twitchUrl, 'best', '--stdout'];

		if (hlsStartOffset && hlsStartOffset > 0) {
			streamlinkArgs.push('--hls-start-offset', hlsStartOffset.toFixed(1));
		}

		const twitchToken = process.env.TWITCH_OAUTH_TOKEN;
		if (twitchToken) {
			streamlinkArgs.push(`--twitch-api-header=Authorization=OAuth ${twitchToken}`);
		}

		sourceProc = Bun.spawn(['streamlink', ...streamlinkArgs], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		});

		logStderr(sourceProc, 'streamlink');

		ffmpegProc = Bun.spawn(
			[
				'ffmpeg',
				'-i',
				'pipe:0',
				'-c:v',
				'copy',
				'-c:a',
				'copy',
				'-f',
				'hls',
				'-hls_time',
				'2',
				'-hls_list_size',
				'0',
				'-hls_flags',
				'append_list+independent_segments',
				'-hls_segment_filename',
				segmentPattern,
				playlistPath
			],
			{ stdin: sourceProc.stdout, stdout: 'pipe', stderr: 'pipe' }
		);

		logStderr(ffmpegProc, 'ffmpeg');

		// Wait for both processes; use stderr to surface real errors.
		// FFmpeg dying first breaks the pipe → streamlink gets a write error.
		// We want to report the FFmpeg error, not the generic pipe break.
		const ffmpegRef = ffmpegProc;
		const sourceRef = sourceProc;

		ffmpegRef.exited.then((code) => {
			console.log(`[ffmpeg:${channel}] exited with code ${code}`);
			if (info.status !== 'stopped' && info.status !== 'error') {
				clearPolling();
				if (code !== 0) {
					info.status = 'error';
					info.error = lastErrors['ffmpeg']
						? `FFmpeg error: ${lastErrors['ffmpeg']}`
						: `ffmpeg exited with code ${code}`;
				} else {
					info.status = 'stopped';
				}
				onStatusChange(info);
			}
		});

		sourceRef.exited.then((code) => {
			console.log(`[streamlink:${channel}] exited with code ${code}`);
			if (info.status !== 'stopped' && info.status !== 'error') {
				clearPolling();
				if (code !== 0) {
					info.status = 'error';
					// Prefer FFmpeg's error if available (pipe break in streamlink is a symptom, not the cause)
					info.error = lastErrors['ffmpeg']
						? `FFmpeg error: ${lastErrors['ffmpeg']}`
						: lastErrors['streamlink']
							? `streamlink: ${lastErrors['streamlink']}`
							: `streamlink exited with code ${code}`;
				} else {
					info.status = 'stopped';
				}
				onStatusChange(info);
			}
		});
	}

	onStatusChange(info);

	return { info, kill, segmentWatchInterval };
}
