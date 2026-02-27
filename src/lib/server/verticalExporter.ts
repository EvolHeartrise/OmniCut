/**
 * Vertical (9:16) video exporter for mobile short-form content.
 * Produces 1080x1920 output: gameplay (full frame) on top, cropped webcam on bottom.
 * Encodes directly from raw HLS segments — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, CameraBoundsEntry, ClipEntry } from '../types.js';
import { parseRelevantSegments, ffmpegConcatEscape, buildConcatContent } from './hlsUtils.js';
import { runFfmpeg } from './ffmpeg.js';
import { detectNvenc, probeVideo, type StreamLookup } from './exporter.js';

const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));

// Output dimensions
const OUT_W = 1080;
const OUT_H = 1920;
const MAX_CAM_H = 700;

/** A clip with its resolved camera bounds for vertical export. */
export interface VerticalClip {
	clip: ClipRegion;
	cam: CameraBoundsEntry;
	entry?: ClipEntry;
}

/**
 * Export clips as a vertical 9:16 video with gameplay on top and webcam crop on bottom.
 * Encodes directly from raw HLS segments.
 */
export async function exportVerticalVideo(
	verticalClips: VerticalClip[],
	streamMap: Map<string, StreamLookup>,
	filename: string,
	onProgress: (message: string, step: number, totalSteps: number) => void
): Promise<{ outputPath: string }> {
	if (verticalClips.length === 0) {
		throw new Error('No clips with camera bounds to export');
	}

	fs.mkdirSync(EXPORTS_DIR, { recursive: true });

	const totalSteps = verticalClips.length + 1;
	onProgress(`Starting vertical export: ${verticalClips.length} clips`, 0, totalSteps);

	const useNvenc = await detectNvenc();
	const tempDir = path.join(EXPORTS_DIR, `temp_vert_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	try {
		const verticalFiles: string[] = [];

		for (let i = 0; i < verticalClips.length; i++) {
			const { clip, cam, entry } = verticalClips[i];
			const stream = streamMap.get(clip.streamId);
			if (!stream) {
				console.warn(`[vertical-export] Skipping clip ${i + 1} — stream ${clip.streamId} not found`);
				continue;
			}

			// Apply trim offsets from clip entry
			const trimStartOffset = entry?.trimStart ?? 0;
			const trimEndOffset = entry?.trimEnd ?? 0;
			const effectiveStart = clip.startTime + trimStartOffset;
			const effectiveEnd = clip.endTime - trimEndOffset;
			const speed = entry?.speed ?? 1;

			if (effectiveEnd <= effectiveStart) {
				console.warn(`[vertical-export] Skipping clip ${i + 1} — trim makes duration ≤ 0`);
				continue;
			}

			const dur = effectiveEnd - effectiveStart;
			onProgress(`Encoding clip ${i + 1}/${verticalClips.length} as vertical (${dur.toFixed(1)}s)`, i, totalSteps);

			const anchor = stream.startedAt / 1000;
			const localStart = effectiveStart - anchor + stream.offset;
			const localEnd = effectiveEnd - anchor + stream.offset;
			const playlistPath = path.join(stream.recordingDir, 'playlist.m3u8');

			const segments = parseRelevantSegments(playlistPath, stream.recordingDir, localStart, localEnd);
			if (segments.length === 0) {
				console.warn(`[vertical-export] Skipping clip ${i + 1} — no segments`);
				continue;
			}

			const concatPath = path.join(tempDir, `clip_${i}.concat.txt`);
			fs.writeFileSync(concatPath, buildConcatContent(segments));

			const trimStart = Math.max(0, localStart - segments[0].startTime);

			// Probe source resolution from first segment
			const probe = await probeVideo(segments[0].file);
			if (probe.width === 0 || probe.height === 0) {
				console.warn(`[vertical-export] Skipping clip ${i + 1} (probe failed)`);
				continue;
			}

			// Compute crop/scale dimensions from normalized cam coords
			const cx = Math.round(cam.camX * probe.width);
			const cy = Math.round(cam.camY * probe.height);
			const cw = Math.round(cam.camW * probe.width);
			const ch = Math.round(cam.camH * probe.height);

			// Compute cam panel height: scale cam to fill OUT_W, preserving aspect ratio, capped at MAX_CAM_H
			const camAR = cw / Math.max(1, ch);
			let camH = Math.round(OUT_W / camAR);
			// Ensure even dimensions for h264
			camH = Math.min(camH, MAX_CAM_H) & ~1;
			const gameH = (OUT_H - camH) & ~1;

			// Build filter graph — single pass from raw segments
			const speedFilter = speed !== 1 ? `,setpts=PTS/${speed}` : '';
			const filterGraph = [
				`[0:v]split=2[gameplay][camsrc]`,
				`[camsrc]crop=${cw}:${ch}:${cx}:${cy},scale=${OUT_W}:-2,crop=${OUT_W}:${camH}[cam]`,
				`[gameplay]scale=${OUT_W}:${gameH}:force_original_aspect_ratio=increase,crop=${OUT_W}:${gameH}[game]`,
				`[game][cam]vstack=inputs=2${speedFilter},format=yuv420p[outv]`
			].join(';');

			// Build audio filter for speed
			const aFilters: string[] = [];
			if (speed !== 1) {
				let remaining = speed;
				while (remaining > 2.0) { aFilters.push('atempo=2.0'); remaining /= 2.0; }
				while (remaining < 0.5) { aFilters.push('atempo=0.5'); remaining /= 0.5; }
				aFilters.push(`atempo=${remaining.toFixed(4)}`);
			}

			const fps = probe.fps > 0 ? probe.fps : 30;
			const gop = Math.round(fps * 2);
			const outFile = path.join(tempDir, `clip_${i}.mp4`);

			let videoArgs: string[];
			if (useNvenc) {
				videoArgs = [
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
					'-c:v', 'libx264',
					'-preset', 'medium',
					'-profile:v', 'high',
					'-crf', '18',
					'-bf', '2',
					'-g', `${gop}`,
					'-flags', '+cgop'
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
				'-filter_complex', filterGraph,
				'-map', '[outv]', '-map', '0:a?',
				...videoArgs,
				'-fps_mode', 'cfr',
				'-r', `${fps}`,
				...audioArgs,
				'-movflags', '+faststart',
				'-y', outFile
			], 2000);

			verticalFiles.push(outFile);
		}

		if (verticalFiles.length === 0) {
			throw new Error('All clips failed to encode — nothing to export');
		}

		onProgress(`Concatenating ${verticalFiles.length} vertical clips`, verticalClips.length, totalSteps);

		const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.mp4`);

		if (verticalFiles.length === 1) {
			fs.renameSync(verticalFiles[0], outputPath);
		} else {
			const concatListPath = path.join(tempDir, 'concat.txt');
			const concatContent = verticalFiles.map((f) => ffmpegConcatEscape(f)).join('\n');
			fs.writeFileSync(concatListPath, concatContent);

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
