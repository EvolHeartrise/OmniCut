/**
 * Standard (16:9) video exporter.
 * Encodes clips directly from raw HLS segments on disk — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, ClipEntry } from '../types.js';
import type { StreamInfo } from './types.js';
import { parseRelevantSegments, ffmpegConcatEscape, buildConcatContent } from './hlsUtils.js';
import { runFfmpeg } from './ffmpeg.js';

const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));

/** Resolved stream info needed for encoding a clip from raw segments. */
export interface StreamLookup {
	recordingDir: string;
	startedAt: number;
	offset: number;
}

/**
 * Export all clip regions as a single stitched video file.
 * Encodes each clip directly from the raw HLS segments on disk.
 */
export async function exportVideo(
	clips: ClipRegion[],
	streamMap: Map<string, StreamLookup>,
	filename: string,
	onProgress: (message: string, step: number, totalSteps: number) => void,
	clipEntries?: (ClipEntry | undefined)[]
): Promise<{ outputPath: string }> {
	if (clips.length === 0) {
		throw new Error('No clip regions to export');
	}

	fs.mkdirSync(EXPORTS_DIR, { recursive: true });

	const totalSteps = clips.length + 1; // per-clip encode + final concat
	onProgress(`Starting export: ${clips.length} clips`, 0, totalSteps);

	const useNvenc = await detectNvenc();
	const tempDir = path.join(EXPORTS_DIR, `temp_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	try {
		const clipFiles: string[] = [];
		let skipped = 0;

		for (let i = 0; i < clips.length; i++) {
			const clip = clips[i];
			const entry = clipEntries?.[i];
			const stream = streamMap.get(clip.streamId);
			if (!stream) {
				console.warn(`Export: skipping clip ${i + 1}/${clips.length} — stream ${clip.streamId} not found`);
				onProgress(`Skipping clip ${i + 1}/${clips.length} (stream not found)`, i, totalSteps);
				skipped++;
				continue;
			}

			// Apply trim offsets from clip entry
			const trimStartOffset = entry?.trimStart ?? 0;
			const trimEndOffset = entry?.trimEnd ?? 0;
			const effectiveStart = clip.startTime + trimStartOffset;
			const effectiveEnd = clip.endTime - trimEndOffset;
			const speed = entry?.speed ?? 1;

			if (effectiveEnd <= effectiveStart) {
				console.warn(`Export: skipping clip ${i + 1}/${clips.length} — trim makes duration ≤ 0`);
				skipped++;
				continue;
			}

			const dur = effectiveEnd - effectiveStart;
			onProgress(`Encoding clip ${i + 1}/${clips.length} (${dur.toFixed(1)}s)`, i, totalSteps);

			const anchor = stream.startedAt / 1000;
			const localStart = effectiveStart - anchor + stream.offset;
			const localEnd = effectiveEnd - anchor + stream.offset;
			const playlistPath = path.join(stream.recordingDir, 'playlist.m3u8');

			const segments = parseRelevantSegments(playlistPath, stream.recordingDir, localStart, localEnd);
			if (segments.length === 0) {
				console.warn(`Export: skipping clip ${i + 1}/${clips.length} — no segments`);
				onProgress(`Skipping clip ${i + 1}/${clips.length} (no segments)`, i, totalSteps);
				skipped++;
				continue;
			}

			const concatPath = path.join(tempDir, `clip_${i}.concat.txt`);
			fs.writeFileSync(concatPath, buildConcatContent(segments));

			const trimStart = Math.max(0, localStart - segments[0].startTime);
			const outFile = path.join(tempDir, `clip_${i}.mp4`);

			// Build video filter chain
			const vFilters: string[] = [];
			if (speed !== 1) {
				vFilters.push(`setpts=PTS/${speed}`);
			}
			vFilters.push('format=yuv420p');

			// Build audio filter chain
			const aFilters: string[] = [];
			if (speed !== 1) {
				// atempo only supports 0.5-2.0 range, chain multiple for wider range
				let remaining = speed;
				const parts: string[] = [];
				while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
				while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
				parts.push(`atempo=${remaining.toFixed(4)}`);
				aFilters.push(...parts);
			}

			let videoArgs: string[];
			if (useNvenc) {
				videoArgs = [
					'-vf', vFilters.join(','),
					'-c:v', 'h264_nvenc',
					'-preset', 'p4',
					'-profile:v', 'high',
					'-qp', '18',
					'-rc-lookahead', '32',
					'-bf', '2'
				];
			} else {
				videoArgs = [
					'-vf', vFilters.join(','),
					'-c:v', 'libx264',
					'-preset', 'medium',
					'-profile:v', 'high',
					'-crf', '18',
					'-bf', '2'
				];
			}

			const audioArgs = aFilters.length > 0
				? ['-af', aFilters.join(','), '-c:a', 'aac', '-ar', '48000', '-b:a', '192k']
				: ['-c:a', 'aac', '-ar', '48000', '-b:a', '192k'];

			await runFfmpeg([
				'-fflags', '+genpts',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				'-ss', trimStart.toFixed(3),
				'-t', dur.toFixed(3),
				'-map', '0:v:0', '-map', '0:a:0',
				...videoArgs,
				'-fps_mode', 'cfr',
				...audioArgs,
				'-video_track_timescale', '90000',
				'-movflags', '+faststart',
				'-y', outFile
			], 2000);

			clipFiles.push(outFile);
		}

		if (clipFiles.length === 0) {
			throw new Error('All clips failed to encode — nothing to export');
		}

		const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.mp4`);

		if (clipFiles.length === 1) {
			// Single clip — just move it
			fs.renameSync(clipFiles[0], outputPath);
		} else {
			const skipMsg = skipped > 0 ? ` (${skipped} skipped)` : '';
			onProgress(`Concatenating ${clipFiles.length} clips${skipMsg}`, clips.length, totalSteps);

			// Concat with stream copy — all clips are encoded with identical settings
			const concatListPath = path.join(tempDir, 'final_concat.txt');
			fs.writeFileSync(concatListPath, clipFiles.map((f) => ffmpegConcatEscape(f)).join('\n'));

			await runFfmpeg([
				'-fflags', '+genpts',
				'-f', 'concat', '-safe', '0', '-i', concatListPath,
				'-c', 'copy',
				'-movflags', '+faststart',
				'-y', outputPath
			], 1000);
		}

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

/** Probe a video file's width, height, and framerate. */
export async function probeVideo(filePath: string): Promise<{ width: number; height: number; fps: number }> {
	try {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
				'-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', filePath],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return { width: 0, height: 0, fps: 0 };
		const data = JSON.parse(stdout);
		const stream = data.streams?.[0];
		const width = parseInt(stream?.width, 10) || 0;
		const height = parseInt(stream?.height, 10) || 0;
		let fps = 0;
		if (stream?.r_frame_rate) {
			const [num, den] = stream.r_frame_rate.split('/').map(Number);
			if (den > 0) fps = Math.round(num / den);
		}
		return { width, height, fps };
	} catch {
		return { width: 0, height: 0, fps: 0 };
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
				'-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
				'-f', 'lavfi', '-i', 'anullsrc=d=0.1',
				'-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18',
				'-c:a', 'aac',
				'-f', 'null', '-'
			],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);

		const code = await proc.exited;
		nvencCached = code === 0;
		return nvencCached;
	} catch {
		nvencCached = false;
		return false;
	}
}
