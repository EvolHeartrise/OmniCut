<script lang="ts">
	import StreamTile from './StreamTile.svelte';
	import { streams, focusedStreamId } from '$lib/stores/streams.js';

	$: activeStreams = $streams.filter((s) => s.status !== 'stopped');
	$: focused = $focusedStreamId;

	// Calculate grid layout based on number of streams
	$: gridClass = getGridClass(activeStreams.length, focused);

	function getGridClass(count: number, focusedId: string | null): string {
		if (focusedId) return 'grid-focused';
		if (count <= 1) return 'grid-1';
		if (count <= 2) return 'grid-2';
		if (count <= 4) return 'grid-4';
		return 'grid-6';
	}
</script>

<div class="stream-grid {gridClass}">
	{#each activeStreams as stream (stream.id)}
		<div class="grid-item" class:is-focused={stream.id === focused} class:is-thumbnail={focused !== null && stream.id !== focused}>
			<StreamTile {stream} focused={stream.id === focused} />
		</div>
	{/each}

	{#if activeStreams.length === 0}
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
		align-content: start;
	}

	.grid-1 {
		grid-template-columns: 1fr;
	}

	.grid-2 {
		grid-template-columns: 1fr 1fr;
	}

	.grid-4 {
		grid-template-columns: 1fr 1fr;
	}

	.grid-6 {
		grid-template-columns: 1fr 1fr 1fr;
	}

	.grid-focused {
		grid-template-columns: 3fr 1fr;
		grid-template-rows: auto;
	}

	.grid-item {
		min-width: 0;
	}

	.grid-item.is-focused {
		grid-row: 1 / -1;
		grid-column: 1;
	}

	.grid-item.is-thumbnail {
		max-height: 200px;
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
