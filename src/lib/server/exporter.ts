import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, StreamInfo } from './types.js';

const EXPORTS_DIR = path.resolve(process.cwd(), 'exports');

/**
 * Escape a file path for use in an ffmpeg concat demuxer list file.
 * The concat format wraps entries in single quotes and requires escaping
 * single quotes and backslashes within the path.
 */
function ffmpegConcatEscape(filePath: string): string {
	// ffmpeg concat format: file 'path'
	// Inside quotes: escape \ as \\ and ' as '\''
	const escaped = filePath.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
	return `file '${escaped}'`;
}

/**
 * Export all clip regions as a single stitched video file.
 * Clips are sorted by startTime (same order as Cleaning mode).
 */
export async function exportVideo(
	clips: ClipRegion[],
	filename: string,
	getStreamInfo: (streamId: string) => StreamInfo | null,
	onProgress: (message: string, step: number, totalSteps: number) => void
): Promise<{ outputPath: string }> {
	const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime);
	if (sortedClips.length === 0) {
		throw new Error('No clip regions to export');
	}

	fs.mkdirSync(EXPORTS_DIR, { recursive: true });

	const tempDir = path.join(EXPORTS_DIR, `temp_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	const clipFiles: string[] = [];
	const totalSteps = sortedClips.length + 1; // clips + concat

	onProgress(`Starting export: ${sortedClips.length} clips`, 0, totalSteps);

	// Detect NVENC support by running a quick test encode
	let useNvenc = await detectNvenc();
	if (useNvenc) {
		onProgress('Using NVENC GPU encoding', 0, totalSteps);
	} else {
		onProgress('NVENC unavailable — using CPU encoding (slower)', 0, totalSteps);
	}

	try {
		for (let i = 0; i < sortedClips.length; i++) {
			const clip = sortedClips[i];
			const info = getStreamInfo(clip.streamId);
			if (!info) {
				throw new Error(`Stream ${clip.streamId} not found for clip ${i + 1}`);
			}

			const anchor = info.startedAt / 1000;
			const localStart = clip.startTime - anchor + info.offset;
			const localEnd = clip.endTime - anchor + info.offset;
			const dur = clip.endTime - clip.startTime;
			const playlistPath = path.join(info.recordingDir, 'playlist.m3u8');

			const encoder = useNvenc ? 'NVENC' : 'x264';
			onProgress(
				`[${encoder}] Encoding clip ${i + 1}/${sortedClips.length} — ${info.channel} (${dur.toFixed(1)}s)`,
				i, totalSteps
			);

			// Parse playlist to find segments covering [localStart, localEnd]
			const playlistContent = fs.readFileSync(playlistPath, 'utf-8');
			const lines = playlistContent.split('\n');
			let segTime = 0;
			const relevantSegments: { file: string; startTime: number; duration: number }[] = [];

			for (let li = 0; li < lines.length; li++) {
				const line = lines[li].trim();
				if (line.startsWith('#EXTINF:')) {
					const segDur = parseFloat(line.split(':')[1].replace(',', ''));
					const nextLine = lines[li + 1]?.trim();
					if (nextLine && !nextLine.startsWith('#')) {
						const segEnd = segTime + segDur;
						if (segEnd > localStart && segTime < localEnd) {
							const segPath = path.join(info.recordingDir, nextLine);
							relevantSegments.push({ file: segPath, startTime: segTime, duration: segDur });
						}
						segTime = segEnd;
					}
				}
			}

			if (relevantSegments.length === 0) {
				throw new Error(`No segments found for clip ${i + 1} (${info.channel})`);
			}

			// Build concat list for the relevant segments
			const padded = i.toString().padStart(4, '0');
			const clipConcatPath = path.join(tempDir, `clip_${padded}_concat.txt`);
			const clipConcatContent = relevantSegments
				.map((s) => ffmpegConcatEscape(s.file))
				.join('\n');
			fs.writeFileSync(clipConcatPath, clipConcatContent);

			const segGroupStart = relevantSegments[0].startTime;
			const trimStart = Math.max(0, localStart - segGroupStart);
			const clipFile = path.join(tempDir, `clip_${padded}.mp4`);

			// Encode directly from segments → mp4 in one step
			const encodeArgs = useNvenc
				? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18']
				: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'];

			try {
				await runFfmpeg([
					'-f', 'concat', '-safe', '0', '-i', clipConcatPath,
					'-ss', trimStart.toFixed(3), '-t', dur.toFixed(3),
					'-map', '0:v:0', '-map', '0:a:0',
					'-vf', 'format=yuv420p',
					...encodeArgs,
					'-c:a', 'aac', '-b:a', '192k',
					'-movflags', '+faststart',
					'-y', clipFile
				]);
			} catch (err) {
				if (useNvenc) {
					console.error(`NVENC failed on clip ${i + 1}, falling back to libx264 ultrafast`);
					onProgress(`NVENC failed — switching to CPU encoding`, i, totalSteps);
					useNvenc = false;

					await runFfmpeg([
						'-f', 'concat', '-safe', '0', '-i', clipConcatPath,
						'-ss', trimStart.toFixed(3), '-t', dur.toFixed(3),
						'-map', '0:v:0', '-map', '0:a:0',
						'-vf', 'format=yuv420p',
						'-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
						'-c:a', 'aac', '-b:a', '192k',
						'-movflags', '+faststart',
						'-y', clipFile
					]);
				} else {
					throw err;
				}
			}

			clipFiles.push(clipFile);
		}

		// Create final concat list
		const concatListPath = path.join(tempDir, 'concat.txt');
		const concatContent = clipFiles
			.map((f) => ffmpegConcatEscape(f))
			.join('\n');
		fs.writeFileSync(concatListPath, concatContent);

		const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.mp4`);

		onProgress(
			`Concatenating ${clipFiles.length} clips into ${safeName}.mp4`,
			sortedClips.length, totalSteps
		);

		// Fast concat — all clips are already encoded mp4s with consistent format
		await runFfmpeg([
			'-f', 'concat', '-safe', '0', '-i', concatListPath,
			'-c', 'copy', '-movflags', '+faststart',
			'-y', outputPath
		]);

		onProgress(`Done — saved to ${outputPath}`, totalSteps, totalSteps);
		return { outputPath };
	} finally {
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

/** Run an ffmpeg command and return a promise. Rejects with full stderr on failure. */
async function runFfmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(['ffmpeg', ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;

	if (code !== 0) {
		throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-1000)}`);
	}
}

/** Test if NVENC is available by encoding a tiny synthetic video. */
async function detectNvenc(): Promise<boolean> {
	try {
		const proc = Bun.spawn([
			'ffmpeg',
			'-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
			'-f', 'lavfi', '-i', 'anullsrc=d=0.1',
			'-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18',
			'-c:a', 'aac',
			'-f', 'null', '-'
		], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		});

		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}
