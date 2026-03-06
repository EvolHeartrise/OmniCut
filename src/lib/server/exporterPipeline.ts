/**
 * Shared per-clip encoding pipeline.
 * Used by both standard and vertical exporters to deduplicate the FFmpeg encoding logic.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ResolvedEffect, ResolvedView, ResolvedZoomPan } from './exporterTypes.js';
import type { ResolvedClip, ResolvedAudioOverlay } from './exporterCommon.js';
import { buildVideoEncoderArgs, buildAudioMixFilter } from './exporterCommon.js';
import { buildViewFilter } from './viewFilter.js';
import { buildAnimatedOverlay } from './overlayAnimation.js';
import { buildZoomPanFilter } from './zoomPanFilter.js';
import { runFfmpeg, spawnFfmpegWithPipe } from './ffmpeg.js';

/** Extra video track input for multi-track compositing. */
export interface ExtraTrackInput {
	track: number;
	mp4Path: string;
	seekOffset: number;
	dur: number;
	/** Offset from the start of the current clip's composition window (seconds). */
	clipOffset: number;
}

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
	/** Resolved zoom-pan effects */
	clipZoomPans?: ResolvedZoomPan[];
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
	/** Extra track inputs for multi-track compositing */
	extraTrackInputs?: ExtraTrackInput[];
	/** Silence windows: time ranges where source audio should be muted */
	silenceWindows?: { localStart: number; localEnd: number }[];
}

/**
 * Build FFmpeg volume filter expressions that mute audio during silence windows.
 * Each window produces a volume=enable='between(t,T0,T1)':volume=0 segment.
 */
function buildSilenceFilter(
	windows: { localStart: number; localEnd: number }[],
	trimStart: number
): string {
	return windows
		.map(w => `volume=enable='between(t,${(trimStart + w.localStart).toFixed(3)},${(trimStart + w.localEnd).toFixed(3)})':volume=0`)
		.join(',');
}

/**
 * Encode a single clip with overlays, views, and audio mixing.
 * Returns the output file path.
 */
export async function encodeClip(opts: ClipEncodeOptions): Promise<string> {
	const {
		resolved, clipIdx, outW, outH, srcW, srcH, fps,
		allEffects, clipViews, clipZoomPans, audioOverlays, camBounds,
		useNvenc, tempDir, baseVideoFilter, gop,
		extraOutputArgs, audioMapFallback, logTag,
		extraTrackInputs, silenceWindows
	} = opts;

	const { dur, seekOffset, mp4Path } = resolved;
	// Use input seeking (-ss before -i) so the filter graph PTS starts from ~0
	// and the output file has PTS starting from 0. This prevents edit-list
	// misalignment that causes black frames at concat boundaries.
	const trimStart = 0;
	const tag = logTag ?? 'export';
	const outFile = path.join(tempDir, `clip_${clipIdx}.mp4`);

	const extraInputs: string[] = [];
	let videoFilterArgs: string[];
	const hasOverlays = allEffects.length > 0;
	const hasViews = clipViews.length > 0;
	const hasZoomPans = clipZoomPans && clipZoomPans.length > 0;
	const hasExtraTracks = extraTrackInputs && extraTrackInputs.length > 0;
	let pipeEffect: ResolvedEffect | null = null;

	// --- Build extra track inputs (inserted before overlay inputs) ---
	const trackCount = hasExtraTracks ? extraTrackInputs.length : 0;
	let trackInputLabels: Map<number, string> | undefined;

	if (hasExtraTracks) {
		trackInputLabels = new Map<number, string>();
		trackInputLabels.set(0, 'base');

		for (let ti = 0; ti < extraTrackInputs.length; ti++) {
			const et = extraTrackInputs[ti];
			extraInputs.push(
				'-ss', et.seekOffset.toFixed(3),
				'-t', et.dur.toFixed(3),
				'-i', et.mp4Path
			);
			trackInputLabels.set(et.track, `t${et.track}`);
		}
	}

	if (hasOverlays || hasViews || hasZoomPans || hasExtraTracks) {
		if (allEffects.length > 0) {
			console.log(`[${tag}] Clip ${clipIdx}: ${allEffects.length} overlay(s), ${clipViews.length} views, ${trackCount} extra tracks, ss=${seekOffset.toFixed(3)} t=${dur.toFixed(3)}`);
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

		// Reset PTS to start at exactly 0 so overlay enable windows and the
		// color=black canvas (PTS=0) align with the video frames.
		// Audio is also PTS-reset in the filter graph to stay in sync.
		let filterGraph: string;
		let prevLabel: string;

		if (baseVideoFilter) {
			// Caller-provided base filter (e.g. vertical no-views: scale+crop)
			filterGraph = `[0:v]${baseVideoFilter}[base]`;
			prevLabel = 'base';
		} else {
			filterGraph = `[0:v]setpts=PTS-STARTPTS,format=yuv420p[base]`;
			prevLabel = 'base';
		}

		// Format-convert extra track inputs: [N:v] -> setpts/speed, format -> [tN]
		if (hasExtraTracks) {
			for (let ti = 0; ti < extraTrackInputs.length; ti++) {
				const et = extraTrackInputs[ti];
				// Extra track inputs start at index 1 (index 0 is track 0 concat)
				const inputIdx = 1 + ti;
				// Offset PTS by clipOffset so the first frame's PTS matches the
				// composition position where the overlay enable window starts.
				// This keeps extra-track video in sync with its adelay'd audio.
				const offset = et.clipOffset > 0 ? `+${et.clipOffset.toFixed(3)}` : '';
				filterGraph += `;[${inputIdx}:v]setpts=PTS-STARTPTS${offset},format=yuv420p[t${et.track}]`;
			}
		}

		// 1. View composition
		const viewFps = fps > 0 ? fps : 30;
		if (hasViews) {
			const viewFilter = buildViewFilter(
				'base', 'viewed', clipViews, trimStart, srcW, srcH, outW, outH, viewFps, camBounds, trackInputLabels
			);
			filterGraph += viewFilter;
			prevLabel = 'viewed';
		}

		// 2. Overlay chain — split around zoom-pan if needed
		const overlayInputOffset = 1 + trackCount;
		const hasZoomPan = clipZoomPans && clipZoomPans.length > 0;

		// Split overlays into pre-zoom (default) and post-zoom groups
		const preZoomEffects: { eff: ResolvedEffect; idx: number }[] = [];
		const postZoomEffects: { eff: ResolvedEffect; idx: number }[] = [];
		for (let ei = 0; ei < allEffects.length; ei++) {
			if (hasZoomPan && allEffects[ei].drawAfterZoom) {
				postZoomEffects.push({ eff: allEffects[ei], idx: ei });
			} else {
				preZoomEffects.push({ eff: allEffects[ei], idx: ei });
			}
		}

		// Helper to build overlay chain for a group of effects
		const buildOverlayChain = (
			effects: { eff: ResolvedEffect; idx: number }[],
			startLabel: string,
			endLabel: string,
			labelPrefix: string
		) => {
			let prev = startLabel;
			for (let i = 0; i < effects.length; i++) {
				const { eff, idx: ei } = effects[i];
				const inputIdx = overlayInputOffset + ei;
				const isLast = i === effects.length - 1;
				const nextLabel = isLast ? endLabel : `${labelPrefix}${i}`;
				const enableStart = (trimStart + eff.localStart).toFixed(3);
				const enableEnd = (trimStart + eff.localEnd + 1 / fps).toFixed(3);
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
						overlayInput, prev, nextLabel,
						ox, oy, parseFloat(enableStart), parseFloat(enableEnd),
						eff.animation, 1
					);
					filterGraph += overlayExpr;
				} else {
					filterGraph += `;[${prev}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
				}
				prev = nextLabel;
			}
			return prev;
		};

		if (hasZoomPan) {
			// Pre-zoom overlays → zoom-pan → post-zoom overlays
			const preLabel = preZoomEffects.length > 0 ? 'prezp' : prevLabel;
			if (preZoomEffects.length > 0) {
				buildOverlayChain(preZoomEffects, prevLabel, preLabel, 'pv');
			}

			// Zoom-pan filter
			const zpOutLabel = postZoomEffects.length > 0 ? 'zp' : 'outv';
			const zpFilter = buildZoomPanFilter(preLabel, zpOutLabel, clipZoomPans!, outW, outH, trimStart, fps);
			if (zpFilter) {
				filterGraph += zpFilter;
			} else {
				// No actual zoom-pan filters generated (all no-ops) — rename
				if (zpOutLabel !== preLabel) {
					filterGraph += `;[${preLabel}]null[${zpOutLabel}]`;
				}
			}
			prevLabel = zpOutLabel;

			// Post-zoom overlays
			if (postZoomEffects.length > 0) {
				prevLabel = buildOverlayChain(postZoomEffects, zpOutLabel, 'outv', 'pzv');
			}
		} else {
			// No zoom-pan: single overlay chain (original behavior)
			const allFx = allEffects.map((eff, idx) => ({ eff, idx }));
			if (allFx.length > 0) {
				prevLabel = buildOverlayChain(allFx, prevLabel, 'outv', 'v');
			}
		}

		// If nothing produced outv, rename
		if (prevLabel !== 'outv') {
			// Replace last occurrence of [prevLabel] at the end of a filter segment
			const lastIdx = filterGraph.lastIndexOf(`[${prevLabel}]`);
			if (lastIdx >= 0) {
				filterGraph = filterGraph.substring(0, lastIdx) + '[outv]' + filterGraph.substring(lastIdx + prevLabel.length + 2);
			}
		}

		if (allEffects.length > 0 || hasViews || hasZoomPans || hasExtraTracks) {
			console.log(`[${tag}]   filter_complex: ${filterGraph}`);
		}

		// Audio overlay mixing
		const audioNextIdx = overlayInputOffset + allEffects.length;
		const audioMix = buildAudioMixFilter(audioOverlays, audioNextIdx, dur, trimStart);
		if (audioMix.totalAudioInputs > 0) {
			extraInputs.push(...audioMix.extraInputs);
			filterGraph += ';' + audioMix.audioFilterGraph;
		}

		// Audio mapping: use track 0 audio only (extra tracks are video-only).
		// Extra track inputs provide video for view compositing; their audio
		// would overlap/echo track 0's audio since they often come from the
		// same or overlapping source streams.
		const hasSilence = silenceWindows && silenceWindows.length > 0;

		// Inject silence filters into source audio before mix
		if (hasSilence && audioMix.totalAudioInputs > 0) {
			const sf = buildSilenceFilter(silenceWindows, trimStart);
			audioMix.audioFilterGraph = audioMix.audioFilterGraph.replace(
				'asetpts=PTS-STARTPTS[asrc]',
				`asetpts=PTS-STARTPTS,${sf}[asrc]`
			);
		}

		let audioMap: string[];
		if (audioMix.totalAudioInputs > 0) {
			audioMap = ['-map', `[${audioMix.audioOutLabel}]`];
		} else if (audioMapFallback === '0:a?') {
			if (hasSilence) {
				// Silence needs filter_complex — route audio through it
				const sf = buildSilenceFilter(silenceWindows, trimStart);
				filterGraph += `;[0:a]asetpts=PTS-STARTPTS,${sf}[aout0]`;
				audioMap = ['-map', '[aout0]'];
			} else {
				// Optional audio (vertical exporter) — use direct mapping since
				// the stream may not have audio and filter_complex can't handle '?'.
				audioMap = ['-map', '0:a?'];
			}
		} else {
			// Route audio through filter_complex with PTS reset to match
			// video PTS-STARTPTS (no audio overlays, no extra tracks).
			const sf = hasSilence ? `,${buildSilenceFilter(silenceWindows, trimStart)}` : '';
			filterGraph += `;[0:a]asetpts=PTS-STARTPTS${sf}[aout0]`;
			audioMap = ['-map', '[aout0]'];
		}

		videoFilterArgs = [
			'-filter_complex', filterGraph,
			'-map', '[outv]',
			...audioMap,
			...buildVideoEncoderArgs(useNvenc, gop)
		];
	} else {
		// No overlays or views
		const hasSilence = silenceWindows && silenceWindows.length > 0;

		if (audioOverlays.length > 0) {
			// Need filter_complex for audio mixing even without video overlays
			const audioMix = buildAudioMixFilter(audioOverlays, 1, dur, trimStart);
			if (hasSilence) {
				const sf = buildSilenceFilter(silenceWindows, trimStart);
				audioMix.audioFilterGraph = audioMix.audioFilterGraph.replace(
					'asetpts=PTS-STARTPTS[asrc]',
					`asetpts=PTS-STARTPTS,${sf}[asrc]`
				);
			}
			extraInputs.push(...audioMix.extraInputs);
			const fullFilter = `[0:v]format=yuv420p[outv];${audioMix.audioFilterGraph}`;
			videoFilterArgs = [
				'-filter_complex', fullFilter,
				'-map', '[outv]', '-map', `[${audioMix.audioOutLabel}]`,
				...buildVideoEncoderArgs(useNvenc, gop)
			];
		} else if (hasSilence) {
			// Need filter_complex for silence even without overlays
			const sf = buildSilenceFilter(silenceWindows, trimStart);
			const fullFilter = `[0:v]format=yuv420p[outv];[0:a]asetpts=PTS-STARTPTS,${sf}[aout0]`;
			videoFilterArgs = [
				'-filter_complex', fullFilter,
				'-map', '[outv]', '-map', '[aout0]',
				...buildVideoEncoderArgs(useNvenc, gop)
			];
		} else {
			videoFilterArgs = [
				'-vf', 'format=yuv420p',
				'-map', '0:v:0', '-map', audioMapFallback ?? '0:a:0',
				...buildVideoEncoderArgs(useNvenc, gop)
			];
		}
	}

	const ffmpegArgs = [
		// Input options: seek + limit reading on the mp4 source.
		// Input seeking rebases PTS to ~0, avoiding edit-list issues during concat.
		'-ss', seekOffset.toFixed(3),
		'-t', dur.toFixed(3),
		'-i', mp4Path,
		...extraInputs,
		...videoFilterArgs,
		// Output -t prevents the color source (d=999) from extending past the clip.
		'-t', dur.toFixed(3),
		'-fps_mode', 'cfr',
		...(extraOutputArgs ?? []),
		'-c:a', 'aac', '-ar', '48000', '-b:a', '192k',
		'-movflags', '+faststart',
		'-y', outFile
	];

	if (pipeEffect?.deferredRender) {
		// Stream raw RGBA frames to FFmpeg via ReadableStream-backed stdin.
		// This avoids Bun's FileSink which triggers uncatchable EPIPE crashes
		// when FFmpeg closes its stdin after receiving enough frames.
		const handle = spawnFfmpegWithPipe(ffmpegArgs);

		let renderError: Error | null = null;
		try {
			await pipeEffect.deferredRender(handle.sink);
		} catch (err) {
			renderError = err instanceof Error ? err : new Error(String(err));
		}

		await handle.closeStdin();

		try {
			await handle.waitForExit(4000);
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
