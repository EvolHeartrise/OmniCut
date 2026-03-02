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

// --- Shared timeline utilities ---

/**
 * Tick interval candidates for time rulers. Returns the smallest interval
 * that keeps ticks at least `minPixelGap` pixels apart at the given pps.
 */
const TICK_CANDIDATES = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 43200, 86400];

export function computeTickInterval(pixelsPerSecond: number, minPixelGap: number = 60): number {
	for (const c of TICK_CANDIDATES) {
		if (c * pixelsPerSecond >= minPixelGap) return c;
	}
	return 86400;
}

/**
 * Handle wheel events on the timeline:
 *   - Plain wheel: zoom in/out (cursor-stable)
 *   - Shift+Wheel: horizontal pan
 *   - Ctrl+Wheel: pass through for vertical track scrolling
 * Returns the new pixelsPerSecond if a zoom occurred, or null if the event was a pan/noop.
 */
export function handleTimelineWheel(
	e: WheelEvent,
	scrollAreaEl: HTMLDivElement | null,
	pixelsPerSecond: number,
	timelineStart: number,
	minPps: number,
	maxPps: number,
	setIgnoreScroll: () => void
): number | null {
	if (e.shiftKey) {
		e.preventDefault();
		if (!scrollAreaEl) return null;
		scrollAreaEl.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
		return null;
	} else if (e.ctrlKey) {
		// Let Ctrl+Wheel pass through for vertical track scrolling
		return null;
	}
	// Plain wheel: zoom
	e.preventDefault();
	if (!scrollAreaEl) return null;
	const { newPps, scheduleScrollRestore } = applyTimelineZoom(
		e,
		scrollAreaEl,
		pixelsPerSecond,
		timelineStart,
		minPps,
		maxPps
	);
	scheduleScrollRestore(setIgnoreScroll);
	return newPps;
}

/**
 * Zoom in/out by a 1.5x factor, clamped to min/max.
 */
export function zoomIn(pixelsPerSecond: number, minPps: number, maxPps: number): number {
	return clampPps(pixelsPerSecond * 1.5, minPps, maxPps);
}

export function zoomOut(pixelsPerSecond: number, minPps: number, maxPps: number): number {
	return clampPps(pixelsPerSecond / 1.5, minPps, maxPps);
}

/**
 * Re-center the scroll area so the playhead is in the middle.
 */
export function reCenter(scrollAreaEl: HTMLDivElement | null, playheadX: number, setIgnoreScroll: () => void): void {
	if (scrollAreaEl) {
		setIgnoreScroll();
		scrollAreaEl.scrollLeft = playheadX - scrollAreaEl.clientWidth / 2;
	}
}
