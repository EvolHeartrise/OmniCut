/**
 * Frame extraction utilities for recordings.
 * Uses recording.mp4 directly — simple seek-based extraction.
 */

import { getRecordingMp4 } from './remuxer.js';
import { runFfmpegBuffer } from './ffmpeg.js';

/**
 * Extract a single JPEG frame from a recording at a given local timestamp.
 * Optionally applies a video filter (e.g. crop). Returns the raw JPEG bytes.
 */
export async function extractFrame(recordingDir: string, localTimestamp: number, vf?: string): Promise<Buffer> {
	const mp4Path = getRecordingMp4(recordingDir);
	if (!mp4Path) {
		throw new Error(`recording.mp4 not found in ${recordingDir}`);
	}

	const args = [
		'-ss', localTimestamp.toFixed(3),
		'-i', mp4Path,
		'-frames:v', '1',
		...(vf ? ['-vf', vf] : []),
		'-f', 'image2pipe',
		'-c:v', 'mjpeg',
		'-q:v', '3',
		'pipe:1'
	];

	const buffer = await runFfmpegBuffer(args);
	if (buffer.length === 0) {
		throw new Error('ffmpeg produced no output — timestamp may be beyond recording duration');
	}

	return buffer;
}
