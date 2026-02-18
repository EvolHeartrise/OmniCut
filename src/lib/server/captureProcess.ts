import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { StreamInfo, CaptureHandle, StreamMeta } from './types.js';
import { TWITCH_CLIENT_ID } from './twitchApi.js';

export type { CaptureHandle };

export async function fetchStreamMeta(channel: string): Promise<StreamMeta> {
	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: {
				'Client-ID': TWITCH_CLIENT_ID,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				query: 'query($login: String!) { user(login: $login) { stream { viewersCount title createdAt archiveVideo { id } } } }',
				variables: { login: channel }
			})
		});
		const data = await res.json();
		const stream = data?.data?.user?.stream;
		return {
			viewerCount: stream?.viewersCount ?? null,
			title: stream?.title ?? null,
			createdAt: stream?.createdAt ?? null,
			vodId: stream?.archiveVideo?.id ?? null
		};
	} catch {
		return { viewerCount: null, title: null, createdAt: null, vodId: null };
	}
}

/**
 * Starts capturing a Twitch stream via streamlink piped into FFmpeg,
 * outputting HLS segments to the given recording directory.
 *
 * Pipeline: streamlink (stdout) -> FFmpeg (stdin) -> HLS segments on disk
 */
export function startCapture(
	channel: string,
	id: string,
	recordingsBase: string,
	onStatusChange: (info: StreamInfo) => void,
	vodUrl?: string
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
		recordingDir,
		offset: 0,
		sourceType: isVod ? 'vod' : 'live',
		parentStreamId: null
	};

	let streamlinkProc: ReturnType<typeof spawn> | null = null;
	let ffmpegProc: ReturnType<typeof spawn> | null = null;

	// Start streamlink to get the raw stream data
	const twitchUrl = vodUrl || `https://twitch.tv/${channel}`;
	const streamlinkArgs = [twitchUrl, 'best', '--stdout'];

	const twitchToken = process.env.TWITCH_OAUTH_TOKEN;
	if (twitchToken) {
		streamlinkArgs.push(`--twitch-api-header=Authorization=OAuth ${twitchToken}`);
	}

	streamlinkProc = spawn('streamlink', streamlinkArgs, {
		stdio: ['ignore', 'pipe', 'pipe']
	});

	streamlinkProc.stderr?.on('data', (data: Buffer) => {
		const msg = data.toString();
		// streamlink prints status info to stderr
		if (msg.includes('error') || msg.includes('Error')) {
			console.error(`[streamlink:${channel}] ${msg.trim()}`);
		}
	});

	// Start FFmpeg to receive streamlink's stdout and output HLS
	// Note: -force_key_frames is omitted because -c:v copy cannot insert keyframes.
	// Keyframe interval is determined by the source stream.
	ffmpegProc = spawn(
		'ffmpeg',
		[
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
		{
			stdio: ['pipe', 'pipe', 'pipe']
		}
	);

	// Pipe streamlink stdout -> ffmpeg stdin
	if (streamlinkProc.stdout && ffmpegProc.stdin) {
		streamlinkProc.stdout.pipe(ffmpegProc.stdin);
		// Swallow EPIPE when ffmpeg dies before streamlink stops writing
		ffmpegProc.stdin.on('error', () => {});
	}

	ffmpegProc.stderr?.on('data', (data: Buffer) => {
		const msg = data.toString();
		if (msg.includes('Error') || msg.includes('error')) {
			console.error(`[ffmpeg:${channel}] ${msg.trim()}`);
		}
	});

	// Update status asynchronously once FFmpeg starts producing segments
	const segmentWatchInterval = setInterval(async () => {
		try {
			const allFiles = await fs.promises.readdir(recordingDir);
			const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));
			info.segmentCount = tsFiles.length;

			const stats = await Promise.all(
				allFiles.map(async (f) => {
					try {
						const stat = await fs.promises.stat(path.join(recordingDir, f));
						return stat.size;
					} catch { return 0; }
				})
			);
			info.diskUsageBytes = stats.reduce((a, b) => a + b, 0);

			if (tsFiles.length > 0 && info.status === 'starting') {
				info.status = 'capturing';
			}
			onStatusChange(info);
		} catch {
			// Directory may not exist yet
		}
	}, 1000);

	// Poll stream metadata every 30 seconds (skip for VODs — no live viewer count)
	let streamMetaInterval: ReturnType<typeof setInterval> | null = null;
	if (!isVod) {
		streamMetaInterval = setInterval(async () => {
			if (info.status === 'capturing') {
				const meta = await fetchStreamMeta(channel);
				info.viewerCount = meta.viewerCount;
				info.streamTitle = meta.title;
			}
		}, 30000);
		fetchStreamMeta(channel).then((meta) => {
			info.viewerCount = meta.viewerCount;
			info.streamTitle = meta.title;
		});
	}

	// Handle process exits
	streamlinkProc.on('close', (code) => {
		console.log(`[streamlink:${channel}] exited with code ${code}`);
		if (info.status !== 'stopped') {
			info.status = code === 0 ? 'stopped' : 'error';
			info.error = code !== 0 ? `streamlink exited with code ${code}` : undefined;
			onStatusChange(info);
		}
	});

	ffmpegProc.on('close', (code) => {
		console.log(`[ffmpeg:${channel}] exited with code ${code}`);
		if (info.status !== 'stopped') {
			info.status = 'stopped';
			onStatusChange(info);
		}
	});

	onStatusChange(info);

	const kill = () => {
		info.status = 'stopped';
		if (segmentWatchInterval) clearInterval(segmentWatchInterval);
		if (streamMetaInterval) clearInterval(streamMetaInterval);
		// Unpipe before killing so no writes reach a dead stdin
		if (streamlinkProc?.stdout && ffmpegProc?.stdin) {
			streamlinkProc.stdout.unpipe(ffmpegProc.stdin);
		}
		try {
			streamlinkProc?.kill('SIGTERM');
		} catch {
			/* already dead */
		}
		try {
			ffmpegProc?.kill('SIGTERM');
		} catch {
			/* already dead */
		}
		onStatusChange(info);
	};

	return { info, kill, segmentWatchInterval };
}
