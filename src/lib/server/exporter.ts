/**
 * Standard (16:9) video exporter.
 * Encodes clips directly from raw HLS segments on disk — no pre-encoded intermediates.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, ClipEntry, EffectEntry, OverlayAnimation, EasingFunction } from '../types.js';
import { runFfmpeg } from './ffmpeg.js';
import { renderEffectOverlay, clearEffectRendererCache } from './effectRenderer.js';
import { renderChatEffectVideo, clearChatEffectCache } from './chatEffectRenderer.js';
import { renderSubtitleOverlay } from './subtitleRenderer.js';
import {
	resolveClip, buildAudioArgs, buildVideoEncoderArgs, createTempDir, cleanupTempDir,
	concatClipFiles, buildOutputPath, resolveAudioOverlays, buildAudioMixFilter
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
				srcW, srcH, clipCtx,
				hasZoom ? ZOOM_SUPERSAMPLE : 1
			);
			const postZoomEffects = postZoomEntries.length > 0 ? await resolveOverlappingEffects(
				postZoomEntries, clipCompStart, clipCompEnd, clipDur, tempDir, i,
				srcW, srcH, clipCtx, 1, 'pz_'
			) : [];

			// Combine for FFmpeg input ordering: pre-zoom first, then post-zoom
			const allEffects = [...preZoomEffects, ...postZoomEffects];

			// Resolve audio overlays for this clip
			const audioOverlays = resolveAudioOverlays(effectEntries, clipCompStart, clipCompEnd);

			const audioArgs = buildAudioArgs(speed);

			// Build ffmpeg args — use filter_complex when effects or zooms present
			const extraInputs: string[] = [];
			let videoFilterArgs: string[];
			const hasOverlays = allEffects.length > 0;

			if (hasOverlays || hasZoom) {
				if (allEffects.length > 0) {
					console.log(`[export] Clip ${i}: ${preZoomEffects.length} pre-zoom + ${postZoomEffects.length} post-zoom overlay(s), ss=${trimStart.toFixed(3)} t=${dur.toFixed(3)} speed=${speed}`);
					for (const eff of allEffects) {
						console.log(`[export]   overlay: pos=(${eff.x},${eff.y}) local=[${eff.localStart.toFixed(3)},${eff.localEnd.toFixed(3)}] raw=${!!eff.rawVideo} ignoreZoom=${!!eff.ignoreZoom}`);
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

				// When zoom effects are present, composite at supersample resolution.
				// This way overlays (chat panels, text) are rendered at 2x and composited
				// at 2x, so the zoompan filter has native-resolution pixels to crop from
				// instead of bilinear-upscaling already-rasterized overlays.
				const ss = hasZoom ? ZOOM_SUPERSAMPLE : 1;

				const speedFilter = speed !== 1 ? `setpts=PTS/${speed},` : '';
				const scaleUp = hasZoom ? `,scale=${srcW * ss}:${srcH * ss}` : '';
				let filterGraph = `[0:v]${speedFilter}format=yuv420p${scaleUp}[base]`;
				let prevLabel = 'base';

				// 1. Pre-zoom overlay chain (composited at ss resolution when zoom is present)
				for (let ei = 0; ei < preZoomEffects.length; ei++) {
					const eff = preZoomEffects[ei];
					const inputIdx = ei + 1;  // offset by 1 for concat input [0]
					const isLastBeforeZoom = ei === preZoomEffects.length - 1;
					const nextLabel = isLastBeforeZoom && !hasZoom && postZoomEffects.length === 0 ? 'outv' : `v${ei}`;
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

				// 2. Zoom chain (after pre-zoom overlays — zooms the composited frame)
				const zoomFps = probe.fps > 0 ? probe.fps : 30;
				for (let zi = 0; zi < clipZooms.length; zi++) {
					const isLast = zi === clipZooms.length - 1;
					const nextLabel = isLast && postZoomEffects.length === 0 ? 'outv' : `zm${zi}`;
					filterGraph += buildZoomFilter(prevLabel, nextLabel, clipZooms[zi], trimStart, srcW, srcH, zoomFps);
					prevLabel = nextLabel;
				}

				// 3. Post-zoom overlay chain (ignoreZoom effects — at output resolution, no supersample)
				for (let ei = 0; ei < postZoomEffects.length; ei++) {
					const eff = postZoomEffects[ei];
					const inputIdx = preZoomEffects.length + ei + 1;  // offset past pre-zoom inputs + concat
					const isLast = ei === postZoomEffects.length - 1;
					const nextLabel = isLast ? 'outv' : `pz${ei}`;
					const enableStart = (trimStart + eff.localStart).toFixed(3);
					const enableEnd = (trimStart + eff.localEnd).toFixed(3);
					const alphaFmt = 'format=yuva420p';
					// Post-zoom overlays at output resolution — no supersample scaling
					const ox = eff.x;
					const oy = eff.y;
					let overlayInput: string;
					const effScale = (eff.scale && eff.scale !== 1) ? eff.scale : 1;
					if (effScale !== 1) {
						const scaledLabel = `ps${ei}`;
						filterGraph += `;[${inputIdx}:v]scale=iw*${effScale}:ih*${effScale},${alphaFmt}[${scaledLabel}]`;
						overlayInput = scaledLabel;
					} else {
						const prepLabel = `pp${ei}`;
						filterGraph += `;[${inputIdx}:v]${alphaFmt}[${prepLabel}]`;
						overlayInput = prepLabel;
					}

					if (eff.animation) {
						const overlayExpr = buildAnimatedOverlay(
							overlayInput, prevLabel, nextLabel,
							ox, oy, parseFloat(enableStart), parseFloat(enableEnd),
							eff.animation, 1  // ss=1 for post-zoom
						);
						filterGraph += overlayExpr;
					} else {
						filterGraph += `;[${prevLabel}][${overlayInput}]overlay=${ox}:${oy}:enable='between(t,${enableStart},${enableEnd})'[${nextLabel}]`;
					}
					prevLabel = nextLabel;
				}

				// If no overlays and no zooms produced outv (shouldn't happen), rename
				if (prevLabel === 'base') {
					filterGraph = filterGraph.replace('[base]', '[outv]');
				}

				if (allEffects.length > 0) {
					console.log(`[export]   filter_complex: ${filterGraph}`);
				}

				// Audio overlay mixing
				const audioNextIdx = 1 + allEffects.length;
				const audioMix = buildAudioMixFilter(audioOverlays, audioNextIdx, speed, clipDur);
				if (audioMix.totalAudioInputs > 0) {
					extraInputs.push(...audioMix.extraInputs);
					filterGraph += ';' + audioMix.audioFilterGraph;
				}

				videoFilterArgs = [
					'-filter_complex', filterGraph,
					'-map', '[outv]',
					...(audioMix.totalAudioInputs > 0 ? ['-map', `[${audioMix.audioOutLabel}]`] : ['-map', '0:a:0']),
					...buildVideoEncoderArgs(useNvenc)
				];
			} else {
				const vFilters: string[] = [];
				if (speed !== 1) vFilters.push(`setpts=PTS/${speed}`);
				vFilters.push('format=yuv420p');

				if (audioOverlays.length > 0) {
					// Need filter_complex for audio mixing even without video overlays
					const audioMix = buildAudioMixFilter(audioOverlays, 1, speed, clipDur);
					extraInputs.push(...audioMix.extraInputs);
					// Build a combined filter with video + audio
					const fullFilter = `[0:v]${vFilters.join(',')}[outv];${audioMix.audioFilterGraph}`;
					videoFilterArgs = [
						'-filter_complex', fullFilter,
						'-map', '[outv]', '-map', `[${audioMix.audioOutLabel}]`,
						...buildVideoEncoderArgs(useNvenc)
					];
				} else {
					videoFilterArgs = [
						'-vf', vFilters.join(','),
						'-map', '0:v:0', '-map', '0:a:0',
						...buildVideoEncoderArgs(useNvenc)
					];
				}
			}

			// When using audio filter_complex, skip -af args (already handled in filter graph)
			const hasAudioMix = audioOverlays.length > 0;

			await runFfmpeg([
				'-fflags', '+genpts',
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				...extraInputs,
				'-ss', trimStart.toFixed(3),
				'-t', dur.toFixed(3),
				...videoFilterArgs,
				'-fps_mode', 'cfr',
				...(hasAudioMix ? ['-c:a', 'aac', '-ar', '48000', '-b:a', '192k'] : audioArgs),
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

export interface ShadowConfig {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

function shadowPadding(shadow?: ShadowConfig): { top: number; right: number; bottom: number; left: number } {
	if (!shadow) return { top: 0, right: 0, bottom: 0, left: 0 };
	const b = shadow.blur;
	return {
		top:    Math.max(0, b - shadow.offsetY),
		bottom: Math.max(0, b + shadow.offsetY),
		left:   Math.max(0, b - shadow.offsetX),
		right:  Math.max(0, b + shadow.offsetX),
	};
}

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
	/** Rendered overlay dimensions (used to compute animation slide distances). */
	overlayWidth: number;
	overlayHeight: number;
	/** In/out animation config — set when the effect has non-none animations. */
	animation?: {
		animIn: OverlayAnimation;
		animOut: OverlayAnimation;
		animDuration: number;
		animInEasing: import('$lib/types').EasingFunction;
		animOutEasing: import('$lib/types').EasingFunction;
		width: number;   // rendered overlay width (for slide calculations)
		height: number;  // rendered overlay height
	};
	/** When true, composited after zoom — stays fixed in screen space. */
	ignoreZoom?: boolean;
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
	chatScaleBoost = 1,
	filePrefix = ''
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

		// Resolve the overlay for this effect type
		let resolved: ResolvedEffect | null = null;

		if (effect.type === 'twitch-chat') {
			// Render scrolling chat panel as transparent WebM
			if (!clipContext) continue;

			// Map the overlap window to stream-local time
			const clipStreamDur = clipContext.streamLocalEnd - clipContext.streamLocalStart;
			const overlapFracStart = localStart / clipDur;
			const overlapFracEnd = localEnd / clipDur;
			const streamStart = clipContext.streamLocalStart + overlapFracStart * clipStreamDur;
			const streamEnd = clipContext.streamLocalStart + overlapFracEnd * clipStreamDur;

			const videoOutPath = path.join(tempDir, `${filePrefix}chatfx_${clipIdx}_${ei}.webm`);
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
					chatScale: (effect.chatScale ?? 1) * chatScaleBoost,
					shadow: effect.shadow,
				});

				const sp = shadowPadding(effect.shadow);
				const chatSc = (effect.chatScale ?? 1) * chatScaleBoost;
				const x = Math.round(effect.x * videoWidth) - Math.round(sp.left * chatSc);
				const y = Math.round(effect.y * videoHeight) - Math.round(sp.top * chatSc);
				// Scale is baked into the render — no FFmpeg upscale needed
				const rawVideo = result.raw ? { width: result.width, height: result.height, fps: result.fps } : undefined;
				resolved = { videoPath: result.videoPath, x, y, localStart, localEnd, rawVideo,
					overlayWidth: result.width, overlayHeight: result.height };
			} catch (err) {
				console.warn(`[exporter] Failed to render twitch-chat effect ${ei}:`, err instanceof Error ? err.message : err);
			}
		} else if (effect.type === 'image') {
			// image: load uploaded image, optionally scale, apply opacity, apply shadow
			if (!effect.imageId) continue;

			const imgDir = path.resolve(process.cwd(), 'data', 'overlays');
			const imgFilePath = path.join(imgDir, effect.imageId);
			if (!fs.existsSync(imgFilePath)) {
				console.warn(`[exporter] Image overlay file not found: ${imgFilePath}`);
				continue;
			}

			const { createCanvas, loadImage } = await import('@napi-rs/canvas');
			const img = await loadImage(imgFilePath);
			const scale = effect.imageScale ?? 1;
			const opacity = effect.imageOpacity ?? 1;
			// Use stored dimensions (same values the preview uses) to ensure consistency.
			// Fall back to loaded image dimensions if not stored.
			const naturalW = effect.imageWidth ?? img.width;
			const naturalH = effect.imageHeight ?? img.height;
			const scaledW = Math.round(naturalW * scale);
			const scaledH = Math.round(naturalH * scale);
			const sp = shadowPadding(effect.shadow);

			const pngPath = path.join(tempDir, `${filePrefix}image_${clipIdx}_${ei}.png`);

			if (scale !== 1 || opacity < 1 || effect.shadow || !imgFilePath.toLowerCase().endsWith('.png')) {
				// Re-render via canvas at scaled size with opacity and optional shadow
				const canvasW = scaledW + sp.left + sp.right;
				const canvasH = scaledH + sp.top + sp.bottom;
				const canvas = createCanvas(canvasW, canvasH);
				const ctx = canvas.getContext('2d');
				if (effect.shadow) {
					ctx.shadowColor = effect.shadow.color;
					ctx.shadowBlur = effect.shadow.blur;
					ctx.shadowOffsetX = effect.shadow.offsetX;
					ctx.shadowOffsetY = effect.shadow.offsetY;
				}
				ctx.globalAlpha = opacity;
				ctx.drawImage(img, sp.left, sp.top, scaledW, scaledH);
				fs.writeFileSync(pngPath, canvas.toBuffer('image/png'));

				const x = Math.round(effect.x * videoWidth) - sp.left;
				const y = Math.round(effect.y * videoHeight) - sp.top;
				resolved = { pngPath, x, y, localStart, localEnd,
					overlayWidth: canvasW, overlayHeight: canvasH };
			} else {
				// Use directly
				fs.copyFileSync(imgFilePath, pngPath);
				const x = Math.round(effect.x * videoWidth);
				const y = Math.round(effect.y * videoHeight);
				resolved = { pngPath, x, y, localStart, localEnd,
					overlayWidth: scaledW, overlayHeight: scaledH };
			}
		} else if (effect.type === 'subtitle') {
			// subtitle: render styled text as PNG
			if (!effect.subtitleText) continue;

			const pngPath = path.join(tempDir, `${filePrefix}subtitle_${clipIdx}_${ei}.png`);
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
				fontFamily: effect.subtitleFontFamily,
				shadow: effect.shadow,
			});

			// Center horizontally at the specified x position
			// When shadow padding is present, compute content width for centering
			const sp = shadowPadding(effect.shadow);
			const contentW = result.width - sp.left - sp.right;
			const x = Math.round(effect.x * videoWidth - contentW / 2) - sp.left;
			const y = Math.round(effect.y * videoHeight) - sp.top;
			resolved = { pngPath, x, y, localStart, localEnd,
				overlayWidth: result.width, overlayHeight: result.height };
		} else {
			// chat-message: render static PNG
			if (!effect.twitchId) continue;

			const pngPath = path.join(tempDir, `${filePrefix}effect_${clipIdx}_${ei}.png`);
			const result = await renderEffectOverlay({
				twitchId: effect.twitchId,
				outputPath: pngPath,
				shadow: effect.shadow,
			});
			if (!result) continue;

			const sp = shadowPadding(effect.shadow);
			const x = Math.round(effect.x * videoWidth) - sp.left;
			const y = Math.round(effect.y * videoHeight) - sp.top;
			resolved = { pngPath, x, y, localStart, localEnd,
				overlayWidth: result.width, overlayHeight: result.height };
		}

		if (!resolved) continue;

		// Attach animation if the effect has in/out animations (works for all overlay types)
		const animIn = effect.animIn ?? 'none';
		const animOut = effect.animOut ?? 'none';
		const animDuration = effect.animDuration ?? 0.3;
		const animInEasing = effect.animInEasing ?? 'ease-out';
		const animOutEasing = effect.animOutEasing ?? 'ease-in';
		if (animIn !== 'none' || animOut !== 'none') {
			resolved.animation = { animIn, animOut, animDuration, animInEasing, animOutEasing,
				width: resolved.overlayWidth, height: resolved.overlayHeight };
		}

		if (effect.ignoreZoom) resolved.ignoreZoom = true;

		results.push(resolved);
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
 * - Position animations (slide): use overlay x/y expressions with easing
 * - Scale animations (grow, shrink): animated scale filter
 * - Alpha animations (fade): chain `fade=in`/`fade=out` filters on the overlay input
 * - Combined: both
 */

/** Build an FFmpeg expression that applies an easing function to linear progress `p`. */
function ffmpegEasing(p: string, easing: EasingFunction): string {
	switch (easing) {
		case 'linear': return p;
		case 'ease-in': return `(${p}*${p})`;
		case 'ease-out': return `(1-(1-${p})*(1-${p}))`;
		case 'ease-in-out': return `if(lt(${p},0.5),2*${p}*${p},1-2*(1-${p})*(1-${p}))`;
		case 'bounce': return `(1+(1-${p})*(1-${p})*(2.5*${p}-1))`;
		default: return p;
	}
}

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
	const filterParts: string[] = [];

	const inEnd = enableStart + dur;
	const outStart = enableEnd - dur;

	// --- X expression ---
	let xExpr = `${baseX}`;
	const xIn = buildPositionAnim(anim.animIn, 'in', 'x', baseX, baseY, w, h, enableStart, inEnd, dur, anim.animInEasing);
	const xOut = buildPositionAnim(anim.animOut, 'out', 'x', baseX, baseY, w, h, outStart, enableEnd, dur, anim.animOutEasing);
	if (xIn || xOut) {
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
	const yIn = buildPositionAnim(anim.animIn, 'in', 'y', baseX, baseY, w, h, enableStart, inEnd, dur, anim.animInEasing);
	const yOut = buildPositionAnim(anim.animOut, 'out', 'y', baseX, baseY, w, h, outStart, enableEnd, dur, anim.animOutEasing);
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

	// --- Scale animation (grow / shrink) ---
	const hasScaleIn = anim.animIn === 'grow' || anim.animIn === 'shrink';
	const hasScaleOut = anim.animOut === 'grow' || anim.animOut === 'shrink';
	const hasScale = hasScaleIn || hasScaleOut;

	let scaleExpr: string | null = null;
	if (hasScale) {
		const pieces: string[] = [];

		if (hasScaleIn) {
			const p = `clip((t-${enableStart.toFixed(3)})/${dur.toFixed(3)},0,1)`;
			const eased = ffmpegEasing(p, anim.animInEasing);
			// grow: scale 0.3→1; shrink: scale 1.7→1
			const inScale = anim.animIn === 'grow'
				? `(0.3+0.7*${eased})`
				: `(1.7-0.7*${eased})`;
			pieces.push(`if(lt(t,${inEnd.toFixed(3)}),${inScale}`);
		}
		if (hasScaleOut) {
			const p = `clip((t-${outStart.toFixed(3)})/${dur.toFixed(3)},0,1)`;
			const eased = ffmpegEasing(p, anim.animOutEasing);
			// grow: scale 1→1.7; shrink: scale 1→0.3
			const outScale = anim.animOut === 'grow'
				? `(1+0.7*${eased})`
				: `(1-0.7*${eased})`;
			if (hasScaleIn) {
				pieces.push(`if(gt(t,${outStart.toFixed(3)}),${outScale},1)`);
			} else {
				pieces.push(`if(gt(t,${outStart.toFixed(3)}),${outScale}`);
			}
		}

		if (hasScaleIn && hasScaleOut) {
			scaleExpr = `${pieces[0]},${pieces[1]})`;
		} else if (hasScaleIn) {
			scaleExpr = `${pieces[0]},1)`;
		} else {
			scaleExpr = `${pieces[0]},1)`;
		}
	}

	// --- Alpha (fade) via FFmpeg fade filter on the overlay input ---
	const needsFadeIn = anim.animIn !== 'none';
	const needsFadeOut = anim.animOut !== 'none';

	let inputForOverlay = overlayInput;

	// Chain: [input] → scale (grow/shrink) → fade → [overlay]
	const chainFilters: string[] = [];
	if (scaleExpr) {
		chainFilters.push(`scale=w='trunc(iw*${scaleExpr}/2)*2':h='trunc(ih*${scaleExpr}/2)*2':eval=frame`);
	}
	if (needsFadeIn) {
		const fadeDur = hasScaleIn ? dur * 0.6 : dur;
		chainFilters.push(`fade=t=in:st=${enableStart.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1`);
	}
	if (needsFadeOut) {
		const fadeOutStart = enableEnd - dur;
		const fadeDur = hasScaleOut ? dur * 0.6 : dur;
		chainFilters.push(`fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1`);
	}

	if (chainFilters.length > 0) {
		const chainLabel = `af${nextLabel}`;
		filterParts.push(`;[${overlayInput}]${chainFilters.join(',')}[${chainLabel}]`);
		inputForOverlay = chainLabel;
	}

	// --- Overlay position ---
	// For scale animations, adjust x/y to keep overlay centered at the intended position.
	// Use overlay_w/overlay_h (actual scaled dims from the scale filter) for accuracy.
	if (hasScale) {
		const xCenter = `${baseX}+(${w}-overlay_w)/2`;
		const yCenter = `${baseY}+(${h}-overlay_h)/2`;

		if (xExpr === `${baseX}`) {
			xExpr = xCenter;
		}
		if (yExpr === `${baseY}`) {
			yExpr = yCenter;
		}
	}

	filterParts.push(`;[${prevLabel}][${inputForOverlay}]overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${T0},${T1})'[${nextLabel}]`);

	return filterParts.join('');
}

/**
 * Build a position expression for a single axis during an animation phase.
 * Returns null if this animation type doesn't affect the given axis.
 */
function buildPositionAnim(
	animType: OverlayAnimation,
	phase: 'in' | 'out',
	axis: 'x' | 'y',
	baseX: number, baseY: number,
	w: number, h: number,
	phaseStart: number, phaseEnd: number,
	dur: number,
	easing: EasingFunction
): string | null {
	const p = `clip((t-${phaseStart.toFixed(3)})/${dur.toFixed(3)},0,1)`;
	const ep = ffmpegEasing(p, easing);

	if (animType === 'slide-up') {
		if (axis !== 'y') return null;
		const offset = h * 0.4;
		if (phase === 'in') {
			return `${baseY}+${offset.toFixed(1)}*(1-${ep})`;
		} else {
			return `${baseY}-${offset.toFixed(1)}*${ep}`;
		}
	}

	if (animType === 'slide-down') {
		if (axis !== 'y') return null;
		const offset = h * 0.4;
		if (phase === 'in') {
			return `${baseY}-${offset.toFixed(1)}*(1-${ep})`;
		} else {
			return `${baseY}+${offset.toFixed(1)}*${ep}`;
		}
	}

	if (animType === 'slide-left') {
		if (axis !== 'x') return null;
		const offset = w * 0.5;
		if (phase === 'in') {
			return `${baseX}+${offset.toFixed(1)}*(1-${ep})`;
		} else {
			return `${baseX}-${offset.toFixed(1)}*${ep}`;
		}
	}

	if (animType === 'slide-right') {
		if (axis !== 'x') return null;
		const offset = w * 0.5;
		if (phase === 'in') {
			return `${baseX}-${offset.toFixed(1)}*(1-${ep})`;
		} else {
			return `${baseX}+${offset.toFixed(1)}*${ep}`;
		}
	}

	// fade, grow, shrink, none — don't affect position
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
