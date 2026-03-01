/**
 * Vertical (9:16) video exporter for mobile short-form content.
 * Produces 1080x1920 output: gameplay (full frame) on top, cropped webcam on bottom.
 * Encodes directly from raw HLS segments — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import type { ClipRegion, CameraBoundsEntry, ClipEntry, EffectEntry } from '../types.js';
import { runFfmpeg } from './ffmpeg.js';
import { detectNvenc, probeVideo, resolveOverlappingEffects, resolveZoomEffects, buildZoomFilter, ZOOM_SUPERSAMPLE, type StreamLookup, type ClipContext } from './exporter.js';
import { clearEffectRendererCache } from './effectRenderer.js';
import { clearChatEffectCache } from './chatEffectRenderer.js';
import {
	resolveClip, buildAudioArgs, buildVideoEncoderArgs, createTempDir, cleanupTempDir,
	concatClipFiles, buildOutputPath
} from './exporterCommon.js';

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
	onProgress: (message: string, step: number, totalSteps: number) => void,
	effectEntries?: EffectEntry[],
	compOffsets?: number[],
	channelMap?: Map<string, string>
): Promise<{ outputPath: string }> {
	if (verticalClips.length === 0) {
		throw new Error('No clips with camera bounds to export');
	}

	const totalSteps = verticalClips.length + 1;
	onProgress(`Starting vertical export: ${verticalClips.length} clips`, 0, totalSteps);

	const useNvenc = await detectNvenc();
	const tempDir = createTempDir('vert');

	try {
		const verticalFiles: string[] = [];

		for (let i = 0; i < verticalClips.length; i++) {
			const { clip, cam, entry } = verticalClips[i];
			const resolved = resolveClip(
				clip, entry, streamMap.get(clip.streamId),
				i, verticalClips.length, tempDir, 'vertical-export'
			);
			if (!resolved) continue;

			const { dur, clipDur, speed, trimStart, concatPath, segments, localStart: clipLocalStart, localEnd: clipLocalEnd } = resolved;
			onProgress(`Encoding clip ${i + 1}/${verticalClips.length} as vertical (${dur.toFixed(1)}s)`, i, totalSteps);

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
			camH = Math.min(camH, MAX_CAM_H) & ~1;
			const gameH = (OUT_H - camH) & ~1;

			// Find overlapping effects for this clip
			const clipCompStart = compOffsets?.[i] ?? 0;
			const clipCompEnd = clipCompStart + clipDur;

			// Resolve zoom effects first so we know if we need to supersample overlays
			const clipZooms = resolveZoomEffects(effectEntries, clipCompStart, clipCompEnd, clipDur);
			const hasZoom = clipZooms.length > 0;

			const clipCtx: ClipContext | undefined = channelMap?.get(clip.streamId) ? {
				streamId: clip.streamId,
				channel: channelMap.get(clip.streamId)!,
				streamLocalStart: clipLocalStart,
				streamLocalEnd: clipLocalEnd
			} : undefined;
			const overlappingEffects = await resolveOverlappingEffects(
				effectEntries, clipCompStart, clipCompEnd, clipDur, tempDir, i,
				OUT_W, OUT_H, clipCtx,
				hasZoom ? ZOOM_SUPERSAMPLE : 1
			);

			const extraInputs: string[] = [];
			for (const eff of overlappingEffects) {
				const itsoffset = ['-itsoffset', (trimStart + eff.localStart).toFixed(3)];
				if (eff.rawVideo) {
					extraInputs.push(
						...itsoffset,
						'-f', 'rawvideo', '-pix_fmt', 'rgba',
						'-s', `${eff.rawVideo.width}x${eff.rawVideo.height}`,
						'-r', `${eff.rawVideo.fps}`,
						'-i', eff.videoPath!
					);
				} else {
					extraInputs.push(...itsoffset, '-i', eff.videoPath ?? eff.pngPath!);
				}
			}

			// Build filter graph — single pass from raw segments
			const speedFilter = speed !== 1 ? `,setpts=PTS/${speed}` : '';

			// When zoom effects are present, composite at supersample resolution
			// so overlays (chat panels, text) stay crisp when zoomed.
			const ss = hasZoom ? ZOOM_SUPERSAMPLE : 1;
			const compW = OUT_W * ss;
			const compH = OUT_H * ss;
			const scaleUp = hasZoom ? `,scale=${compW}:${compH}` : '';

			let filterGraph = [
				`[0:v]split=2[gameplay][camsrc]`,
				`[camsrc]crop=${cw}:${ch}:${cx}:${cy},scale=${OUT_W}:-2,crop=${OUT_W}:${camH}[cam]`,
				`[gameplay]scale=${OUT_W}:${gameH}:force_original_aspect_ratio=increase,crop=${OUT_W}:${gameH}[game]`,
				`[game][cam]vstack=inputs=2${speedFilter},format=yuv420p${scaleUp}[vbase]`
			].join(';');

			let finalLabel = 'vbase';
			const fps = probe.fps > 0 ? probe.fps : 30;

			// 1. Overlay chain (composited at ss resolution when zoom is present)
			for (let ei = 0; ei < overlappingEffects.length; ei++) {
				const eff = overlappingEffects[ei];
				const inputIdx = ei + 1;
				const isLastOverlay = ei === overlappingEffects.length - 1;
				const nextLabel = isLastOverlay && !hasZoom ? 'outv' : `ov${ei}`;
				const enableStart = (trimStart + eff.localStart).toFixed(3);
				const enableEnd = (trimStart + eff.localEnd).toFixed(3);
				const alphaFmt = 'format=yuva420p';
				const ox = eff.x * ss;
				const oy = eff.y * ss;
				let overlayInput: string;
				const effScale = (eff.scale && eff.scale !== 1) ? eff.scale : 1;
				const pngSsScale = !eff.rawVideo && ss > 1 ? ss : 1;
				const totalScale = effScale * pngSsScale;
				if (totalScale !== 1) {
					const scaledLabel = `vs${ei}`;
					filterGraph += `;[${inputIdx}:v]scale=iw*${totalScale}:ih*${totalScale},${alphaFmt}[${scaledLabel}]`;
					overlayInput = scaledLabel;
				} else {
					const prepLabel = `vp${ei}`;
					filterGraph += `;[${inputIdx}:v]${alphaFmt}[${prepLabel}]`;
					overlayInput = prepLabel;
				}
				filterGraph += `;[${finalLabel}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
				finalLabel = nextLabel;
			}

			// 2. Zoom chain (after all overlays — zooms the composited frame)
			for (let zi = 0; zi < clipZooms.length; zi++) {
				const isLast = zi === clipZooms.length - 1;
				const nextLabel = isLast ? 'outv' : `vz${zi}`;
				filterGraph += buildZoomFilter(finalLabel, nextLabel, clipZooms[zi], trimStart, OUT_W, OUT_H, fps);
				finalLabel = nextLabel;
			}

			if (overlappingEffects.length === 0 && !hasZoom) {
				filterGraph = filterGraph.replace('[vbase]', '[outv]');
			}

			const audioArgs = buildAudioArgs(speed);
			const gop = Math.round(fps * 2);
			const outFile = path.join(tempDir, `clip_${i}.mp4`);

			const videoArgs = buildVideoEncoderArgs(useNvenc, gop);

			await runFfmpeg([
				'-fflags', '+genpts',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				...extraInputs,
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

		clearEffectRendererCache();
		clearChatEffectCache();

		if (verticalFiles.length === 0) {
			throw new Error('All clips failed to encode — nothing to export');
		}

		onProgress(`Concatenating ${verticalFiles.length} vertical clips`, verticalClips.length, totalSteps);
		const outputPath = buildOutputPath(filename, 'mp4');
		await concatClipFiles(verticalFiles, tempDir, outputPath);

		onProgress(`Done — saved to ${outputPath}`, totalSteps, totalSteps);
		return { outputPath };
	} finally {
		cleanupTempDir(tempDir);
	}
}
