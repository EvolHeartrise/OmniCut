/**
 * Shared per-clip encoding pipeline.
 * Used by both standard and vertical exporters to deduplicate the FFmpeg encoding logic.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ResolvedEffect, ResolvedView } from './exporterTypes.js';
import type { ResolvedClip, ResolvedAudioOverlay } from './exporterCommon.js';
import { buildAudioArgs, buildVideoEncoderArgs, buildAudioMixFilter } from './exporterCommon.js';
import { buildViewFilter } from './viewFilter.js';
import { buildAnimatedOverlay } from './overlayAnimation.js';
import { runFfmpeg, spawnFfmpegWithPipe } from './ffmpeg.js';
import type { FrameSink } from './chatEffectRenderer.js';

export interface ClipEncodeOptions {
	/** Resolved clip metadata */
	resolved: ResolvedClip;
	/** Index of this clip (for file naming / logging) */
	clipIdx: number;
	/** Output video dimensions */
	outW: number;
	outH: number;
	/** Source video dimensions (probed) */
	srcW: number;
	srcH: number;
	/** Source fps (probed) */
	fps: number;
	/** Resolved overlay effects */
	allEffects: ResolvedEffect[];
	/** Resolved view effects */
	clipViews: ResolvedView[];
	/** Resolved audio overlays */
	audioOverlays: ResolvedAudioOverlay[];
	/** Camera bounds for view effects (vertical only) */
	camBounds?: { camX: number; camY: number; camW: number; camH: number } | null;
	/** Use NVENC hardware encoding */
	useNvenc: boolean;
	/** Temp directory for intermediate files */
	tempDir: string;
	/** Base video filter before views/overlays (e.g. scale+crop for vertical no-views fallback) */
	baseVideoFilter?: string;
	/** Optional GOP (keyframe interval) */
	gop?: number;
	/** Extra output flags (e.g. -r fps) */
	extraOutputArgs?: string[];
	/** Audio map fallback when no audio mix ('0:a:0' vs '0:a?') */
	audioMapFallback?: string;
	/** Log tag prefix for console output */
	logTag?: string;
}

/**
 * Encode a single clip with overlays, views, and audio mixing.
 * Returns the output file path.
 */
export async function encodeClip(opts: ClipEncodeOptions): Promise<string> {
	const {
		resolved, clipIdx, outW, outH, srcW, srcH, fps,
		allEffects, clipViews, audioOverlays, camBounds,
		useNvenc, tempDir, baseVideoFilter, gop,
		extraOutputArgs, audioMapFallback, logTag
	} = opts;

	const { dur, clipDur, speed, trimStart, concatPath } = resolved;
	const tag = logTag ?? 'export';
	const outFile = path.join(tempDir, `clip_${clipIdx}.mp4`);

	const extraInputs: string[] = [];
	let videoFilterArgs: string[];
	const hasOverlays = allEffects.length > 0;
	const hasViews = clipViews.length > 0;
	let pipeEffect: ResolvedEffect | null = null;

	if (hasOverlays || hasViews) {
		if (allEffects.length > 0) {
			console.log(`[${tag}] Clip ${clipIdx}: ${allEffects.length} overlay(s), ${clipViews.length} views, ss=${trimStart.toFixed(3)} t=${dur.toFixed(3)} speed=${speed}`);
			for (const eff of allEffects) {
				console.log(`[${tag}]   overlay: pos=(${eff.x},${eff.y}) local=[${eff.localStart.toFixed(3)},${eff.localEnd.toFixed(3)}] raw=${!!eff.rawVideo} piped=${!!eff.deferredRender}`);
			}
		}

		// Pick at most ONE deferred-render effect to pipe via stdin.
		for (const eff of allEffects) {
			if (eff.rawVideo && eff.deferredRender) {
				if (!pipeEffect) {
					pipeEffect = eff;
				} else {
					const rawPath = path.join(tempDir, `chatfx_fallback_${clipIdx}_${allEffects.indexOf(eff)}.rgba`);
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

		const speedFilter = speed !== 1 ? `setpts=PTS/${speed},` : '';
		let filterGraph: string;
		let prevLabel: string;

		if (baseVideoFilter) {
			// Caller-provided base filter (e.g. vertical no-views: scale+crop)
			filterGraph = `[0:v]${baseVideoFilter}[base]`;
			prevLabel = 'base';
		} else {
			filterGraph = `[0:v]${speedFilter}format=yuv420p[base]`;
			prevLabel = 'base';
		}

		// 1. View composition
		const viewFps = fps > 0 ? fps : 30;
		if (hasViews) {
			const viewFilter = buildViewFilter(
				'base', 'viewed', clipViews, trimStart, srcW, srcH, outW, outH, viewFps, camBounds
			);
			filterGraph += viewFilter;
			prevLabel = 'viewed';
		}

		// 2. Overlay chain (all overlays composited after views)
		for (let ei = 0; ei < allEffects.length; ei++) {
			const eff = allEffects[ei];
			const inputIdx = ei + 1;
			const isLast = ei === allEffects.length - 1;
			const nextLabel = isLast ? 'outv' : `v${ei}`;
			const enableStart = (trimStart + eff.localStart).toFixed(3);
			const enableEnd = (trimStart + eff.localEnd).toFixed(3);
			const alphaFmt = 'format=yuva420p';
			const ox = eff.x;
			const oy = eff.y;
			let overlayInput: string;
			const effScale = (eff.scale && eff.scale !== 1) ? eff.scale : 1;
			if (effScale !== 1) {
				const scaledLabel = `s${ei}`;
				filterGraph += `;[${inputIdx}:v]scale=iw*${effScale}:ih*${effScale},${alphaFmt}[${scaledLabel}]`;
				overlayInput = scaledLabel;
			} else {
				const prepLabel = `p${ei}`;
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

		// If nothing produced outv, rename
		if (prevLabel === 'base' || prevLabel === 'viewed') {
			filterGraph = filterGraph.replace(`[${prevLabel}]`, '[outv]');
		}

		if (allEffects.length > 0 || hasViews) {
			console.log(`[${tag}]   filter_complex: ${filterGraph}`);
		}

		// Audio overlay mixing
		const audioNextIdx = 1 + allEffects.length;
		const audioMix = buildAudioMixFilter(audioOverlays, audioNextIdx, speed, clipDur, trimStart);
		if (audioMix.totalAudioInputs > 0) {
			extraInputs.push(...audioMix.extraInputs);
			filterGraph += ';' + audioMix.audioFilterGraph;
		}

		const audioMap = audioMix.totalAudioInputs > 0
			? ['-map', `[${audioMix.audioOutLabel}]`]
			: ['-map', audioMapFallback ?? '0:a:0'];

		videoFilterArgs = [
			'-filter_complex', filterGraph,
			'-map', '[outv]',
			...audioMap,
			...buildVideoEncoderArgs(useNvenc, gop)
		];
	} else {
		// No overlays or views
		const audioArgs = buildAudioArgs(speed);
		const vFilters: string[] = [];
		if (speed !== 1) vFilters.push(`setpts=PTS/${speed}`);
		vFilters.push('format=yuv420p');

		if (audioOverlays.length > 0) {
			// Need filter_complex for audio mixing even without video overlays
			const audioMix = buildAudioMixFilter(audioOverlays, 1, speed, clipDur, trimStart);
			extraInputs.push(...audioMix.extraInputs);
			const fullFilter = `[0:v]${vFilters.join(',')}[outv];${audioMix.audioFilterGraph}`;
			videoFilterArgs = [
				'-filter_complex', fullFilter,
				'-map', '[outv]', '-map', `[${audioMix.audioOutLabel}]`,
				...buildVideoEncoderArgs(useNvenc, gop)
			];
		} else {
			videoFilterArgs = [
				'-vf', vFilters.join(','),
				'-map', '0:v:0', '-map', audioMapFallback ?? '0:a:0',
				...buildVideoEncoderArgs(useNvenc, gop)
			];
		}
	}

	// When using audio filter_complex, skip -af args (already handled in filter graph)
	const hasAudioMix = audioOverlays.length > 0;
	const audioArgs = buildAudioArgs(speed);

	const ffmpegArgs = [
		'-fflags', '+genpts',
		'-f', 'concat', '-safe', '0', '-i', concatPath,
		...extraInputs,
		'-ss', trimStart.toFixed(3),
		'-t', dur.toFixed(3),
		...videoFilterArgs,
		'-fps_mode', 'cfr',
		...(extraOutputArgs ?? []),
		...(hasAudioMix ? ['-c:a', 'aac', '-ar', '48000', '-b:a', '192k'] : audioArgs),
		'-movflags', '+faststart',
		'-y', outFile
	];

	if (pipeEffect?.deferredRender) {
		// Stream raw RGBA frames directly to FFmpeg stdin
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
			if (renderError) console.warn(`[${tag}] Render also failed:`, renderError.message);
			throw ffmpegErr;
		}
		if (renderError) throw renderError;
	} else {
		await runFfmpeg(ffmpegArgs, 2000);
	}

	return outFile;
}
