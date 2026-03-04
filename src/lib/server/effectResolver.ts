/**
 * Effect resolver — finds effects overlapping a clip's composition window
 * and renders them as overlay PNGs, raw RGBA streams, or video files.
 */

import * as path from 'node:path';
import type { EffectEntry } from '../types.js';
import type { ShadowConfig, ResolvedEffect, ClipContext, ResolvedView, ResolvedZoomPan } from './exporterTypes.js';
import { renderEffectOverlay } from './effectRenderer.js';
import { prepareChatEffect } from './chatEffectRenderer.js';
import { renderSubtitleOverlay } from './subtitleRenderer.js';
import { renderImageOverlay } from './imageRenderer.js';
import { shadowPadding } from './exporterCommon.js';

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
		const effectEnd = effect.startTime + effect.duration;
		// Check overlap
		if (effect.startTime >= clipCompEnd || effectEnd <= clipCompStart) continue;

		// Compute local time window within the clip
		const localStart = Math.max(0, effect.startTime - clipCompStart);
		const localEnd = Math.min(clipDur, effectEnd - clipCompStart);

		// Resolve the overlay for this effect type
		let resolved: ResolvedEffect | null = null;

		if (effect.type === 'twitch-chat') {
			// Prepare scrolling chat panel — defers frame rendering for pipe-based streaming
			if (!clipContext) continue;

			// Map the overlap window to stream-local time
			const clipStreamDur = clipContext.streamLocalEnd - clipContext.streamLocalStart;
			const overlapFracStart = localStart / clipDur;
			const overlapFracEnd = localEnd / clipDur;
			const streamStart = clipContext.streamLocalStart + overlapFracStart * clipStreamDur;
			const streamEnd = clipContext.streamLocalStart + overlapFracEnd * clipStreamDur;

			try {
				const prepared = await prepareChatEffect({
					streamId: clipContext.streamId,
					channel: clipContext.channel,
					localStart: streamStart,
					localEnd: streamEnd,
					targetDur: localEnd - localStart, // composition-time duration for FFmpeg
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
				resolved = {
					x, y, localStart, localEnd,
					rawVideo: { width: prepared.width, height: prepared.height, fps: prepared.fps },
					overlayWidth: prepared.width, overlayHeight: prepared.height,
					deferredRender: prepared.renderFrames
				};
			} catch (err) {
				console.warn(`[exporter] Failed to prepare twitch-chat effect ${ei}:`, err instanceof Error ? err.message : err);
			}
		} else if (effect.type === 'image') {
			// image: load uploaded image, optionally scale, apply opacity, apply shadow
			if (!effect.imageId) continue;

			const pngPath = path.join(tempDir, `${filePrefix}image_${clipIdx}_${ei}.png`);
			const result = await renderImageOverlay({
				imageId: effect.imageId,
				outputPath: pngPath,
				scale: effect.imageScale,
				opacity: effect.imageOpacity,
				naturalWidth: effect.imageWidth,
				naturalHeight: effect.imageHeight,
				shadow: effect.shadow,
			});
			if (!result) continue;

			const x = Math.round(effect.x * videoWidth) - result.padLeft;
			const y = Math.round(effect.y * videoHeight) - result.padTop;
			resolved = { pngPath: result.pngPath, x, y, localStart, localEnd,
				overlayWidth: result.width, overlayHeight: result.height };
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

		// Propagate drawAfterZoom flag
		resolved.drawAfterZoom = effect.drawAfterZoom;

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

		results.push(resolved);
	}
	return results;
}

/**
 * Find view effects that overlap a clip's composition window.
 */
export function resolveViewEffects(
	effectEntries: EffectEntry[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	clipDur: number
): ResolvedView[] {
	if (!effectEntries) return [];
	const results: ResolvedView[] = [];
	for (const effect of effectEntries) {
		if (effect.type !== 'view') continue;
		const effectEnd = effect.startTime + effect.duration;
		if (effect.startTime >= clipCompEnd || effectEnd <= clipCompStart) continue;

		const localStart = Math.max(0, effect.startTime - clipCompStart);
		const localEnd = Math.min(clipDur, effectEnd - clipCompStart);
		results.push({
			localStart, localEnd,
			sourceType: effect.viewSourceType,
			srcStartX: effect.viewSourceStartX ?? 0,
			srcStartY: effect.viewSourceStartY ?? 0,
			srcStartW: effect.viewSourceStartW ?? 1,
			srcStartH: effect.viewSourceStartH ?? 1,
			srcEndX: effect.viewSourceEndX ?? effect.viewSourceStartX ?? 0,
			srcEndY: effect.viewSourceEndY ?? effect.viewSourceStartY ?? 0,
			srcEndW: effect.viewSourceEndW ?? effect.viewSourceStartW ?? 1,
			srcEndH: effect.viewSourceEndH ?? effect.viewSourceStartH ?? 1,
			destX: effect.viewDestX ?? 0,
			destY: effect.viewDestY ?? 0,
			destW: effect.viewDestW ?? 1,
			destH: effect.viewDestH ?? 1,
			zOrder: effect.viewZOrder ?? 0,
			sourceTrack: effect.viewSourceTrack ?? 0,
		});
	}
	return results.sort((a, b) => a.zOrder - b.zOrder);
}

/**
 * Find zoom-pan effects that overlap a clip's composition window.
 */
export function resolveZoomPanEffects(
	effectEntries: EffectEntry[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	clipDur: number
): ResolvedZoomPan[] {
	if (!effectEntries) return [];
	const results: ResolvedZoomPan[] = [];
	for (const effect of effectEntries) {
		if (effect.type !== 'zoom-pan') continue;
		const effectEnd = effect.startTime + effect.duration;
		if (effect.startTime >= clipCompEnd || effectEnd <= clipCompStart) continue;
		const localStart = Math.max(0, effect.startTime - clipCompStart);
		const localEnd = Math.min(clipDur, effectEnd - clipCompStart);
		results.push({
			localStart, localEnd,
			startScale: effect.zoomStartScale ?? 1,
			endScale: effect.zoomEndScale ?? 1.5,
			startX: effect.zoomStartX ?? 0.5,
			startY: effect.zoomStartY ?? 0.5,
			endX: effect.zoomEndX ?? 0.5,
			endY: effect.zoomEndY ?? 0.5,
			easing: effect.zoomEasing ?? 'linear',
		});
	}
	return results;
}

/**
 * Find silence effects that overlap a clip's composition window.
 * Returns local time windows (relative to clip start) where source audio should be muted.
 */
export function resolveSilenceWindows(
	effectEntries: EffectEntry[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	clipDur: number
): { localStart: number; localEnd: number }[] {
	if (!effectEntries) return [];
	const results: { localStart: number; localEnd: number }[] = [];
	for (const effect of effectEntries) {
		if (effect.type !== 'silence') continue;
		const effectEnd = effect.startTime + effect.duration;
		if (effect.startTime >= clipCompEnd || effectEnd <= clipCompStart) continue;
		const localStart = Math.max(0, effect.startTime - clipCompStart);
		const localEnd = Math.min(clipDur, effectEnd - clipCompStart);
		results.push({ localStart, localEnd });
	}
	return results;
}
