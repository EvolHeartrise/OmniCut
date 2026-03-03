/**
 * View effect filter builders for FFmpeg.
 * Builds crop, scale, and canvas composition filters for view effects.
 */

import type { ResolvedView } from './exporterTypes.js';

/**
 * Build FFmpeg filter chain for view effects.
 * Uses canvas composition: black background with views overlaid.
 * Single full-canvas view: simplified to crop+scale (no canvas needed).
 */
export function buildViewFilter(
	inputLabel: string,
	outputLabel: string,
	views: ResolvedView[],
	trimStart: number,
	srcW: number,
	srcH: number,
	outW: number,
	outH: number,
	fps: number,
	camBounds?: { camX: number; camY: number; camW: number; camH: number } | null
): string {
	if (views.length === 0) return '';

	// Optimization: single full-canvas view — skip canvas composition
	if (views.length === 1) {
		const v = views[0];
		const isFullDest = v.destX === 0 && v.destY === 0 && v.destW === 1 && v.destH === 1;
		if (isFullDest) {
			return buildViewCropScale(inputLabel, outputLabel, v, trimStart, srcW, srcH, outW, outH, camBounds);
		}
	}

	// General case: canvas composition
	let filter = '';

	// When multiple views reference the same source, we must split it —
	// FFmpeg labels can only be consumed once.
	const viewInputLabels: string[] = [];
	if (views.length > 1) {
		const splitLabels = views.map((_, vi) => `[bv${vi}]`).join('');
		filter += `;[${inputLabel}]split=${views.length}${splitLabels}`;
		for (let vi = 0; vi < views.length; vi++) viewInputLabels.push(`bv${vi}`);
	} else {
		viewInputLabels.push(inputLabel);
	}

	const canvasLabel = `vcanvas`;
	filter += `;color=black:s=${outW}x${outH}:d=999:r=${fps}[${canvasLabel}]`;
	let prevLabel = canvasLabel;

	for (let vi = 0; vi < views.length; vi++) {
		const v = views[vi];
		const nextLabel = vi === views.length - 1 ? outputLabel : `vw${vi}`;
		const T0 = (trimStart + v.localStart).toFixed(3);
		// Pad T1 by one frame to prevent the last output frame (after -ss seek
		// misalignment) from falling outside the enable window and showing the
		// black canvas as a single-frame flash between concatenated clips.
		const T1 = (trimStart + v.localEnd + 1 / fps).toFixed(3);

		const destPxW = Math.round(v.destW * outW);
		const destPxH = Math.round(v.destH * outH);
		const slotLabel = `vslot${vi}`;

		// Build crop + cover-fit scale for this view's source
		filter += buildViewCropScale(viewInputLabels[vi], slotLabel, v, trimStart, srcW, srcH, destPxW, destPxH, camBounds);

		const ox = Math.round(v.destX * outW);
		const oy = Math.round(v.destY * outH);
		filter += `;[${prevLabel}][${slotLabel}]overlay=${ox}:${oy}:enable='between(t,${T0},${T1})'[${nextLabel}]`;
		prevLabel = nextLabel;
	}

	return filter;
}

/**
 * Build a crop + cover-fit scale filter for a single view.
 * Handles all source types: full, camera, and custom/animated.
 * Produces output at exactly outW x outH with cover-fit (center-cropped).
 */
export function buildViewCropScale(
	inputLabel: string,
	outputLabel: string,
	view: ResolvedView,
	trimStart: number,
	srcW: number,
	srcH: number,
	outW: number,
	outH: number,
	camBounds?: { camX: number; camY: number; camW: number; camH: number } | null
): string {
	const coverFit = `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`;

	if (view.sourceType === 'camera' && camBounds) {
		const cx = Math.round(camBounds.camX * srcW);
		const cy = Math.round(camBounds.camY * srcH);
		const cw = Math.round(camBounds.camW * srcW);
		const ch = Math.round(camBounds.camH * srcH);
		return `;[${inputLabel}]crop=${cw}:${ch}:${cx}:${cy},${coverFit}[${outputLabel}]`;
	}

	if (view.sourceType === 'full') {
		return `;[${inputLabel}]${coverFit}[${outputLabel}]`;
	}

	// Custom/animated source crop — use animated crop expressions
	const isStatic = view.srcStartW === view.srcEndW && view.srcStartH === view.srcEndH
		&& view.srcStartX === view.srcEndX && view.srcStartY === view.srcEndY;

	if (isStatic) {
		// Static crop — simple integer crop
		const cw = Math.max(2, Math.round(view.srcStartW * srcW));
		const ch = Math.max(2, Math.round(view.srcStartH * srcH));
		const cx = Math.round(view.srcStartX * srcW);
		const cy = Math.round(view.srcStartY * srcH);
		return `;[${inputLabel}]crop=${cw}:${ch}:${cx}:${cy},${coverFit}[${outputLabel}]`;
	}

	// Animated crop — use FFmpeg expressions with time-based interpolation
	const T0 = (trimStart + view.localStart).toFixed(3);
	const T1 = (trimStart + view.localEnd).toFixed(3);
	const durExpr = `(${T1}-${T0}+0.001)`;

	function lerp(start: number, end: number, dim: number, fallback: number) {
		if (start === end) return `${Math.round(start * dim)}`;
		const frac = `clip((t-${T0})/${durExpr},0,1)`;
		const s = start * dim;
		const e = end * dim;
		return `if(between(t,${T0},${T1}),${s.toFixed(1)}+(${(e - s).toFixed(1)})*${frac},${(fallback * dim).toFixed(1)})`;
	}

	const wExpr = lerp(view.srcStartW, view.srcEndW, srcW, view.srcEndW);
	const hExpr = lerp(view.srcStartH, view.srcEndH, srcH, view.srcEndH);
	const xExpr = lerp(view.srcStartX, view.srcEndX, srcW, view.srcEndX);
	const yExpr = lerp(view.srcStartY, view.srcEndY, srcH, view.srcEndY);

	return `;[${inputLabel}]crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}':exact=1,${coverFit}[${outputLabel}]`;
}
