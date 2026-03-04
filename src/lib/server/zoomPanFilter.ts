/**
 * FFmpeg filter builder for zoom-pan effects.
 * Operates on the already-composited video label by applying scale+crop
 * to simulate a virtual camera zoom and pan.
 *
 * Approach: scale UP the frame by the zoom factor (using eval=frame for
 * per-frame expression evaluation), then crop to the output dimensions
 * at a per-frame (x, y) position determined by the pan.
 *
 * Note: FFmpeg's crop filter evaluates w/h ONCE at init, not per-frame.
 * Only x/y are per-frame. So we must use scale(eval=frame) for the
 * time-dependent zoom, keeping crop dimensions constant.
 */

import type { ResolvedZoomPan } from './exporterTypes.js';
import { ffmpegEasing } from './overlayAnimation.js';

/**
 * Build an FFmpeg filter chain that applies zoom-pan effects to the composited video.
 * Returns the filter string (starting with `;`) and the output label.
 */
export function buildZoomPanFilter(
	inputLabel: string,
	outputLabel: string,
	zoomPans: ResolvedZoomPan[],
	outW: number,
	outH: number,
	trimStart: number
): string {
	if (zoomPans.length === 0) return '';

	let filterGraph = '';
	let prevLabel = inputLabel;

	for (let i = 0; i < zoomPans.length; i++) {
		const zp = zoomPans[i];
		const isLast = i === zoomPans.length - 1;
		const nextLabel = isLast ? outputLabel : `zp${i}`;
		const T0 = (trimStart + zp.localStart).toFixed(3);
		const T1 = (trimStart + zp.localEnd).toFixed(3);
		const dur = zp.localEnd - zp.localStart;

		const isStatic = zp.startScale === zp.endScale &&
			zp.startX === zp.endX && zp.startY === zp.endY;

		if (isStatic && zp.startScale <= 1) {
			// No-op: scale <= 1 with no animation — skip
			if (isLast) {
				filterGraph += `;[${prevLabel}]null[${nextLabel}]`;
			}
			prevLabel = nextLabel;
			continue;
		}

		if (isStatic) {
			// Static zoom: constant scale + crop with enable window.
			// Scale up by zoom factor, then crop to output size centered at (panX, panY).
			const S = zp.startScale;
			const scaledW = Math.round(outW * S);
			const scaledH = Math.round(outH * S);
			// panX/panY represent viewport center in [0,1] of original frame.
			// Crop position centers the viewport at that point, clamped to valid bounds.
			const cropX = Math.max(0, Math.min(scaledW - outW, Math.round(zp.startX * scaledW - outW / 2)));
			const cropY = Math.max(0, Math.min(scaledH - outH, Math.round(zp.startY * scaledH - outH / 2)));

			// When outside the time window, use scale=iw:ih (identity) so crop is also identity.
			// When inside, scale up then crop.
			const swExpr = `if(between(t,${T0},${T1}),${scaledW},${outW})`;
			const shExpr = `if(between(t,${T0},${T1}),${scaledH},${outH})`;
			const cxExpr = `if(between(t,${T0},${T1}),${cropX},0)`;
			const cyExpr = `if(between(t,${T0},${T1}),${cropY},0)`;

			filterGraph += `;[${prevLabel}]scale=w='${swExpr}':h='${shExpr}':eval=frame:flags=bilinear,` +
				`crop=${outW}:${outH}:x='${cxExpr}':y='${cyExpr}',setsar=1[${nextLabel}]`;
		} else {
			// Animated zoom: per-frame scale + crop with easing.
			const p = `clip((t-${T0})/${dur.toFixed(3)},0,1)`;
			const ep = ffmpegEasing(p, zp.easing);

			// Interpolate scale factor
			const scaleExpr = zp.startScale === zp.endScale
				? `${zp.startScale}`
				: `(${zp.startScale}+${(zp.endScale - zp.startScale).toFixed(6)}*${ep})`;

			// Scale up: multiply input dimensions by zoom factor.
			// Use trunc(x/2)*2 to ensure even dimensions for yuv420p.
			const swExpr = `if(between(t,${T0},${T1}),trunc(iw*${scaleExpr}/2)*2,iw)`;
			const shExpr = `if(between(t,${T0},${T1}),trunc(ih*${scaleExpr}/2)*2,ih)`;

			// Interpolate pan positions
			const panXExpr = zp.startX === zp.endX
				? `${zp.startX}`
				: `(${zp.startX}+${(zp.endX - zp.startX).toFixed(6)}*${ep})`;
			const panYExpr = zp.startY === zp.endY
				? `${zp.startY}`
				: `(${zp.startY}+${(zp.endY - zp.startY).toFixed(6)}*${ep})`;

			// Crop position: center viewport at (panX, panY) in original frame.
			// In scaled frame: center = panX * outW * scale, cropX = center - outW/2.
			// Clamp to [0, outW*(scale-1)] to stay within bounds.
			const halfW = outW / 2;
			const halfH = outH / 2;
			const cxExpr = `if(between(t,${T0},${T1}),clip(${panXExpr}*${scaleExpr}*${outW}-${halfW},0,(${scaleExpr}-1)*${outW}),0)`;
			const cyExpr = `if(between(t,${T0},${T1}),clip(${panYExpr}*${scaleExpr}*${outH}-${halfH},0,(${scaleExpr}-1)*${outH}),0)`;

			filterGraph += `;[${prevLabel}]scale=w='${swExpr}':h='${shExpr}':eval=frame:flags=bilinear,` +
				`crop=${outW}:${outH}:x='${cxExpr}':y='${cyExpr}',setsar=1[${nextLabel}]`;
		}

		prevLabel = nextLabel;
	}

	return filterGraph;
}
