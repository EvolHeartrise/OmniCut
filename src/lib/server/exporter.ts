/**
 * Standard (16:9) video exporter.
 * Encodes clips directly from raw HLS segments on disk — no pre-encoded intermediates.
 */

import type { ClipRegion, ClipEntry, EffectEntry } from '../types.js';
import { clearEffectRendererCache } from './effectRenderer.js';
import { clearChatEffectCache } from './chatEffectRenderer.js';
import {
	resolveClip, buildOutputPath, createTempDir, cleanupTempDir,
	concatClipFiles, resolveAudioOverlays, probeVideo, detectNvenc
} from './exporterCommon.js';
import { resolveOverlappingEffects, resolveViewEffects } from './effectResolver.js';
import { encodeClip, type ExtraTrackInput } from './exporterPipeline.js';
import type { StreamLookup, ClipContext } from './exporterTypes.js';

/** A clip on a non-zero video track with its composition position. */
export interface OtherTrackClip {
	clip: ClipRegion;
	entry?: ClipEntry;
	track: number;
	compStart: number; // composition-time start (seconds)
	compEnd: number;   // composition-time end (seconds)
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
	clipEntries?: (ClipEntry | undefined)[],
	effectEntries?: EffectEntry[],
	compOffsets?: number[],
	channelMap?: Map<string, string>,
	otherTrackClips?: OtherTrackClip[]
): Promise<{ outputPath: string }> {
	if (clips.length === 0) {
		throw new Error('No clip regions to export');
	}

	const totalSteps = clips.length + 1;
	onProgress(`Starting export: ${clips.length} clips`, 0, totalSteps);

	const useNvenc = await detectNvenc();
	const tempDir = createTempDir('std');

	try {
		const clipFiles: string[] = [];
		let skipped = 0;

		for (let i = 0; i < clips.length; i++) {
			const resolved = resolveClip(
				clips[i], clipEntries?.[i], streamMap.get(clips[i].streamId),
				i, clips.length, tempDir, 'export'
			);
			if (!resolved) { skipped++; continue; }

			const { dur, segments, localStart: clipLocalStart, localEnd: clipLocalEnd } = resolved;
			onProgress(`Encoding clip ${i + 1}/${clips.length} (${dur.toFixed(1)}s)`, i, totalSteps);

			// Probe actual source resolution (no scaling in standard export)
			const probe = await probeVideo(segments[0].file);
			const srcW = probe.width || 1920;
			const srcH = probe.height || 1080;

			// Find overlapping effects for this clip
			const clipCompStart = compOffsets?.[i] ?? 0;
			const clipCompEnd = clipCompStart + dur;

			// Resolve view effects
			const clipViews = resolveViewEffects(effectEntries, clipCompStart, clipCompEnd, dur);

			const clipCtx: ClipContext | undefined = channelMap?.get(clips[i].streamId) ? {
				streamId: clips[i].streamId,
				channel: channelMap.get(clips[i].streamId)!,
				streamLocalStart: clipLocalStart,
				streamLocalEnd: clipLocalEnd
			} : undefined;

			// All overlay effects are composited after views — no pre/post-zoom split
			const allEffects = await resolveOverlappingEffects(
				effectEntries, clipCompStart, clipCompEnd, dur, tempDir, i,
				srcW, srcH, clipCtx
			);

			// Resolve audio overlays for this clip
			const audioOverlays = resolveAudioOverlays(effectEntries, clipCompStart, clipCompEnd);

			// Resolve extra track inputs for multi-track compositing
			const extraTrackInputs = resolveExtraTrackInputs(
				otherTrackClips, clipCompStart, clipCompEnd, streamMap, tempDir, i, 'export'
			);

			const outFile = await encodeClip({
				resolved, clipIdx: i,
				outW: srcW, outH: srcH, srcW, srcH,
				fps: probe.fps > 0 ? probe.fps : 30,
				allEffects, clipViews, audioOverlays,
				useNvenc, tempDir,
				extraOutputArgs: ['-video_track_timescale', '90000'],
				logTag: 'export',
				extraTrackInputs
			});

			clipFiles.push(outFile);
		}

		clearEffectRendererCache();
		clearChatEffectCache();

		if (clipFiles.length === 0) {
			throw new Error('All clips failed to encode — nothing to export');
		}

		const outputPath = buildOutputPath(filename, 'mp4');

		if (clipFiles.length > 1) {
			const skipMsg = skipped > 0 ? ` (${skipped} skipped)` : '';
			onProgress(`Concatenating ${clipFiles.length} clips${skipMsg}`, clips.length, totalSteps);
		}

		await concatClipFiles(clipFiles, tempDir, outputPath);

		onProgress(`Done — saved to ${outputPath}`, totalSteps, totalSteps);
		return { outputPath };
	} finally {
		cleanupTempDir(tempDir);
	}
}

/**
 * Find other-track clips that overlap a track 0 clip's composition window
 * and resolve them into ExtraTrackInput entries for FFmpeg.
 */
function resolveExtraTrackInputs(
	otherTrackClips: OtherTrackClip[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	streamMap: Map<string, StreamLookup>,
	tempDir: string,
	clipIdx: number,
	tag: string
): ExtraTrackInput[] | undefined {
	if (!otherTrackClips || otherTrackClips.length === 0) return undefined;

	const overlapping = otherTrackClips.filter(
		(o) => o.compStart < clipCompEnd && o.compEnd > clipCompStart
	);
	if (overlapping.length === 0) return undefined;

	const results: ExtraTrackInput[] = [];
	for (const otc of overlapping) {
		const resolved = resolveClip(
			otc.clip, otc.entry, streamMap.get(otc.clip.streamId),
			clipIdx, 1, tempDir, `${tag}-track${otc.track}`
		);
		if (!resolved) continue;

		// Compute the overlap portion in composition time
		const overlapStart = Math.max(clipCompStart, otc.compStart);
		const overlapEnd = Math.min(clipCompEnd, otc.compEnd);
		const otcSourceOffset = overlapStart - otc.compStart;
		const seekOffset = resolved.trimStart + otcSourceOffset;
		const dur = overlapEnd - overlapStart;

		results.push({
			track: otc.track,
			concatPath: resolved.concatPath,
			seekOffset,
			dur,
			clipOffset: overlapStart - clipCompStart,
		});
	}

	return results.length > 0 ? results : undefined;
}
