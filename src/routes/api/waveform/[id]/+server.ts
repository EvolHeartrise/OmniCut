import type { RequestHandler } from './$types.js';
import { getStreamRecordingDir } from '$lib/server/streamManager.js';
import { getRecordingMp4 } from '$lib/server/remuxer.js';
import { runFfmpegBuffer } from '$lib/server/ffmpeg.js';

/**
 * GET /api/waveform/:id?start=<local_seconds>&end=<local_seconds>
 *
 * Extracts audio from recording.mp4 using FFmpeg, returns raw
 * signed 16-bit LE mono PCM at 8000 Hz. The client computes RMS
 * peaks from this directly — no real-time playback needed.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const streamId = params.id;
	const recordingDir = getStreamRecordingDir(streamId);
	if (!recordingDir) {
		return new Response('Stream not found', { status: 404 });
	}

	const mp4Path = getRecordingMp4(recordingDir);
	if (!mp4Path) {
		return new Response('Recording not yet remuxed', { status: 404 });
	}

	const start = parseFloat(url.searchParams.get('start') || '0');
	const end = parseFloat(url.searchParams.get('end') || '0');
	if (end <= start) {
		return new Response('Invalid time range', { status: 400 });
	}

	const duration = end - start;

	try {
		const output = await runFfmpegBuffer([
			'-ss', start.toFixed(3),
			'-t', duration.toFixed(3),
			'-i', mp4Path,
			'-vn',
			'-ac', '1',
			'-ar', '8000',
			'-f', 's16le',
			'-acodec', 'pcm_s16le',
			'pipe:1'
		]);

		return new Response(new Uint8Array(output), {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Cache-Control': 'public, max-age=300'
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(message, { status: 500 });
	}
};
