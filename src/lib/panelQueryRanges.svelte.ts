/**
 * Shared reactive logic for TranscriptPanel and ChatPanel:
 * debounced playhead tracking + windowed query range derivation.
 *
 * Both panels fetch data in a ±FETCH_WINDOW around the playhead,
 * re-fetching only when the playhead drifts REFETCH_THRESHOLD from the last center.
 */

import {
	streams,
	syncOffsets,
	focusedStreamId,
	soloStreamId,
	masterTime,
	deriveVisibleStreams
} from '$lib/stores/streams.js';
import { TRACK_COLORS as COLORS } from '$lib/constants.js';
import { get } from 'svelte/store';

const FETCH_WINDOW = 120; // ±120 seconds around playhead
const REFETCH_THRESHOLD = 30; // re-fetch when playhead drifts 30s from last center

export interface StreamRange {
	streamId: string;
	from: number;
	to: number;
}

export interface VisibleStreamInfo {
	id: string;
	channel: string;
	color: string;
	anchor: number;
	offset: number;
}

/**
 * Creates debounced query ranges for panel data fetching.
 * Returns reactive getters for visibleStreams and ranges.
 *
 * Must be called inside a Svelte component's reactive context
 * (script block), since it uses $effect and $state.
 */
export function createPanelQueryState() {
	// Mirror store values into reactive $state so effects can track them
	let currentMasterTime = $state(get(masterTime));
	let currentStreams = $state(get(streams));
	let currentOffsets = $state(get(syncOffsets));
	let currentFocused = $state(get(focusedStreamId));
	let currentSolo = $state(get(soloStreamId));

	$effect(() => {
		const unsubs = [
			masterTime.subscribe((v) => { currentMasterTime = v; }),
			streams.subscribe((v) => { currentStreams = v; }),
			syncOffsets.subscribe((v) => { currentOffsets = v; }),
			focusedStreamId.subscribe((v) => { currentFocused = v; }),
			soloStreamId.subscribe((v) => { currentSolo = v; })
		];
		return () => unsubs.forEach((u) => u());
	});

	let debouncedCenter = $state(get(masterTime));
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const now = currentMasterTime;
		if (Math.abs(now - debouncedCenter) >= REFETCH_THRESHOLD && !debounceTimer) {
			const snapshotTime = now;
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				debouncedCenter = snapshotTime;
			}, 300);
		}
	});

	// Clean up debounce timer on unmount
	$effect(() => {
		return () => {
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	});

	const visibleStreams = $derived(
		deriveVisibleStreams(currentStreams, currentOffsets, currentFocused || currentSolo, COLORS)
	);

	const ranges = $derived(
		visibleStreams.map((s) => {
			const localCenter = debouncedCenter - s.anchor + s.offset;
			return {
				streamId: s.id,
				from: Math.max(0, localCenter - FETCH_WINDOW),
				to: localCenter + FETCH_WINDOW
			};
		})
	);

	return {
		get visibleStreams() { return visibleStreams; },
		get ranges() { return ranges; }
	};
}
