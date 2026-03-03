import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RequestHandler } from './$types.js';
import { getStreamRecordingDir } from '$lib/server/streamManager.js';
import { parseRelevantSegments, buildConcatContent } from '$lib/server/hlsUtils.js';
import { cleanupFiles } from '$lib/server/fsUtils.js';

/**
 * GET /api/waveform/:id?start=<local_seconds>&end=<local_seconds>
 *
 * Extracts audio from the HLS recording using FFmpeg, returns raw
 * signed 16-bit LE mono PCM at 8000 Hz. The client computes RMS
 * peaks from this directly — no real-time playback needed.
 *
 * Uses the concat demuxer instead of the HLS demuxer so that seeking
 * works correctly on playlists with #EXT-X-DISCONTINUITY tags
 * (e.g. from resumed VOD downloads).
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

	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	const segments = parseRelevantSegments(playlistPath, recordingDir, start, end);
	if (segments.length === 0) {
		return new Response('No segments found for time range', { status: 404 });
	}

	const concatPath = path.join(recordingDir, `.waveform-${Date.now()}.concat.txt`);
	try {
		fs.writeFileSync(concatPath, buildConcatContent(segments));

		const seekOffset = Math.max(0, start - segments[0].startTime);
		const duration = end - start;

		const proc = Bun.spawn(
			[
				'ffmpeg',
				'-fflags', '+genpts',
				'-ss', seekOffset.toFixed(3),
				'-t', duration.toFixed(3),
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				'-vn',
				'-ac', '1',
				'-ar', '8000',
				'-f', 's16le',
				'-acodec', 'pcm_s16le',
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
	} finally {
		cleanupFiles(concatPath);
	}
};
