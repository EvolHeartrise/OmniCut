/**
 * Remuxes HLS segments into a single recording.mp4 after download completes.
 * Original segments + playlist.m3u8 are preserved on disk.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { runFfmpeg, ffmpegConcatEscape, probeMedia } from './ffmpeg.js';
import { cleanupFiles } from './fsUtils.js';

interface SegmentInfo {
	file: string;
	duration: number;
}

/** Parse all segments from an HLS playlist. */
function parseAllSegments(playlistPath: string, recordingDir: string): SegmentInfo[] {
	const content = fs.readFileSync(playlistPath, 'utf-8');
	const lines = content.split('\n');
	const segments: SegmentInfo[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.startsWith('#EXTINF:')) {
			const segDur = parseFloat(line.split(':')[1].replace(',', ''));
			const nextLine = lines[i + 1]?.trim();
			if (nextLine && !nextLine.startsWith('#')) {
				segments.push({
					file: path.join(recordingDir, nextLine),
					duration: segDur
				});
			}
		}
	}
	return segments;
}

/** Build concat demuxer file content with duration directives. */
function buildConcatContent(segments: SegmentInfo[]): string {
	return segments
		.map((s) => `${ffmpegConcatEscape(s.file)}\nduration ${s.duration.toFixed(6)}`)
		.join('\n');
}

export interface RemuxResult {
	mp4Path: string;
	durationSeconds: number;
}

/**
 * Remux all HLS segments in a recording directory into a single recording.mp4.
 * Returns the mp4 path and probed duration.
 */
export async function remuxRecording(recordingDir: string): Promise<RemuxResult> {
	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	if (!fs.existsSync(playlistPath)) {
		throw new Error(`Playlist not found: ${playlistPath}`);
	}

	const segments = parseAllSegments(playlistPath, recordingDir);
	if (segments.length === 0) {
		throw new Error(`No segments found in playlist: ${playlistPath}`);
	}

	const concatPath = path.join(recordingDir, '.remux.concat.txt');
	const mp4Path = path.join(recordingDir, 'recording.mp4');

	try {
		fs.writeFileSync(concatPath, buildConcatContent(segments));

		await runFfmpeg([
			'-f', 'concat', '-safe', '0',
			'-fflags', '+genpts',
			'-i', concatPath,
			'-c', 'copy',
			'-movflags', '+faststart',
			'-y', mp4Path
		], 2000);

		const { duration: durationSeconds } = await probeMedia(mp4Path);

		return { mp4Path, durationSeconds };
	} finally {
		cleanupFiles(concatPath);
	}
}

/**
 * Returns the recording.mp4 path if it exists in the recording directory, null otherwise.
 */
export function getRecordingMp4(recordingDir: string): string | null {
	const mp4Path = path.join(recordingDir, 'recording.mp4');
	return fs.existsSync(mp4Path) ? mp4Path : null;
}
