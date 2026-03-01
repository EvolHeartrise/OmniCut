/**
 * Standard (16:9) video exporter.
 * Encodes clips directly from raw HLS segments on disk — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, ClipEntry, EffectEntry, SubtitleAnimation } from '../types.js';
import { runFfmpeg } from './ffmpeg.js';
import { renderEffectOverlay, clearEffectRendererCache } from './effectRenderer.js';
import { renderChatEffectVideo, clearChatEffectCache } from './chatEffectRenderer.js';
import { renderSubtitleOverlay } from './subtitleRenderer.js';
import {
	resolveClip, buildAudioArgs, buildVideoEncoderArgs, createTempDir, cleanupTempDir,
	concatClipFiles, buildOutputPath
} from './exporterCommon.js';

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
	clipEntries?: (ClipEntry | undefined)[],
	effectEntries?: EffectEntry[],
	compOffsets?: number[],
	channelMap?: Map<string, string>
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

			const { dur, clipDur, speed, trimStart, concatPath, segments, localStart: clipLocalStart, localEnd: clipLocalEnd } = resolved;
			onProgress(`Encoding clip ${i + 1}/${clips.length} (${dur.toFixed(1)}s)`, i, totalSteps);

			const outFile = path.join(tempDir, `clip_${i}.mp4`);

			// Probe actual source resolution (no scaling in standard export)
			const probe = await probeVideo(segments[0].file);
			const srcW = probe.width || 1920;
			const srcH = probe.height || 1080;

			// Find overlapping effects for this clip
			const clipCompStart = compOffsets?.[i] ?? 0;
			const clipCompEnd = clipCompStart + clipDur;

			// Resolve zoom effects first so we know if we need to supersample overlays
			const clipZooms = resolveZoomEffects(effectEntries, clipCompStart, clipCompEnd, clipDur);
			const hasZoom = clipZooms.length > 0;

			const clipCtx: ClipContext | undefined = channelMap?.get(clips[i].streamId) ? {
				streamId: clips[i].streamId,
				channel: channelMap.get(clips[i].streamId)!,
				streamLocalStart: clipLocalStart,
				streamLocalEnd: clipLocalEnd
			} : undefined;
			const overlappingEffects = await resolveOverlappingEffects(
				effectEntries, clipCompStart, clipCompEnd, clipDur, tempDir, i,
				srcW, srcH, clipCtx,
				hasZoom ? ZOOM_SUPERSAMPLE : 1
			);

			const audioArgs = buildAudioArgs(speed);

			// Build ffmpeg args — use filter_complex when effects or zooms present
			const extraInputs: string[] = [];
			let videoFilterArgs: string[];
			const hasOverlays = overlappingEffects.length > 0;

			if (hasOverlays || hasZoom) {
				if (overlappingEffects.length > 0) {
					console.log(`[export] Clip ${i}: ${overlappingEffects.length} overlay(s), ss=${trimStart.toFixed(3)} t=${dur.toFixed(3)} speed=${speed}`);
					for (const eff of overlappingEffects) {
						console.log(`[export]   overlay: pos=(${eff.x},${eff.y}) local=[${eff.localStart.toFixed(3)},${eff.localEnd.toFixed(3)}] raw=${!!eff.rawVideo} video=${eff.videoPath}`);
					}
				}
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
					} else if (eff.animation) {
						// Animated subtitle: loop the PNG as a 30fps video so fade filters work
						extraInputs.push(
							...itsoffset,
							'-loop', '1', '-framerate', '30',
							'-i', eff.pngPath!
						);
					} else {
						extraInputs.push(...itsoffset, '-i', eff.videoPath ?? eff.pngPath!);
					}
				}

				// When zoom effects are present, composite at supersample resolution.
				// This way overlays (chat panels, text) are rendered at 2x and composited
				// at 2x, so the zoompan filter has native-resolution pixels to crop from
				// instead of bilinear-upscaling already-rasterized overlays.
				const ss = hasZoom ? ZOOM_SUPERSAMPLE : 1;

				const speedFilter = speed !== 1 ? `setpts=PTS/${speed},` : '';
				const scaleUp = hasZoom ? `,scale=${srcW * ss}:${srcH * ss}` : '';
				let filterGraph = `[0:v]${speedFilter}format=yuv420p${scaleUp}[base]`;
				let prevLabel = 'base';

				// 1. Overlay chain (composited at ss resolution when zoom is present)
				for (let ei = 0; ei < overlappingEffects.length; ei++) {
					const eff = overlappingEffects[ei];
					const inputIdx = ei + 1;
					const isLastOverlay = ei === overlappingEffects.length - 1;
					const nextLabel = isLastOverlay && !hasZoom ? 'outv' : `v${ei}`;
					const enableStart = (trimStart + eff.localStart).toFixed(3);
					const enableEnd = (trimStart + eff.localEnd).toFixed(3);
					const alphaFmt = 'format=yuva420p';
					// Adjust overlay position for supersample resolution
					const ox = eff.x * ss;
					const oy = eff.y * ss;
					let overlayInput: string;
					const effScale = (eff.scale && eff.scale !== 1) ? eff.scale : 1;
					// Raw video overlays (twitch-chat) are already rendered at ss via chatScaleBoost.
					// Non-raw overlays (PNGs) need FFmpeg scaling to match the ss composite.
					const pngSsScale = !eff.rawVideo && ss > 1 ? ss : 1;
					const totalScale = effScale * pngSsScale;
					if (totalScale !== 1) {
						const scaledLabel = `s${ei}`;
						filterGraph += `;[${inputIdx}:v]scale=iw*${totalScale}:ih*${totalScale},${alphaFmt}[${scaledLabel}]`;
						overlayInput = scaledLabel;
					} else {
						const prepLabel = `p${ei}`;
						filterGraph += `;[${inputIdx}:v]${alphaFmt}[${prepLabel}]`;
						overlayInput = prepLabel;
					}

					// Build overlay filter — use animated expressions for subtitle effects
					if (eff.animation) {
						const anim = eff.animation;
						const overlayExpr = buildAnimatedOverlay(
							overlayInput, prevLabel, nextLabel,
							ox, oy, parseFloat(enableStart), parseFloat(enableEnd),
							anim, ss
						);
						filterGraph += overlayExpr;
					} else {
						filterGraph += `;[${prevLabel}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
					}
					prevLabel = nextLabel;
				}

				// 2. Zoom chain (after all overlays — zooms the composited frame)
				const zoomFps = probe.fps > 0 ? probe.fps : 30;
				for (let zi = 0; zi < clipZooms.length; zi++) {
					const isLast = zi === clipZooms.length - 1;
					const nextLabel = isLast ? 'outv' : `zm${zi}`;
					filterGraph += buildZoomFilter(prevLabel, nextLabel, clipZooms[zi], trimStart, srcW, srcH, zoomFps);
					prevLabel = nextLabel;
				}

				// If no overlays and no zooms produced outv (shouldn't happen), rename
				if (prevLabel === 'base') {
					filterGraph = filterGraph.replace('[base]', '[outv]');
				}

				if (overlappingEffects.length > 0) {
					console.log(`[export]   filter_complex: ${filterGraph}`);
				}

					videoFilterArgs = [
					'-filter_complex', filterGraph,
					'-map', '[outv]', '-map', '0:a:0',
					...buildVideoEncoderArgs(useNvenc)
				];
			} else {
				const vFilters: string[] = [];
				if (speed !== 1) vFilters.push(`setpts=PTS/${speed}`);
				vFilters.push('format=yuv420p');

				videoFilterArgs = [
					'-vf', vFilters.join(','),
					'-map', '0:v:0', '-map', '0:a:0',
					...buildVideoEncoderArgs(useNvenc)
				];
			}

			await runFfmpeg([
				'-fflags', '+genpts',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				...extraInputs,
				'-ss', trimStart.toFixed(3),
				'-t', dur.toFixed(3),
				...videoFilterArgs,
				'-fps_mode', 'cfr',
				...audioArgs,
				'-video_track_timescale', '90000',
				'-movflags', '+faststart',
				'-y', outFile
			], 2000);

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

// --- Effect overlay helpers ---

export interface ResolvedEffect {
	pngPath?: string;    // for chat-message (static PNG)
	videoPath?: string;  // for twitch-chat (raw RGBA or encoded video)
	x: number;
	y: number;
	localStart: number;
	localEnd: number;
	scale?: number;      // uniform scale multiplier (default 1)
	/** If set, videoPath is a raw RGBA file — needs explicit format args on input. */
	rawVideo?: { width: number; height: number; fps: number };
	/** Subtitle animation config — only set for subtitle effects. */
	animation?: {
		animIn: SubtitleAnimation;
		animOut: SubtitleAnimation;
		animDuration: number;
		width: number;   // rendered PNG width (for slide calculations)
		height: number;  // rendered PNG height
	};
}

/** Info about a clip needed for resolving twitch-chat effects. */
export interface ClipContext {
	streamId: string;
	channel: string;
	/** Stream-local start time (seconds since capture startedAt). */
	streamLocalStart: number;
	/** Stream-local end time. */
	streamLocalEnd: number;
}

/**
 * Find effects that overlap a clip's composition time window,
 * render them as PNGs or WebMs, and return overlay parameters.
 * Assumes 1920x1080 source resolution for pixel position calculation.
 */
export async function resolveOverlappingEffects(
	effectEntries: EffectEntry[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	clipDur: number,
	tempDir: string,
	clipIdx: number,
	videoWidth = 1920,
	videoHeight = 1080,
	clipContext?: ClipContext,
	chatScaleBoost = 1
): Promise<ResolvedEffect[]> {
	if (!effectEntries || effectEntries.length === 0) return [];

	// Sort by track so lower tracks render first (behind higher tracks)
	const sorted = [...effectEntries].sort((a, b) => (a.track ?? 0) - (b.track ?? 0));

	const results: ResolvedEffect[] = [];
	for (let ei = 0; ei < sorted.length; ei++) {
		const effect = sorted[ei];
		if (effect.type === 'zoom') continue; // Zoom handled separately after all overlays
		const effectEnd = effect.startTime + effect.duration;
		// Check overlap
		if (effect.startTime >= clipCompEnd || effectEnd <= clipCompStart) continue;

		// Compute local time window within the clip
		const localStart = Math.max(0, effect.startTime - clipCompStart);
		const localEnd = Math.min(clipDur, effectEnd - clipCompStart);

		if (effect.type === 'twitch-chat') {
			// Render scrolling chat panel as transparent WebM
			if (!clipContext) continue;

			// Map the overlap window to stream-local time
			const clipStreamDur = clipContext.streamLocalEnd - clipContext.streamLocalStart;
			const overlapFracStart = localStart / clipDur;
			const overlapFracEnd = localEnd / clipDur;
			const streamStart = clipContext.streamLocalStart + overlapFracStart * clipStreamDur;
			const streamEnd = clipContext.streamLocalStart + overlapFracEnd * clipStreamDur;

			const videoOutPath = path.join(tempDir, `chatfx_${clipIdx}_${ei}.webm`);
			try {
				const result = await renderChatEffectVideo({
					streamId: clipContext.streamId,
					channel: clipContext.channel,
					localStart: streamStart,
					localEnd: streamEnd,
					outputPath: videoOutPath,
					panelWidth: effect.panelWidth,
					panelHeight: effect.panelHeight,
					chatOffset: effect.chatOffset,
					fontWeight: effect.chatFontWeight,
					chatScale: (effect.chatScale ?? 1) * chatScaleBoost
				});

				const x = Math.round(effect.x * videoWidth);
				const y = Math.round(effect.y * videoHeight);
				// Scale is baked into the render — no FFmpeg upscale needed
				const rawVideo = result.raw ? { width: result.width, height: result.height, fps: result.fps } : undefined;
				results.push({ videoPath: result.videoPath, x, y, localStart, localEnd, rawVideo });
			} catch (err) {
				console.warn(`[exporter] Failed to render twitch-chat effect ${ei}:`, err instanceof Error ? err.message : err);
			}
		} else if (effect.type === 'subtitle') {
			// subtitle: render styled text as PNG
			if (!effect.subtitleText) continue;

			const pngPath = path.join(tempDir, `subtitle_${clipIdx}_${ei}.png`);
			const result = await renderSubtitleOverlay({
				text: effect.subtitleText,
				outputPath: pngPath,
				fontSize: effect.subtitleFontSize,
				fontColor: effect.subtitleFontColor,
				outlineColor: effect.subtitleOutlineColor,
				outlineWidth: effect.subtitleOutlineWidth,
				fontWeight: effect.subtitleFontWeight,
				maxWidth: effect.subtitleMaxWidth,
				textAlign: effect.subtitleTextAlign,
			});

			// Center horizontally at the specified x position
			const x = Math.round(effect.x * videoWidth - result.width / 2);
			const y = Math.round(effect.y * videoHeight);
			const animIn = effect.subtitleAnimIn ?? 'none';
			const animOut = effect.subtitleAnimOut ?? 'none';
			const animDuration = effect.subtitleAnimDuration ?? 0.3;
			const animation = (animIn !== 'none' || animOut !== 'none')
				? { animIn, animOut, animDuration, width: result.width, height: result.height }
				: undefined;
			results.push({ pngPath, x, y, localStart, localEnd, animation });
		} else {
			// chat-message: render static PNG
			if (!effect.twitchId) continue;

			const pngPath = path.join(tempDir, `effect_${clipIdx}_${ei}.png`);
			const result = await renderEffectOverlay({
				twitchId: effect.twitchId,
				outputPath: pngPath
			});
			if (!result) continue;

			const x = Math.round(effect.x * videoWidth);
			const y = Math.round(effect.y * videoHeight);
			results.push({ pngPath, x, y, localStart, localEnd });
		}
	}
	return results;
}

// --- Zoom effect helpers ---

export interface ResolvedZoom {
	localStart: number;
	localEnd: number;
	startW: number; // visible width fraction (0-1, 1 = full frame = no zoom)
	endW: number;
	startX: number; // normalized 0-1
	startY: number;
	endX: number;
	endY: number;
}

/**
 * Find zoom effects that overlap a clip's composition window.
 * Returns normalized zoom parameters for each zoom.
 */
export function resolveZoomEffects(
	effectEntries: EffectEntry[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	clipDur: number
): ResolvedZoom[] {
	if (!effectEntries) return [];
	const results: ResolvedZoom[] = [];
	for (const effect of effectEntries) {
		if (effect.type !== 'zoom') continue;
		const effectEnd = effect.startTime + effect.duration;
		if (effect.startTime >= clipCompEnd || effectEnd <= clipCompStart) continue;

		const localStart = Math.max(0, effect.startTime - clipCompStart);
		const localEnd = Math.min(clipDur, effectEnd - clipCompStart);
		results.push({
			localStart, localEnd,
			startW: Math.max(0.1, effect.zoomStartW ?? 1),
			endW: Math.max(0.1, effect.zoomEndW ?? 1),
			startX: effect.zoomStartX ?? 0,
			startY: effect.zoomStartY ?? 0,
			endX: effect.zoomEndX ?? 0,
			endY: effect.zoomEndY ?? 0,
		});
	}
	return results;
}

/**
 * Build an FFmpeg zoompan filter for an animated zoom.
 * Uses zoompan instead of crop+scale because crop locks output dimensions at init.
 * Scales input up by SUPERSAMPLE before zoompan so integer x/y rounding gives
 * sub-pixel precision, eliminating pan jitter.
 */
export const ZOOM_SUPERSAMPLE = 2;

export function buildZoomFilter(
	inputLabel: string,
	outputLabel: string,
	zoom: ResolvedZoom,
	trimStart: number,
	videoW: number,
	videoH: number,
	fps: number
): string {
	const T0 = (trimStart + zoom.localStart).toFixed(3);
	const T1 = (trimStart + zoom.localEnd).toFixed(3);
	const durExpr = `(${T1}-${T0}+0.001)`; // +epsilon avoids division by zero

	function lerp(start: number, end: number, fallback: string) {
		const frac = `clip((in_time-${T0})/${durExpr},0,1)`;
		return `if(between(in_time,${T0},${T1}),${start}+(${end - start})*${frac},${fallback})`;
	}

	// Linearly interpolate the visible width fraction, then derive z = 1/w.
	// This keeps zoom and pan visually in sync (both linear in screen space).
	const wExpr = lerp(zoom.startW, zoom.endW, '1');
	const zExpr = `1/(${wExpr})`;
	const xExpr = lerp(zoom.startX, zoom.endX, '0');
	const yExpr = lerp(zoom.startY, zoom.endY, '0');

	// Scale up by SUPERSAMPLE → zoompan in high-res space (sub-pixel precision) → output at original size
	const ssW = videoW * ZOOM_SUPERSAMPLE;
	const ssH = videoH * ZOOM_SUPERSAMPLE;

	return `;[${inputLabel}]scale=${ssW}:${ssH}:flags=bilinear,zoompan=z='${zExpr}':x='(${xExpr})*iw':y='(${yExpr})*ih':d=1:s=${videoW}x${videoH}:fps=${fps}[${outputLabel}]`;
}

// --- Subtitle animation helpers ---

/**
 * Build an FFmpeg overlay filter with animated position/alpha for subtitle effects.
 *
 * FFmpeg overlay filter supports expressions for x, y, and the `enable` expression.
 * The `t` variable in overlay refers to the *main input* timestamp.
 * For alpha we multiply the overlay's alpha channel via `colorchannelmixer` before
 * feeding it to overlay, using `t` from a sendcmd-like approach — but since
 * colorchannelmixer doesn't support per-frame expressions, we instead use the
 * overlay `format=auto` and `[overlay_input]fade` filter to get alpha animation.
 *
 * Strategy:
 * - Position animations (slide, bounce): use overlay x/y expressions
 * - Alpha animations (fade, pop): chain `fade=in`/`fade=out` filters on the overlay input
 * - Combined: both
 */
export function buildAnimatedOverlay(
	overlayInput: string,
	prevLabel: string,
	nextLabel: string,
	baseX: number,
	baseY: number,
	enableStart: number,
	enableEnd: number,
	anim: NonNullable<ResolvedEffect['animation']>,
	ss: number
): string {
	const T0 = enableStart.toFixed(3);
	const T1 = enableEnd.toFixed(3);
	const dur = anim.animDuration;
	const w = anim.width * ss;
	const h = anim.height * ss;
	const effectDuration = enableEnd - enableStart;
	const filterParts: string[] = [];

	// Time boundaries for animation phases (in overlay-local time)
	// The overlay input is fed via -itsoffset so its t=0 aligns with enableStart.
	// In the overlay filter, `t` refers to the main video's time.
	// So we use absolute time values.
	const inEnd = enableStart + dur;
	const outStart = enableEnd - dur;

	// In the overlay filter, x/y expressions use `t` = main video time
	// We build expressions in terms of this `t`.

	// --- X expression ---
	let xExpr = `${baseX}`;
	const xIn = buildPositionAnim(anim.animIn, 'in', 'x', baseX, baseY, w, h, enableStart, inEnd, dur);
	const xOut = buildPositionAnim(anim.animOut, 'out', 'x', baseX, baseY, w, h, outStart, enableEnd, dur);
	if (xIn || xOut) {
		// Phase: in-anim | steady | out-anim
		const steady = `${baseX}`;
		if (xIn && xOut) {
			xExpr = `if(lt(t,${inEnd.toFixed(3)}),${xIn},if(gt(t,${outStart.toFixed(3)}),${xOut},${steady}))`;
		} else if (xIn) {
			xExpr = `if(lt(t,${inEnd.toFixed(3)}),${xIn},${steady})`;
		} else {
			xExpr = `if(gt(t,${outStart.toFixed(3)}),${xOut},${steady})`;
		}
	}

	// --- Y expression ---
	let yExpr = `${baseY}`;
	const yIn = buildPositionAnim(anim.animIn, 'in', 'y', baseX, baseY, w, h, enableStart, inEnd, dur);
	const yOut = buildPositionAnim(anim.animOut, 'out', 'y', baseX, baseY, w, h, outStart, enableEnd, dur);
	if (yIn || yOut) {
		const steady = `${baseY}`;
		if (yIn && yOut) {
			yExpr = `if(lt(t,${inEnd.toFixed(3)}),${yIn},if(gt(t,${outStart.toFixed(3)}),${yOut},${steady}))`;
		} else if (yIn) {
			yExpr = `if(lt(t,${inEnd.toFixed(3)}),${yIn},${steady})`;
		} else {
			yExpr = `if(gt(t,${outStart.toFixed(3)}),${yOut},${steady})`;
		}
	}

	// --- Alpha (fade) via FFmpeg fade filter on the overlay input ---
	// The overlay input has already been prepared (format=yuva420p, optional scale).
	// -itsoffset shifts the overlay stream's PTS to start at enableStart,
	// so the fade filter's `st` must use absolute (enableStart-based) times.
	// All animation types get a subtle fade — not just 'fade' and 'pop'
	const needsFadeIn = anim.animIn !== 'none';
	const needsFadeOut = anim.animOut !== 'none';

	let inputForOverlay = overlayInput;
	if (needsFadeIn || needsFadeOut) {
		const parts: string[] = [];
		if (needsFadeIn) {
			const fadeDur = anim.animIn === 'pop' ? dur * 0.6 : dur;
			parts.push(`fade=t=in:st=${enableStart.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1`);
		}
		if (needsFadeOut) {
			const fadeOutStart = enableEnd - dur;
			const fadeDur = anim.animOut === 'pop' ? dur * 0.6 : dur;
			parts.push(`fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1`);
		}
		const fadeLabel = `af${nextLabel}`;
		filterParts.push(`;[${overlayInput}]${parts.join(',')}[${fadeLabel}]`);
		inputForOverlay = fadeLabel;
	}

	filterParts.push(`;[${prevLabel}][${inputForOverlay}]overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${T0},${T1})'[${nextLabel}]`);

	return filterParts.join('');
}

/**
 * Build a position expression for a single axis during an animation phase.
 * Returns null if this animation type doesn't affect the given axis.
 *
 * For 'in' phase: progress goes 0→1 over [phaseStart, phaseEnd]
 * For 'out' phase: progress goes 0→1 over [phaseStart, phaseEnd]
 */
function buildPositionAnim(
	animType: SubtitleAnimation,
	phase: 'in' | 'out',
	axis: 'x' | 'y',
	baseX: number, baseY: number,
	w: number, h: number,
	phaseStart: number, phaseEnd: number,
	dur: number
): string | null {
	// Progress: 0→1 over the phase
	const p = `clip((t-${phaseStart.toFixed(3)})/${dur.toFixed(3)},0,1)`;

	if (animType === 'slide-up') {
		if (axis !== 'y') return null;
		const offset = h * 1.5; // slide distance
		if (phase === 'in') {
			// Start below (baseY + offset), end at baseY
			return `${baseY}+${offset.toFixed(1)}*(1-${p})`;
		} else {
			// Start at baseY, slide up (baseY - offset*p)
			return `${baseY}-${offset.toFixed(1)}*${p}`;
		}
	}

	if (animType === 'slide-down') {
		if (axis !== 'y') return null;
		const offset = h * 1.5;
		if (phase === 'in') {
			return `${baseY}-${offset.toFixed(1)}*(1-${p})`;
		} else {
			return `${baseY}+${offset.toFixed(1)}*${p}`;
		}
	}

	if (animType === 'slide-left') {
		if (axis !== 'x') return null;
		const offset = w * 2;
		if (phase === 'in') {
			// Start to the right (baseX + offset), slide left to baseX
			return `${baseX}+${offset.toFixed(1)}*(1-${p})`;
		} else {
			// Slide left from baseX
			return `${baseX}-${offset.toFixed(1)}*${p}`;
		}
	}

	if (animType === 'slide-right') {
		if (axis !== 'x') return null;
		const offset = w * 2;
		if (phase === 'in') {
			return `${baseX}-${offset.toFixed(1)}*(1-${p})`;
		} else {
			return `${baseX}+${offset.toFixed(1)}*${p}`;
		}
	}

	if (animType === 'bounce') {
		if (axis !== 'y') return null;
		const offset = h * 1.5;
		if (phase === 'in') {
			// Ease-out with overshoot: use a cubic bezier-like overshoot
			// p goes 0→1; we want position to overshoot slightly then settle
			// eased = 1 - (1-p)^2 * cos(p * PI)  — overshoots at ~0.7 then settles
			const eased = `(1-(1-${p})*(1-${p})*cos(${p}*3.14159))`;
			return `${baseY}+${offset.toFixed(1)}*(1-clip(${eased},0,1.2))`;
		} else {
			// Accelerate out
			return `${baseY}-${offset.toFixed(1)}*(${p}*${p})`;
		}
	}

	// fade, pop, none — don't affect position
	return null;
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
