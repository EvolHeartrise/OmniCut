import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { StreamInfo, CaptureHandle, StreamMeta } from './types.js';
import { twitchGql, STREAM_META_GQL, VOD_META_GQL, fetchDouyuChannel } from './twitchApi.js';

export type { CaptureHandle };

// --- Douyu stream URL resolver ---
// Douyu requires a signed request to get the stream URL. The signing function
// is obfuscated JS that wraps CryptoJS MD5. We fetch it from their API and
// evaluate it in Bun's JS runtime to produce the signature.

let _cryptoJsMd5Cache: string | null = null;

async function getCryptoJsMd5(): Promise<string> {
	if (_cryptoJsMd5Cache) return _cryptoJsMd5Cache;
	const res = await fetch('https://cdnjs.cloudflare.com/ajax/libs/crypto-js/3.1.2/rollups/md5.js');
	_cryptoJsMd5Cache = await res.text();
	return _cryptoJsMd5Cache;
}

async function getDouyuSignParams(roomId: string): Promise<Record<string, string>> {
	// Fetch the signing JS function for this room
	const encRes = await fetch(`https://www.douyu.com/swf_api/homeH5Enc?rids=${roomId}`);
	const encData = await encRes.json();
	const signFunc: string = encData?.data?.[`room${roomId}`];
	if (!signFunc) {
		throw new Error(`Failed to get Douyu signing function for room ${roomId}`);
	}

	const cryptoJs = await getCryptoJsMd5();
	const uuid = crypto.randomUUID().replace(/-/g, '');
	const ts = Math.floor(Date.now() / 1000);

	// Write script to temp file and execute in subprocess for isolation
	// (script is ~60KB — too large for a command-line argument)
	// Validate roomId is purely numeric to prevent injection
	if (!/^\d+$/.test(roomId)) {
		throw new Error(`Invalid Douyu room ID: ${roomId}`);
	}
	const tmpPath = path.join(os.tmpdir(), `douyu-sign-${crypto.randomUUID()}.js`);
	const script = `${cryptoJs};${signFunc};process.stdout.write(ub98484234("${roomId}","${uuid}","${ts}"))`;
	fs.writeFileSync(tmpPath, script);

	const proc = Bun.spawn(['bun', tmpPath], {
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;

	try {
		fs.unlinkSync(tmpPath);
	} catch {
		/* ignore */
	}

	// Parse the query string result into key-value pairs
	const params: Record<string, string> = {};
	for (const part of output.split('&')) {
		const [k, v] = part.split('=');
		if (k && v) params[decodeURIComponent(k)] = decodeURIComponent(v);
	}
	return params;
}

/**
 * Resolve a Douyu live stream to a direct FLV/HLS URL.
 * Returns the best quality stream URL or throws if unavailable.
 */
export async function resolveDouyuStreamUrl(roomId: string): Promise<string> {
	const signParams = await getDouyuSignParams(roomId);

	const body = new URLSearchParams({ rate: '0', ...signParams }).toString();
	const res = await fetch(`https://www.douyu.com/lapi/live/getH5Play/${roomId}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	const data = await res.json();
	const streamData = data?.data;
	if (!streamData?.rtmp_url || !streamData?.rtmp_live) {
		throw new Error(`Douyu room ${roomId} is not live or stream URL unavailable`);
	}
	return `${streamData.rtmp_url}/${streamData.rtmp_live}`;
}

export async function fetchDouyuStreamMeta(roomId: string): Promise<StreamMeta> {
	const ch = await fetchDouyuChannel(roomId);
	return {
		viewerCount: ch.viewerCount,
		title: ch.title,
		gameName: ch.gameName,
		createdAt: ch.startedAt,
		vodId: null
	};
}

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
 * Twitch pipeline:  streamlink (stdout) -> FFmpeg (stdin) -> HLS segments
 * Douyu pipeline:   resolve stream URL -> FFmpeg (direct input) -> HLS segments
 */
export function startCapture(
	channel: string,
	id: string,
	recordingsBase: string,
	onStatusChange: (info: StreamInfo) => void,
	vodUrl?: string,
	platform: 'twitch' | 'douyu' = 'twitch',
	hlsStartOffset?: number
): CaptureHandle {
	const recordingDir = path.join(recordingsBase, id);
	fs.mkdirSync(recordingDir, { recursive: true });

	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	const segmentPattern = path.join(recordingDir, 'seg%06d.ts');

	const isVod = !!vodUrl;

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
		sourceType: isVod ? 'vod' : 'live',
		parentStreamId: null,
		platform,
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
				} catch {
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

	const fetchMeta = platform === 'douyu' ? fetchDouyuStreamMeta : fetchStreamMeta;
	let streamMetaInterval: ReturnType<typeof setInterval> | null = null;
	if (!isVod) {
		streamMetaInterval = setInterval(async () => {
			if (info.status === 'capturing') {
				try {
					const meta = await fetchMeta(channel);
					info.viewerCount = meta.viewerCount;
					info.streamTitle = meta.title;
					info.gameName = meta.gameName;
				} catch {
					/* network error — will retry next interval */
				}
			}
		}, 30000);
		fetchMeta(channel).then((meta) => {
			info.viewerCount = meta.viewerCount;
			info.streamTitle = meta.title;
			info.gameName = meta.gameName;
		});
	}

	function clearPolling() {
		if (segmentWatchInterval) clearInterval(segmentWatchInterval);
		if (streamMetaInterval) clearInterval(streamMetaInterval);
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

	if (platform === 'douyu') {
		// Douyu: resolve stream URL asynchronously, then start FFmpeg with direct input
		(async () => {
			try {
				const streamUrl = await resolveDouyuStreamUrl(channel);
				console.log(`[douyu:${channel}] Resolved stream URL`);

				ffmpegProc = Bun.spawn(
					[
						'ffmpeg',
						'-i',
						streamUrl,
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
					{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
				);

				logStderr(ffmpegProc, 'ffmpeg');

				ffmpegProc.exited.then((code) => {
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
			} catch (err) {
				clearPolling();
				console.error(`[douyu:${channel}] Failed to resolve stream:`, err);
				info.status = 'error';
				info.error = err instanceof Error ? err.message : 'Failed to resolve Douyu stream';
				onStatusChange(info);
			}
		})();
	} else {
		// Twitch: streamlink stdout piped into FFmpeg stdin
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
