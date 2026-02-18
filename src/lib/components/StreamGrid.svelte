<script lang="ts">
	import StreamTile from './StreamTile.svelte';
	import { streams, focusedStreamId, soloStreamId, masterTime, syncOffsets, streamPlaybackStates } from '$lib/stores/streams.js';

	let activeStreams = $derived($streams);

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

	let focused = $derived($focusedStreamId);
	let solo = $derived($soloStreamId);
	let isSolo = $derived(!!solo && visibleStreams.some((s) => s.id === solo));
	let hasFocus = $derived(!isSolo && !!focused && visibleStreams.some((s) => s.id === focused));
	let sidebarCount = $derived(hasFocus ? Math.max(1, visibleStreams.length - 1) : 0);
	let gridClass = $derived(isSolo ? 'grid-1' : hasFocus ? '' : getGridClass(visibleStreams.length));
	let displayStreams = $derived(isSolo ? visibleStreams.filter((s) => s.id === solo) : visibleStreams);

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
			<StreamTile {stream} focused={isSolo || (stream.id === focused && hasFocus)} trackNumber={activeStreams.indexOf(stream) + 1} />
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
