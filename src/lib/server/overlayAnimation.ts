/**
 * Overlay animation helpers for FFmpeg filter expressions.
 * Builds animated overlay position, scale, and alpha filter chains.
 */

import type { OverlayAnimation, EasingFunction } from '../types.js';
import type { ResolvedEffect } from './exporterTypes.js';

/** Build an FFmpeg expression that applies an easing function to linear progress `p`. */
export function ffmpegEasing(p: string, easing: EasingFunction): string {
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
