/**
 * Vertical (9:16) video exporter for mobile short-form content.
 * Uses view effects for composition — crops source regions and places them on a 1080x1920 canvas.
 * Encodes directly from raw HLS segments — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, CameraBoundsEntry, ClipEntry, EffectEntry } from '../types.js';
import { runFfmpeg, spawnFfmpegWithPipe } from './ffmpeg.js';
import {
	detectNvenc, probeVideo, resolveOverlappingEffects, resolveViewEffects,
	buildViewFilter, buildAnimatedOverlay,
	type StreamLookup, type ClipContext, type ResolvedEffect
} from './exporter.js';
import { clearEffectRendererCache } from './effectRenderer.js';
import { clearChatEffectCache, type FrameSink } from './chatEffectRenderer.js';
import {
	resolveClip, buildAudioArgs, buildVideoEncoderArgs, createTempDir, cleanupTempDir,
	concatClipFiles, buildOutputPath, resolveAudioOverlays, buildAudioMixFilter
} from './exporterCommon.js';

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
	channelMap?: Map<string, string>
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

			const { dur, clipDur, speed, trimStart, concatPath, segments, localStart: clipLocalStart, localEnd: clipLocalEnd } = resolved;
			onProgress(`Encoding clip ${i + 1}/${verticalClips.length} as vertical (${dur.toFixed(1)}s)`, i, totalSteps);

			// Probe source resolution from first segment
			const probe = await probeVideo(segments[0].file);
			if (probe.width === 0 || probe.height === 0) {
				console.warn(`[vertical-export] Skipping clip ${i + 1} (probe failed)`);
				continue;
			}

			// Find overlapping effects for this clip
			const clipCompStart = compOffsets?.[i] ?? 0;
			const clipCompEnd = clipCompStart + clipDur;

			// Resolve view effects
			const clipViews = resolveViewEffects(effectEntries, clipCompStart, clipCompEnd, clipDur);

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
			const overlayEffects = await resolveOverlappingEffects(
				effectEntries, clipCompStart, clipCompEnd, clipDur, tempDir, i,
				OUT_W, OUT_H, clipCtx
			);

			const allEffects = overlayEffects;
			const extraInputs: string[] = [];

			// Pick at most ONE deferred-render effect to pipe via stdin.
			let pipeEffect: ResolvedEffect | null = null;
			for (const eff of allEffects) {
				if (eff.rawVideo && eff.deferredRender) {
					if (!pipeEffect) {
						pipeEffect = eff;
					} else {
						const rawPath = path.join(tempDir, `chatfx_fallback_${i}_${allEffects.indexOf(eff)}.rgba`);
						const fd = fs.openSync(rawPath, 'w');
						try {
							await eff.deferredRender({
								write(buf: Buffer) { fs.writeSync(fd, buf); },
								async flush() {}
							});
						} finally { fs.closeSync(fd); }
						eff.videoPath = rawPath;
						eff.deferredRender = undefined;
					}
				}
			}

			for (const eff of allEffects) {
				const itsoffset = ['-itsoffset', (trimStart + eff.localStart).toFixed(3)];
				if (eff.rawVideo) {
					extraInputs.push(
						...itsoffset,
						'-f', 'rawvideo', '-pix_fmt', 'rgba',
						'-s', `${eff.rawVideo.width}x${eff.rawVideo.height}`,
						'-r', `${eff.rawVideo.fps}`,
						'-i', eff.deferredRender ? 'pipe:0' : eff.videoPath!
					);
				} else if (eff.animation) {
					extraInputs.push(
						...itsoffset,
						'-loop', '1', '-framerate', '30',
						'-i', eff.pngPath!
					);
				} else {
					extraInputs.push(...itsoffset, '-i', eff.videoPath ?? eff.pngPath!);
				}
			}

			// Build filter graph
			const speedFilter = speed !== 1 ? `,setpts=PTS/${speed}` : '';
			const fps = probe.fps > 0 ? probe.fps : 30;

			let filterGraph: string;
			let prevLabel: string;

			if (clipViews.length > 0) {
				// View-based composition: build canvas from view effects
				filterGraph = `[0:v]format=yuv420p${speedFilter}[src]`;
				const viewFilter = buildViewFilter(
					'src', 'viewed', clipViews, trimStart,
					probe.width, probe.height, OUT_W, OUT_H, fps, camBounds
				);
				filterGraph += viewFilter;
				prevLabel = 'viewed';
			} else {
				// No views: scale full frame to fill vertical canvas (legacy fallback)
				filterGraph = `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}${speedFilter},format=yuv420p[viewed]`;
				prevLabel = 'viewed';
			}

			// Overlay chain (all overlays composited after views)
			for (let ei = 0; ei < allEffects.length; ei++) {
				const eff = allEffects[ei];
				const inputIdx = ei + 1;
				const isLast = ei === allEffects.length - 1;
				const nextLabel = isLast ? 'outv' : `ov${ei}`;
				const enableStart = (trimStart + eff.localStart).toFixed(3);
				const enableEnd = (trimStart + eff.localEnd).toFixed(3);
				const alphaFmt = 'format=yuva420p';
				const ox = eff.x;
				const oy = eff.y;
				let overlayInput: string;
				const effScale = (eff.scale && eff.scale !== 1) ? eff.scale : 1;
				if (effScale !== 1) {
					const scaledLabel = `vs${ei}`;
					filterGraph += `;[${inputIdx}:v]scale=iw*${effScale}:ih*${effScale},${alphaFmt}[${scaledLabel}]`;
					overlayInput = scaledLabel;
				} else {
					const prepLabel = `vp${ei}`;
					filterGraph += `;[${inputIdx}:v]${alphaFmt}[${prepLabel}]`;
					overlayInput = prepLabel;
				}
				if (eff.animation) {
					const overlayExpr = buildAnimatedOverlay(
						overlayInput, prevLabel, nextLabel,
						ox, oy, parseFloat(enableStart), parseFloat(enableEnd),
						eff.animation, 1
					);
					filterGraph += overlayExpr;
				} else {
					filterGraph += `;[${prevLabel}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
				}
				prevLabel = nextLabel;
			}

			if (allEffects.length === 0) {
				filterGraph = filterGraph.replace(`[${prevLabel}]`, '[outv]');
			}

			const audioArgs = buildAudioArgs(speed);
			const gop = Math.round(fps * 2);
			const outFile = path.join(tempDir, `clip_${i}.mp4`);

			const videoArgs = buildVideoEncoderArgs(useNvenc, gop);

			// Audio overlay mixing
			const audioNextIdx = 1 + allEffects.length;
			const audioMix = buildAudioMixFilter(audioOverlays, audioNextIdx, speed, clipDur, trimStart);
			if (audioMix.totalAudioInputs > 0) {
				extraInputs.push(...audioMix.extraInputs);
				filterGraph += ';' + audioMix.audioFilterGraph;
			}

			if (allEffects.length > 0 || clipViews.length > 0) {
				console.log(`[vertical-export] Clip ${i}: ${allEffects.length} overlay(s), ${clipViews.length} views, ss=${trimStart.toFixed(3)} t=${dur.toFixed(3)} speed=${speed}`);
				for (const eff of allEffects) {
					console.log(`[vertical-export]   overlay: pos=(${eff.x},${eff.y}) local=[${eff.localStart.toFixed(3)},${eff.localEnd.toFixed(3)}] raw=${!!eff.rawVideo} piped=${!!eff.deferredRender}`);
				}
				console.log(`[vertical-export]   filter_complex: ${filterGraph}`);
			}

			const hasAudioMix = audioMix.totalAudioInputs > 0;

			const ffmpegArgs = [
				'-fflags', '+genpts',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				...extraInputs,
				'-ss', trimStart.toFixed(3),
				'-t', dur.toFixed(3),
				'-filter_complex', filterGraph,
				'-map', '[outv]',
				...(hasAudioMix ? ['-map', `[${audioMix.audioOutLabel}]`] : ['-map', '0:a?']),
				...videoArgs,
				'-fps_mode', 'cfr',
				'-r', `${fps}`,
				...(hasAudioMix ? ['-c:a', 'aac', '-ar', '48000', '-b:a', '192k'] : audioArgs),
				'-movflags', '+faststart',
				'-y', outFile
			];

			if (pipeEffect?.deferredRender) {
				const handle = spawnFfmpegWithPipe(ffmpegArgs);
				const pipeSink: FrameSink = {
					write(buf: Buffer) { handle.stdin.write(buf); },
					async flush() { await handle.stdin.flush(); },
				};

				let renderError: Error | null = null;
				try {
					await pipeEffect.deferredRender(pipeSink);
				} catch (err) {
					renderError = err instanceof Error ? err : new Error(String(err));
				}

				try { handle.stdin.end(); } catch { /* pipe may already be closed */ }

				try {
					await handle.waitForExit(2000);
				} catch (ffmpegErr) {
					if (renderError) console.warn('[vertical-export] Render also failed:', renderError.message);
					throw ffmpegErr;
				}
				if (renderError) throw renderError;
			} else {
				await runFfmpeg(ffmpegArgs, 2000);
			}

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
