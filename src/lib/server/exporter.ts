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
import { runFfmpeg } from './ffmpeg.js';

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

	// Wait for all clips to finish encoding (skip failures)
	const clipFiles: string[] = [];
	let skipped = 0;
	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		const dur = clip.endTime - clip.startTime;

		let encodedPath = getEncodedClipPath(clip.id);
		if (!encodedPath) {
			onProgress(`Waiting for clip ${i + 1}/${clips.length} to finish encoding (${dur.toFixed(1)}s)`, i, totalSteps);
			const finalStatus = await waitForClipReady(clip.id);
			if (finalStatus === 'error') {
				console.warn(`Export: skipping clip ${i + 1}/${clips.length} (encode failed)`);
				onProgress(`Skipping clip ${i + 1}/${clips.length} (encode failed)`, i, totalSteps);
				skipped++;
				continue;
			}
			encodedPath = getEncodedClipPath(clip.id);
		} else {
			onProgress(`Using pre-encoded clip ${i + 1}/${clips.length} (${dur.toFixed(1)}s)`, i, totalSteps);
		}

		if (!encodedPath) {
			console.warn(`Export: skipping clip ${i + 1}/${clips.length} (no encoded file)`);
			onProgress(`Skipping clip ${i + 1}/${clips.length} (no encoded file)`, i, totalSteps);
			skipped++;
			continue;
		}
		clipFiles.push(encodedPath);
	}

	if (clipFiles.length === 0) {
		throw new Error('All clips failed to encode — nothing to export');
	}

	// Probe first clip for resolution and framerate
	const probe = await probeVideo(clipFiles[0]);
	const needsUpscale = probe.height > 0 && probe.height < 1080;
	const useNvenc = await detectNvenc();

	const tempDir = path.join(EXPORTS_DIR, `temp_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	try {
		const concatListPath = path.join(tempDir, 'concat.txt');
		const concatContent = clipFiles.map((f) => ffmpegConcatEscape(f)).join('\n');
		fs.writeFileSync(concatListPath, concatContent);

		const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.mp4`);

		const skipMsg = skipped > 0 ? ` (${skipped} skipped)` : '';
		const scaleLabel = needsUpscale ? `Upscaling ${probe.height}p → 1080p and encoding` : 'Encoding';
		onProgress(`${scaleLabel} ${clipFiles.length} clips${skipMsg}`, clips.length, totalSteps);

		// Full re-encode: guarantees CFR, closed GOPs, and clean timestamps
		// for YouTube compatibility. No stream copy — eliminates all sources of
		// VFR, timestamp discontinuities, and AAC priming gaps.
		const vf = needsUpscale ? 'scale=-2:1080:flags=lanczos,format=yuv420p' : 'format=yuv420p';
		const fps = probe.fps > 0 ? probe.fps : 30;
		const gop = Math.round(fps * 2); // 2-second keyframe interval

		let videoArgs: string[];
		if (useNvenc) {
			videoArgs = [
				'-vf', vf,
				'-c:v', 'h264_nvenc',
				'-preset', 'p4',
				'-profile:v', 'high',
				'-qp', '18',
				'-rc-lookahead', '32',
				'-bf', '2',
				'-g', `${gop}`,
				'-flags', '+cgop'
			];
		} else {
			videoArgs = [
				'-vf', vf,
				'-c:v', 'libx264',
				'-preset', 'medium',
				'-profile:v', 'high',
				'-crf', '18',
				'-bf', '2',
				'-g', `${gop}`,
				'-flags', '+cgop'
			];
		}

		await runFfmpeg([
			'-fflags', '+genpts',
			'-f', 'concat', '-safe', '0', '-i', concatListPath,
			...videoArgs,
			'-fps_mode', 'cfr',
			'-r', `${fps}`,
			'-af', 'aresample=async=1000:first_pts=0',
			'-c:a', 'aac', '-ar', '48000', '-b:a', '192k',
			'-movflags', '+faststart',
			'-y', outputPath
		], 1000);

		onProgress(`Done — saved to ${outputPath}`, totalSteps, totalSteps);
		return { outputPath };
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/** Probe a video file's height and framerate. */
async function probeVideo(filePath: string): Promise<{ height: number; fps: number }> {
	try {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
				'-show_entries', 'stream=height,r_frame_rate', '-of', 'json', filePath],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return { height: 0, fps: 0 };
		const data = JSON.parse(stdout);
		const stream = data.streams?.[0];
		const height = parseInt(stream?.height, 10) || 0;
		// r_frame_rate is a fraction like "30/1" or "60000/1001"
		let fps = 0;
		if (stream?.r_frame_rate) {
			const [num, den] = stream.r_frame_rate.split('/').map(Number);
			if (den > 0) fps = Math.round(num / den);
		}
		return { height, fps };
	} catch {
		return { height: 0, fps: 0 };
	}
}

let nvencCached: boolean | null = null;

/** Test if NVENC is available by encoding a tiny synthetic video (result cached). */
export async function detectNvenc(): Promise<boolean> {
	if (nvencCached !== null) return nvencCached;
	try {
		const proc = Bun.spawn(
			[
				'ffmpeg',
				'-f',
				'lavfi',
				'-i',
				'nullsrc=s=64x64:d=0.1',
				'-f',
				'lavfi',
				'-i',
				'anullsrc=d=0.1',
				'-c:v',
				'h264_nvenc',
				'-preset',
				'p4',
				'-qp',
				'18',
				'-c:a',
				'aac',
				'-f',
				'null',
				'-'
			],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe'
			}
		);

		const code = await proc.exited;
		nvencCached = code === 0;
		return nvencCached;
	} catch {
		nvencCached = false;
		return false;
	}
}
