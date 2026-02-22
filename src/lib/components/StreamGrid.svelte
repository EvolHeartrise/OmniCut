<script lang="ts">
	import StreamTile from './StreamTile.svelte';
	import {
		streams,
		focusedStreamId,
		soloStreamId,
		masterTime,
		syncOffsets,
		streamPlaybackStates
	} from '$lib/stores/streams.js';
	import { trackKeyFor } from '$lib/utils.js';

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

	/** Get the known duration for a stream: prefer server-side durationSeconds, fall back to HLS-reported duration. */
	function getDuration(s: (typeof activeStreams)[number]): number {
		if (s.durationSeconds != null && s.durationSeconds > 0) return s.durationSeconds;
		const pb = $streamPlaybackStates[s.id];
		return pb?.duration ?? 0;
	}

	/** Check whether the master playhead is inside a stream's time range. */
	function containsPlayhead(s: (typeof activeStreams)[number], dur: number): boolean {
		const off = $syncOffsets[s.id] || 0;
		const anchor = s.startedAt / 1000;
		return $masterTime >= anchor - off && $masterTime <= anchor + dur - off;
	}

	// Only show streams whose track bar intersects the master playhead.
	// VODs with known duration that don't intersect are filtered out.
	// Live streams or VODs without any duration info are kept visible.
	let visibleStreams = $derived(
		activeStreams.filter((s) => {
			const dur = getDuration(s);
			if (dur === 0) return true; // No duration known yet — keep visible
			return containsPlayhead(s, dur);
		})
	);

	// One video player per track: VODs from the same channel share a track,
	// so keep only the best candidate (the one the playhead is actually over).
	// If no VOD on the track contains the playhead, the track gets no player.
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
			const sDur = getDuration(s);
			const eDur = getDuration(existing);
			const sContains = sDur > 0 && containsPlayhead(s, sDur);
			const eContains = eDur > 0 && containsPlayhead(existing, eDur);

			if (sContains && !eContains) {
				best.set(trackKey, s);
			} else if (!sContains && !eContains && sDur > 0 && eDur === 0) {
				// Neither contains playhead but this one has known duration — prefer it
				best.set(trackKey, s);
			}
		}

		// Remove VOD entries where the selected stream doesn't actually contain the playhead
		// and has a known duration (i.e. we know for sure the playhead is in a gap).
		for (const [key, s] of best) {
			if (s.sourceType === 'live') continue;
			const dur = getDuration(s);
			if (dur > 0 && !containsPlayhead(s, dur)) best.delete(key);
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
			<StreamTile
				{stream}
				focused={isSolo || (stream.id === focused && hasFocus)}
				trackNumber={trackKeys.indexOf(trackKeyFor(stream)) + 1}
			/>
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
