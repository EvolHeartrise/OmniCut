import * as path from 'node:path';
import type { RequestHandler } from './$types.js';
import { getStreamRecordingDir } from '$lib/server/streamManager.js';

/**
 * GET /api/waveform/:id?start=<local_seconds>&end=<local_seconds>
 *
 * Extracts audio from the HLS recording using FFmpeg, returns raw
 * signed 16-bit LE mono PCM at 8000 Hz. The client computes RMS
 * peaks from this directly — no real-time playback needed.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const streamId = params.id;
	const recordingDir = getStreamRecordingDir(streamId);
	if (!recordingDir) {
		return new Response('Stream not found', { status: 404 });
	}

	const start = parseFloat(url.searchParams.get('start') || '0');
	const end = parseFloat(url.searchParams.get('end') || '0');
	if (end <= start) {
		return new Response('Invalid time range', { status: 400 });
	}

	const playlist = path.join(recordingDir, 'playlist.m3u8');
	const duration = end - start;

	const proc = Bun.spawn(
		[
			'ffmpeg',
			'-ss',
			start.toFixed(3),
			'-t',
			duration.toFixed(3),
			'-i',
			playlist,
			'-vn',
			'-ac',
			'1',
			'-ar',
			'8000',
			'-f',
			's16le',
			'-acodec',
			'pcm_s16le',
			'pipe:1'
		],
		{ stdout: 'pipe', stderr: 'ignore' }
	);

	const output = await new Response(proc.stdout).arrayBuffer();
	await proc.exited;

	return new Response(output, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Cache-Control': 'public, max-age=300'
		}
	});
};
