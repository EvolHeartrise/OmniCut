<script lang="ts">
	import StreamTile from './StreamTile.svelte';
	import { streams, focusedStreamId, soloStreamId, masterTime, syncOffsets, streamPlaybackStates } from '$lib/stores/streams.js';

	function trackKeyFor(s: { id: string; sourceType: string; platform: string; channel: string }): string {
		return s.sourceType === 'live' ? s.id : `vod:${s.platform}:${s.channel}`;
	}

	let activeStreams = $derived($streams);

	// Ordered unique track keys (preserves first-appearance order from streams list)
	let trackKeys = $derived.by(() => {
		const seen = new Set<string>();
		const keys: string[] = [];
		for (const s of activeStreams) {
			const key = trackKeyFor(s);
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
		return keys;
	});

	// Only show streams whose track bar intersects the master playhead
	let visibleStreams = $derived(
		activeStreams.filter((s) => {
			const pb = $streamPlaybackStates[s.id];
			if (!pb || pb.duration === 0) return true;
			const offset = $syncOffsets[s.id] || 0;
			const anchor = s.startedAt / 1000;
			const trackStart = anchor - offset;
			const trackEnd = anchor + pb.duration - offset;
			return $masterTime >= trackStart && $masterTime <= trackEnd;
		})
	);

	// One video player per track: VODs from the same channel share a track,
	// so keep only the best candidate (the one the playhead is actually over).
	let onePerTrack = $derived.by(() => {
		const best = new Map<string, (typeof visibleStreams)[number]>();
		for (const s of visibleStreams) {
			if (s.sourceType === 'live') {
				best.set(s.id, s);
				continue;
			}
			const trackKey = `vod:${s.platform}:${s.channel}`;
			const existing = best.get(trackKey);
			if (!existing) {
				best.set(trackKey, s);
				continue;
			}
			// Both are VODs on the same track — prefer the one containing the playhead
			const sPb = $streamPlaybackStates[s.id];
			const ePb = $streamPlaybackStates[existing.id];
			const sOff = $syncOffsets[s.id] || 0;
			const eOff = $syncOffsets[existing.id] || 0;
			const sHas = sPb && sPb.duration > 0;
			const eHas = ePb && ePb.duration > 0;

			const sContains =
				sHas &&
				$masterTime >= s.startedAt / 1000 - sOff &&
				$masterTime <= s.startedAt / 1000 + sPb!.duration - sOff;
			const eContains =
				eHas &&
				$masterTime >= existing.startedAt / 1000 - eOff &&
				$masterTime <= existing.startedAt / 1000 + ePb!.duration - eOff;

			if (sContains && !eContains) {
				best.set(trackKey, s);
			} else if (!sContains && !eContains && sHas && !eHas) {
				// Neither contains playhead but this one has loaded data — prefer it
				best.set(trackKey, s);
			}
		}
		return [...best.values()];
	});

	// Transfer focus/solo when the visible VOD on a focused track changes.
	// Use $effect.pre so store reads/writes happen in the pre-render phase,
	// avoiding reactivity loops from untrack() + mutation in $effect.
	$effect.pre(() => {
		const visible = onePerTrack;
		const curFocused = $focusedStreamId;
		const curSolo = $soloStreamId;

		if (curFocused && !visible.some((s) => s.id === curFocused)) {
			const src = activeStreams.find((s) => s.id === curFocused);
			if (src) {
				const key = trackKeyFor(src);
				const replacement = visible.find((s) => trackKeyFor(s) === key);
				if (replacement) focusedStreamId.set(replacement.id);
			}
		}
		if (curSolo && !visible.some((s) => s.id === curSolo)) {
			const src = activeStreams.find((s) => s.id === curSolo);
			if (src) {
				const key = trackKeyFor(src);
				const replacement = visible.find((s) => trackKeyFor(s) === key);
				if (replacement) soloStreamId.set(replacement.id);
			}
		}
	});

	let focused = $derived($focusedStreamId);
	let solo = $derived($soloStreamId);
	let isSolo = $derived(!!solo && onePerTrack.some((s) => s.id === solo));
	let hasFocus = $derived(!isSolo && !!focused && onePerTrack.some((s) => s.id === focused));
	let sidebarCount = $derived(hasFocus ? Math.max(1, onePerTrack.length - 1) : 0);
	let gridClass = $derived(isSolo ? 'grid-1' : hasFocus ? '' : getGridClass(onePerTrack.length));
	let displayStreams = $derived(isSolo ? onePerTrack.filter((s) => s.id === solo) : onePerTrack);

	function getGridClass(count: number): string {
		if (count <= 1) return 'grid-1';
		if (count <= 2) return 'grid-2';
		if (count <= 4) return 'grid-4';
		return 'grid-6';
	}
</script>

<div
	class="stream-grid {gridClass}"
	class:has-focus={hasFocus}
	style={hasFocus ? `grid-template-rows: repeat(${sidebarCount}, 1fr)` : ''}
>
	{#each displayStreams as stream (stream.id)}
		<div
			class="grid-item"
			class:is-focused={stream.id === focused && hasFocus}
			class:is-sidebar={hasFocus && stream.id !== focused}
		>
			<StreamTile {stream} focused={isSolo || (stream.id === focused && hasFocus)} trackNumber={trackKeys.indexOf(trackKeyFor(stream)) + 1} />
		</div>
	{/each}

	{#if displayStreams.length === 0}
		<div class="empty-state">
			<p class="empty-icon">📡</p>
			<p>No streams active</p>
			<p class="empty-hint">Add a Twitch channel above to get started</p>
		</div>
	{/if}
</div>

<style>
	.stream-grid {
		display: grid;
		gap: 12px;
		padding: 12px;
		flex: 1;
		min-height: 0;
		height: 100%;
	}

	/* --- Unfocused grid layouts --- */
	.grid-1 {
		grid-template-columns: 1fr;
		grid-template-rows: 1fr;
	}

	.grid-2 {
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr;
	}

	.grid-4 {
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
	}

	.grid-6 {
		grid-template-columns: 1fr 1fr 1fr;
		grid-template-rows: 1fr 1fr;
	}

	/* --- Focused layout --- */
	.has-focus {
		grid-template-columns: 3fr 1fr;
	}

	.grid-item {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.is-focused {
		grid-column: 1;
		grid-row: 1 / -1;
	}

	.is-sidebar {
		grid-column: 2;
	}

	.empty-state {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 400px;
		color: #666;
		gap: 4px;
	}

	.empty-icon {
		font-size: 3rem;
		margin-bottom: 8px;
	}

	.empty-hint {
		font-size: 0.85rem;
		color: #555;
	}
</style>
