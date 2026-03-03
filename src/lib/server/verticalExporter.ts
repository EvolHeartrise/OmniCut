/**
 * Vertical (9:16) video exporter for mobile short-form content.
 * Uses view effects for composition — crops source regions and places them on a 1080x1920 canvas.
 * Encodes directly from raw HLS segments — no pre-encoded intermediates.
 */

import type { ClipRegion, CameraBoundsEntry, ClipEntry, EffectEntry } from '../types.js';
import { clearEffectRendererCache } from './effectRenderer.js';
import { clearChatEffectCache } from './chatEffectRenderer.js';
import {
	resolveClip, buildOutputPath, createTempDir, cleanupTempDir,
	concatClipFiles, resolveAudioOverlays, detectNvenc,
	resolveExtraTrackInputs
} from './exporterCommon.js';
import { probeMedia } from './ffmpeg.js';
import { resolveOverlappingEffects, resolveViewEffects } from './effectResolver.js';
import { encodeClip } from './exporterPipeline.js';
import type { StreamLookup, ClipContext, OtherTrackClip } from './exporterTypes.js';

// Output dimensions
const OUT_W = 1080;
const OUT_H = 1920;

/** A clip with its resolved camera bounds for vertical export. */
export interface VerticalClip {
	clip: ClipRegion;
	cam: CameraBoundsEntry | null;
	entry?: ClipEntry;
}

/**
 * Export clips as a vertical 9:16 video using view effects for composition.
 * Views define source crops and destination rects on the 1080x1920 canvas.
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
	otherTrackClips?: OtherTrackClip[]
): Promise<{ outputPath: string }> {
	if (verticalClips.length === 0) {
		throw new Error('No clips to export');
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

			const { dur, localStart: clipLocalStart, localEnd: clipLocalEnd } = resolved;
			onProgress(`Encoding clip ${i + 1}/${verticalClips.length} as vertical (${dur.toFixed(1)}s)`, i, totalSteps);

			// Probe source resolution from mp4
			const probe = await probeMedia(resolved.mp4Path);
			if (probe.width === 0 || probe.height === 0) {
				console.warn(`[vertical-export] Skipping clip ${i + 1} (probe failed)`);
				continue;
			}

			// Find overlapping effects for this clip
			const clipCompStart = compOffsets?.[i] ?? 0;
			const clipCompEnd = clipCompStart + dur;

			// Resolve view effects
			const clipViews = resolveViewEffects(effectEntries, clipCompStart, clipCompEnd, dur);

			// Resolve camera bounds for view effects with 'camera' source type
			const camBounds = cam ? { camX: cam.camX, camY: cam.camY, camW: cam.camW, camH: cam.camH } : null;

			// Resolve audio overlays for this clip
			const audioOverlays = resolveAudioOverlays(effectEntries, clipCompStart, clipCompEnd);

			const clipCtx: ClipContext | undefined = channelMap?.get(clip.streamId) ? {
				streamId: clip.streamId,
				channel: channelMap.get(clip.streamId)!,
				streamLocalStart: clipLocalStart,
				streamLocalEnd: clipLocalEnd
			} : undefined;

			// All overlay effects composited after view composition
			const allEffects = await resolveOverlappingEffects(
				effectEntries, clipCompStart, clipCompEnd, dur, tempDir, i,
				OUT_W, OUT_H, clipCtx
			);

			const fps = probe.fps > 0 ? probe.fps : 30;

			// When no views, scale full frame to fill vertical canvas (legacy fallback)
			const baseVideoFilter = clipViews.length === 0
				? `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},format=yuv420p`
				: undefined;

			// Resolve extra track inputs for multi-track compositing
			const extraTrackInputs = resolveExtraTrackInputs(
				otherTrackClips, clipCompStart, clipCompEnd, streamMap, tempDir, i, 'vertical-export'
			);

			const outFile = await encodeClip({
				resolved, clipIdx: i,
				outW: OUT_W, outH: OUT_H,
				srcW: probe.width, srcH: probe.height, fps,
				allEffects, clipViews, audioOverlays, camBounds,
				useNvenc, tempDir, baseVideoFilter,
				gop: Math.round(fps * 2),
				extraOutputArgs: ['-r', `${fps}`],
				audioMapFallback: '0:a?',
				logTag: 'vertical-export',
				extraTrackInputs
			});

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
