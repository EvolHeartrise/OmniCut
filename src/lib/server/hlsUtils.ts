/**
 * HLS utility functions for reading segments from HLS playlists
 * and extracting frames via FFmpeg.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { cleanupFiles } from './fsUtils.js';

export interface SegmentInfo {
	file: string;
	startTime: number;
	duration: number;
}

/**
 * Parse an HLS playlist and return segments covering [localStart, localEnd].
 */
export function parseRelevantSegments(
	playlistPath: string,
	recordingDir: string,
	localStart: number,
	localEnd: number
): SegmentInfo[] {
	const content = fs.readFileSync(playlistPath, 'utf-8');
	const lines = content.split('\n');
	let segTime = 0;
	const segments: SegmentInfo[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.startsWith('#EXTINF:')) {
			const segDur = parseFloat(line.split(':')[1].replace(',', ''));
			const nextLine = lines[i + 1]?.trim();
			if (nextLine && !nextLine.startsWith('#')) {
				const segEnd = segTime + segDur;
				if (segEnd > localStart && segTime < localEnd) {
					segments.push({
						file: path.join(recordingDir, nextLine),
						startTime: segTime,
						duration: segDur
					});
				}
				segTime = segEnd;
			}
		}
	}
	return segments;
}

/**
 * Escape a file path for use in an ffmpeg concat demuxer list file.
 */
export function ffmpegConcatEscape(filePath: string): string {
	const escaped = filePath.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
	return `file '${escaped}'`;
}

/**
 * Build concat demuxer file content with duration directives.
 * Including duration tells ffmpeg exactly how long each segment is,
 * producing continuous timestamps without gaps at segment boundaries.
 */
export function buildConcatContent(segments: SegmentInfo[]): string {
	return segments
		.map((s) => `${ffmpegConcatEscape(s.file)}\nduration ${s.duration.toFixed(6)}`)
		.join('\n');
}

/**
 * Extract a single JPEG frame from an HLS recording at a given local timestamp.
 * Returns the raw JPEG bytes as a Buffer.
 */
export async function extractFrame(recordingDir: string, localTimestamp: number): Promise<Buffer> {
	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	const segments = parseRelevantSegments(playlistPath, recordingDir, localTimestamp, localTimestamp + 0.1);
	if (segments.length === 0) {
		throw new Error(`No segments found at timestamp ${localTimestamp}`);
	}

	const concatPath = path.join(recordingDir, `.frame-${Date.now()}.concat.txt`);
	try {
		const concatContent = segments.map((s) => ffmpegConcatEscape(s.file)).join('\n');
		fs.writeFileSync(concatPath, concatContent);

		const seekPos = Math.max(0, localTimestamp - segments[0].startTime);
		const proc = Bun.spawn(
			[
				'ffmpeg',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				'-ss', seekPos.toFixed(3),
				'-frames:v', '1',
				'-f', 'image2pipe',
				'-c:v', 'mjpeg',
				'-q:v', '3',
				'pipe:1'
			],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);

		const [stdoutBuf, stderrText, exitCode] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).text(),
			proc.exited
		]);

		if (exitCode !== 0) {
			throw new Error(`ffmpeg failed (code ${exitCode}): ${stderrText.slice(-500)}`);
		}

		const buffer = Buffer.from(stdoutBuf);
		if (buffer.length === 0) {
			throw new Error('ffmpeg produced no output — timestamp may be beyond recording duration');
		}

		return buffer;
	} finally {
		cleanupFiles(concatPath);
	}
}

/**
 * Extract a single JPEG frame from an HLS recording with an ffmpeg video filter applied (e.g. crop).
 * Returns the raw JPEG bytes as a Buffer.
 */
export async function extractFrameCropped(recordingDir: string, localTimestamp: number, vf: string): Promise<Buffer> {
	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	const segments = parseRelevantSegments(playlistPath, recordingDir, localTimestamp, localTimestamp + 0.1);
	if (segments.length === 0) {
		throw new Error(`No segments found at timestamp ${localTimestamp}`);
	}

	const concatPath = path.join(recordingDir, `.frame-crop-${Date.now()}.concat.txt`);
	try {
		const concatContent = segments.map((s) => ffmpegConcatEscape(s.file)).join('\n');
		fs.writeFileSync(concatPath, concatContent);

		const seekPos = Math.max(0, localTimestamp - segments[0].startTime);
		const proc = Bun.spawn(
			[
				'ffmpeg',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				'-ss', seekPos.toFixed(3),
				'-frames:v', '1',
				'-vf', vf,
				'-f', 'image2pipe',
				'-c:v', 'mjpeg',
				'-q:v', '3',
				'pipe:1'
			],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);

		const [stdoutBuf, stderrText, exitCode] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).text(),
			proc.exited
		]);

		if (exitCode !== 0) {
			throw new Error(`ffmpeg failed (code ${exitCode}): ${stderrText.slice(-500)}`);
		}

		const buffer = Buffer.from(stdoutBuf);
		if (buffer.length === 0) {
			throw new Error('ffmpeg produced no output — timestamp may be beyond recording duration');
		}

		return buffer;
	} finally {
		cleanupFiles(concatPath);
	}
}
