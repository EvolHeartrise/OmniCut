import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion } from './types.js';
import {
	enqueueClipEncode,
	getClipEncodeStatus,
	getEncodedClipPath,
	waitForClipReady,
	ffmpegConcatEscape
} from './clipEncoder.js';

const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));

/**
 * Export all clip regions as a single stitched video file.
 * Uses pre-encoded clip MP4s from the clip encoder queue.
 * If any clips are not yet ready, enqueues them and waits.
 */
export async function exportVideo(
	clips: ClipRegion[],
	filename: string,
	onProgress: (message: string, step: number, totalSteps: number) => void
): Promise<{ outputPath: string }> {
	if (clips.length === 0) {
		throw new Error('No clip regions to export');
	}

	fs.mkdirSync(EXPORTS_DIR, { recursive: true });

	const totalSteps = clips.length + 1; // wait steps + concat

	onProgress(`Starting export: ${clips.length} clips`, 0, totalSteps);

	// Ensure all clips are queued for encoding
	for (const clip of clips) {
		const status = getClipEncodeStatus(clip.id);
		if (!status || status === 'error') {
			enqueueClipEncode(clip.id);
		}
	}

	// Wait for all clips to finish encoding
	const clipFiles: string[] = [];
	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		const dur = clip.endTime - clip.startTime;

		let encodedPath = getEncodedClipPath(clip.id);
		if (!encodedPath) {
			onProgress(
				`Waiting for clip ${i + 1}/${clips.length} to finish encoding (${dur.toFixed(1)}s)`,
				i, totalSteps
			);
			const finalStatus = await waitForClipReady(clip.id);
			if (finalStatus === 'error') {
				throw new Error(`Clip ${i + 1} failed to encode`);
			}
			encodedPath = getEncodedClipPath(clip.id);
		} else {
			onProgress(
				`Using pre-encoded clip ${i + 1}/${clips.length} (${dur.toFixed(1)}s)`,
				i, totalSteps
			);
		}

		if (!encodedPath) {
			throw new Error(`Clip ${i + 1} has no encoded file after encoding completed`);
		}
		clipFiles.push(encodedPath);
	}

	// Concat all pre-encoded clips with stream copy (near-instant)
	const tempDir = path.join(EXPORTS_DIR, `temp_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	try {
		const concatListPath = path.join(tempDir, 'concat.txt');
		const concatContent = clipFiles
			.map((f) => ffmpegConcatEscape(f))
			.join('\n');
		fs.writeFileSync(concatListPath, concatContent);

		const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.mp4`);

		onProgress(
			`Concatenating ${clipFiles.length} clips into ${safeName}.mp4`,
			clips.length, totalSteps
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

let nvencCached: boolean | null = null;

/** Test if NVENC is available by encoding a tiny synthetic video (result cached). */
export async function detectNvenc(): Promise<boolean> {
	if (nvencCached !== null) return nvencCached;
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
		nvencCached = code === 0;
		return nvencCached;
	} catch {
		nvencCached = false;
		return false;
	}
}
