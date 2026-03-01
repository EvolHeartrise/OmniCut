/**
 * Vertical (9:16) video exporter for mobile short-form content.
 * Produces 1080x1920 output: gameplay (full frame) on top, cropped webcam on bottom.
 * Encodes directly from raw HLS segments — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import type { ClipRegion, CameraBoundsEntry, ClipEntry, EffectEntry, VerticalSlot, VerticalLayout } from '../types.js';
import { runFfmpeg } from './ffmpeg.js';
import { detectNvenc, probeVideo, resolveOverlappingEffects, resolveZoomEffects, buildZoomFilter, buildAnimatedOverlay, ZOOM_SUPERSAMPLE, type StreamLookup, type ClipContext } from './exporter.js';
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
	cam: CameraBoundsEntry | null;
	entry?: ClipEntry;
}

/** Build an ffmpeg filter chain for a single vertical slot. */
function buildSlotFilter(
	slot: VerticalSlot,
	inputLabel: string,
	outputLabel: string,
	slotH: number,
	cam: CameraBoundsEntry | null,
	probeW: number,
	probeH: number
): string {
	switch (slot.type) {
		case 'full':
			return `[${inputLabel}]scale=${OUT_W}:${slotH}:force_original_aspect_ratio=increase,crop=${OUT_W}:${slotH}[${outputLabel}]`;
		case 'camera': {
			const cx = Math.round(cam!.camX * probeW);
			const cy = Math.round(cam!.camY * probeH);
			const cw = Math.round(cam!.camW * probeW);
			const ch = Math.round(cam!.camH * probeH);
			return `[${inputLabel}]crop=${cw}:${ch}:${cx}:${cy},scale=${OUT_W}:-2,crop=${OUT_W}:${slotH}[${outputLabel}]`;
		}
		case 'custom': {
			const cx = Math.round((slot.cropX ?? 0) * probeW);
			const cy = Math.round((slot.cropY ?? 0) * probeH);
			const cw = Math.round((slot.cropW ?? 1) * probeW);
			const ch = Math.round((slot.cropH ?? 1) * probeH);
			return `[${inputLabel}]crop=${cw}:${ch}:${cx}:${cy},scale=${OUT_W}:-2,crop=${OUT_W}:${slotH}[${outputLabel}]`;
		}
	}
}

/** Compute the aspect ratio for a slot, used to determine its rendered height. */
function slotAspectRatio(
	slot: VerticalSlot,
	cam: CameraBoundsEntry | null,
	probeW: number,
	probeH: number
): number {
	switch (slot.type) {
		case 'camera': {
			const cw = Math.round(cam!.camW * probeW);
			const ch = Math.round(cam!.camH * probeH);
			return cw / Math.max(1, ch);
		}
		case 'custom': {
			const cw = Math.round((slot.cropW ?? 1) * probeW);
			const ch = Math.round((slot.cropH ?? 1) * probeH);
			return cw / Math.max(1, ch);
		}
		case 'full':
		default:
			return probeW / Math.max(1, probeH);
	}
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
	channelMap?: Map<string, string>,
	layout?: VerticalLayout
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

			// Resolve layout slots
			const resolvedLayout = layout ?? { top: { type: 'full' as const }, bottom: { type: 'camera' as const } };
			const topSlot = resolvedLayout.top;
			const botSlot = resolvedLayout.bottom;

			// Compute bottom slot height from its aspect ratio, capped at MAX_CAM_H
			const botAR = slotAspectRatio(botSlot, cam, probe.width, probe.height);
			let bottomH = Math.round(OUT_W / botAR);
			bottomH = Math.min(bottomH, MAX_CAM_H) & ~1;
			const topH = (OUT_H - bottomH) & ~1;

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

			// Split effects into pre-zoom (affected by zoom) and post-zoom (ignoreZoom).
			// When no zoom is present, all effects go through the normal (pre-zoom) path.
			const preZoomEntries = hasZoom
				? (effectEntries ?? []).filter(e => !e.ignoreZoom)
				: effectEntries;
			const postZoomEntries = hasZoom
				? (effectEntries ?? []).filter(e => e.type !== 'zoom' && e.ignoreZoom)
				: [];

			const preZoomEffects = await resolveOverlappingEffects(
				preZoomEntries, clipCompStart, clipCompEnd, clipDur, tempDir, i,
				OUT_W, OUT_H, clipCtx,
				hasZoom ? ZOOM_SUPERSAMPLE : 1
			);
			const postZoomEffects = postZoomEntries.length > 0 ? await resolveOverlappingEffects(
				postZoomEntries, clipCompStart, clipCompEnd, clipDur, tempDir, i,
				OUT_W, OUT_H, clipCtx, 1, 'pz_'
			) : [];

			const allEffects = [...preZoomEffects, ...postZoomEffects];

			const extraInputs: string[] = [];
			for (const eff of allEffects) {
				const itsoffset = ['-itsoffset', (trimStart + eff.localStart).toFixed(3)];
				if (eff.rawVideo) {
					extraInputs.push(
						...itsoffset,
						'-f', 'rawvideo', '-pix_fmt', 'rgba',
						'-s', `${eff.rawVideo.width}x${eff.rawVideo.height}`,
						'-r', `${eff.rawVideo.fps}`,
						'-i', eff.videoPath!
					);
				} else if (eff.animation) {
					// Animated overlay: loop the PNG as a 30fps video so fade filters work
					extraInputs.push(
						...itsoffset,
						'-loop', '1', '-framerate', '30',
						'-i', eff.pngPath!
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
				`[0:v]split=2[slot_top_src][slot_bot_src]`,
				buildSlotFilter(topSlot, 'slot_top_src', 'slot_top', topH, cam, probe.width, probe.height),
				buildSlotFilter(botSlot, 'slot_bot_src', 'slot_bot', bottomH, cam, probe.width, probe.height),
				`[slot_top][slot_bot]vstack=inputs=2${speedFilter},format=yuv420p${scaleUp}[vbase]`
			].join(';');

			let finalLabel = 'vbase';
			const fps = probe.fps > 0 ? probe.fps : 30;

			// 1. Pre-zoom overlay chain (composited at ss resolution when zoom is present)
			for (let ei = 0; ei < preZoomEffects.length; ei++) {
				const eff = preZoomEffects[ei];
				const inputIdx = ei + 1;
				const isLastBeforeZoom = ei === preZoomEffects.length - 1;
				const nextLabel = isLastBeforeZoom && !hasZoom && postZoomEffects.length === 0 ? 'outv' : `ov${ei}`;
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
				// Build overlay filter — use animated expressions for subtitle effects
				if (eff.animation) {
					const overlayExpr = buildAnimatedOverlay(
						overlayInput, finalLabel, nextLabel,
						ox, oy, parseFloat(enableStart), parseFloat(enableEnd),
						eff.animation, ss
					);
					filterGraph += overlayExpr;
				} else {
					filterGraph += `;[${finalLabel}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
				}
				finalLabel = nextLabel;
			}

			// 2. Zoom chain (after pre-zoom overlays — zooms the composited frame)
			for (let zi = 0; zi < clipZooms.length; zi++) {
				const isLast = zi === clipZooms.length - 1;
				const nextLabel = isLast && postZoomEffects.length === 0 ? 'outv' : `vz${zi}`;
				filterGraph += buildZoomFilter(finalLabel, nextLabel, clipZooms[zi], trimStart, OUT_W, OUT_H, fps);
				finalLabel = nextLabel;
			}

			// 3. Post-zoom overlay chain (ignoreZoom effects — at output resolution, no supersample)
			for (let ei = 0; ei < postZoomEffects.length; ei++) {
				const eff = postZoomEffects[ei];
				const inputIdx = preZoomEffects.length + ei + 1;
				const isLast = ei === postZoomEffects.length - 1;
				const nextLabel = isLast ? 'outv' : `vpz${ei}`;
				const enableStart = (trimStart + eff.localStart).toFixed(3);
				const enableEnd = (trimStart + eff.localEnd).toFixed(3);
				const alphaFmt = 'format=yuva420p';
				const ox = eff.x;
				const oy = eff.y;
				let overlayInput: string;
				const effScale = (eff.scale && eff.scale !== 1) ? eff.scale : 1;
				if (effScale !== 1) {
					const scaledLabel = `vps${ei}`;
					filterGraph += `;[${inputIdx}:v]scale=iw*${effScale}:ih*${effScale},${alphaFmt}[${scaledLabel}]`;
					overlayInput = scaledLabel;
				} else {
					const prepLabel = `vpp${ei}`;
					filterGraph += `;[${inputIdx}:v]${alphaFmt}[${prepLabel}]`;
					overlayInput = prepLabel;
				}
				if (eff.animation) {
					const overlayExpr = buildAnimatedOverlay(
						overlayInput, finalLabel, nextLabel,
						ox, oy, parseFloat(enableStart), parseFloat(enableEnd),
						eff.animation, 1
					);
					filterGraph += overlayExpr;
				} else {
					filterGraph += `;[${finalLabel}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
				}
				finalLabel = nextLabel;
			}

			if (allEffects.length === 0 && !hasZoom) {
				filterGraph = filterGraph.replace('[vbase]', '[outv]');
			}

			const audioArgs = buildAudioArgs(speed);
			const gop = Math.round(fps * 2);
			const outFile = path.join(tempDir, `clip_${i}.mp4`);

			const videoArgs = buildVideoEncoderArgs(useNvenc, gop);

			if (allEffects.length > 0) {
				console.log(`[vertical-export] Clip ${i}: ${preZoomEffects.length} pre-zoom + ${postZoomEffects.length} post-zoom overlay(s), ss=${trimStart.toFixed(3)} t=${dur.toFixed(3)} speed=${speed}`);
				for (const eff of allEffects) {
					console.log(`[vertical-export]   overlay: pos=(${eff.x},${eff.y}) local=[${eff.localStart.toFixed(3)},${eff.localEnd.toFixed(3)}] raw=${!!eff.rawVideo} ignoreZoom=${!!eff.ignoreZoom}`);
				}
				console.log(`[vertical-export]   filter_complex: ${filterGraph}`);
			}

			const ffmpegArgs = [
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
			];
			await runFfmpeg(ffmpegArgs, 2000);

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
