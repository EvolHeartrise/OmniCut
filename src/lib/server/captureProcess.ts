import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { StreamInfo } from './types.js';

export interface CaptureHandle {
	info: StreamInfo;
	kill: () => void;
	segmentWatchInterval: ReturnType<typeof setInterval> | null;
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
	onStatusChange: (info: StreamInfo) => void
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
		recordingDir
	};

	let streamlinkProc: ReturnType<typeof spawn> | null = null;
	let ffmpegProc: ReturnType<typeof spawn> | null = null;

	// Start streamlink to get the raw stream data
	const twitchUrl = `https://twitch.tv/${channel}`;

	streamlinkProc = spawn('streamlink', [twitchUrl, 'best', '--stdout', '--twitch-disable-ads'], {
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
	ffmpegProc = spawn(
		'ffmpeg',
		[
			'-i',
			'pipe:0', // Read from stdin
			'-c:v',
			'copy', // Copy video codec (no re-encode)
			'-c:a',
			'copy', // Copy audio codec (no re-encode)
			'-f',
			'hls', // Output format: HLS
			'-hls_time',
			'2', // 2-second segments
			'-hls_list_size',
			'0', // Keep ALL segments in the playlist
			'-hls_flags',
			'append_list+independent_segments',
			'-hls_segment_filename',
			segmentPattern,
			'-force_key_frames',
			'expr:gte(t,n_forced*1)', // Keyframe every 1 second
			playlistPath
		],
		{
			stdio: ['pipe', 'pipe', 'pipe']
		}
	);

	// Pipe streamlink stdout -> ffmpeg stdin
	if (streamlinkProc.stdout && ffmpegProc.stdin) {
		streamlinkProc.stdout.pipe(ffmpegProc.stdin);
	}

	ffmpegProc.stderr?.on('data', (data: Buffer) => {
		const msg = data.toString();
		// FFmpeg outputs progress info to stderr — we can use this for status
		if (msg.includes('Error') || msg.includes('error')) {
			console.error(`[ffmpeg:${channel}] ${msg.trim()}`);
		}
	});

	// Update status once FFmpeg starts producing segments
	const segmentWatchInterval = setInterval(() => {
		try {
			const files = fs.readdirSync(recordingDir).filter((f) => f.endsWith('.ts'));
			info.segmentCount = files.length;

			if (files.length > 0 && info.status === 'starting') {
				info.status = 'capturing';
				onStatusChange(info);
			}
		} catch {
			// Directory may not exist yet
		}
	}, 1000);

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
