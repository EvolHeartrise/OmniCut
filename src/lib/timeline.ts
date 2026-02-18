import { tick } from 'svelte';

/**
 * Compute new pixels-per-second after a zoom wheel event, keeping the
 * time under the cursor stable.
 *
 * Returns the new pps value and a function to call after the DOM updates
 * to restore the scroll position.
 */
export function applyTimelineZoom(
	e: WheelEvent,
	scrollArea: HTMLDivElement,
	pixelsPerSecond: number,
	timelineStart: number,
	minPps: number,
	maxPps: number
): { newPps: number; scheduleScrollRestore: (setIgnoreScroll: () => void) => void } {
	const rect = scrollArea.getBoundingClientRect();
	const cursorX = e.clientX - rect.left;
	const cursorScrollX = scrollArea.scrollLeft + cursorX;
	const timeUnderCursor = cursorScrollX / pixelsPerSecond + timelineStart;

	const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
	const newPps = clampPps(pixelsPerSecond * factor, minPps, maxPps);

	const scheduleScrollRestore = (setIgnoreScroll: () => void) => {
		tick().then(() => {
			const newCursorScrollX = (timeUnderCursor - timelineStart) * newPps;
			setIgnoreScroll();
			scrollArea.scrollLeft = newCursorScrollX - cursorX;
		});
	};

	return { newPps, scheduleScrollRestore };
}

export function clampPps(pps: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, pps));
}
