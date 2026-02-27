<script lang="ts">
	import { streams, syncOffsets, type ClipRegion } from '$lib/stores/streams.js';
	import { getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { formatDuration } from '$lib/utils.js';

	let {
		clip,
		currentLocalTime,
		onseek
	}: {
		clip: ClipRegion;
		currentLocalTime: number;
		onseek: (localTime: number) => void;
	} = $props();

	let searchQuery = $state('');
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	interface Entry {
		id: number;
		text: string;
		localStart: number;
		localEnd: number;
	}

	// Derive clip-local bounds
	let clipBounds = $derived.by(() => {
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return {
			localStart: clip.startTime - anchor + offset,
			localEnd: clip.endTime - anchor + offset
		};
	});

	// Fetch all transcriptions for the clip range
	const rawEntries = $derived(
		clipBounds
			? await getMultiStreamTranscriptions({
					ranges: [{ streamId: clip.streamId, from: clipBounds.localStart, to: clipBounds.localEnd }]
				})
			: []
	);

	let entries = $derived.by(() => {
		if (!rawEntries || rawEntries.length === 0 || !clipBounds) return [] as Entry[];
		return rawEntries.map((e) => ({
			id: e.id,
			text: e.text,
			localStart: e.startTime,
			localEnd: e.endTime
		}));
	});

	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return entries;
		const q = searchQuery.trim().toLowerCase();
		return entries.filter((e) => e.text.toLowerCase().includes(q));
	});

	// Find the currently-spoken entry (binary search for last entry with localStart <= now)
	let activeEntryIndex = $derived.by(() => {
		const now = currentLocalTime;
		if (filteredEntries.length === 0) return -1;
		let lo = 0,
			hi = filteredEntries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (filteredEntries[mid].localStart <= now) lo = mid + 1;
			else hi = mid;
		}
		if (lo === 0) return -1;
		const candidate = lo - 1;
		// Prefer exact match (playhead within range)
		if (now < filteredEntries[candidate].localEnd) return candidate;
		// Fallback: last entry that started before now
		return candidate;
	});

	// Auto-scroll active entry to center (suppressed briefly after manual scroll)
	$effect(() => {
		const idx = activeEntryIndex;
		if (idx < 0 || !listEl || userScrolled) return;
		const activeEl = listEl.querySelector(`[data-index="${idx}"]`);
		if (activeEl) {
			activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
	});

	function handleListScroll() {
		userScrolled = true;
		if (scrollTimeout) clearTimeout(scrollTimeout);
		scrollTimeout = setTimeout(() => {
			userScrolled = false;
		}, 3000);
	}

	$effect(() => {
		return () => {
			if (scrollTimeout) clearTimeout(scrollTimeout);
		};
	});

	function fmtLocal(seconds: number): string {
		if (!clipBounds) return '';
		return formatDuration(seconds - clipBounds.localStart);
	}

	function clearSearch() {
		searchQuery = '';
	}
</script>

<div class="transcript-panel">
	<div class="panel-header">
		<span class="panel-title">Transcript</span>
		<span class="entry-count">{filteredEntries.length}</span>
	</div>

	<div class="search-bar">
		<input type="text" class="search-input" placeholder="Search transcripts..." bind:value={searchQuery} />
		{#if searchQuery}
			<button class="search-clear" onclick={clearSearch}>&times;</button>
		{/if}
	</div>

	<div class="entry-list" bind:this={listEl} onscroll={handleListScroll}>
		{#each filteredEntries as entry, i (entry.id)}
			<button
				class="entry-row"
				class:active={i === activeEntryIndex}
				class:future={entry.localStart > currentLocalTime}
				data-index={i}
				onclick={() => onseek(entry.localStart)}
			>
				<span class="entry-time">{fmtLocal(entry.localStart)}</span>
				<p class="entry-text">{entry.text}</p>
			</button>
		{/each}

		{#if filteredEntries.length === 0}
			<div class="empty-entries">
				{#if searchQuery}
					<p>No matches for &ldquo;{searchQuery}&rdquo;</p>
				{:else}
					<p>No transcriptions</p>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.transcript-panel {
		width: 340px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		background: #0f0f23;
		border-left: 1px solid #1a1a2e;
		height: 100%;
		overflow: hidden;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: #0a0a1a;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
	}

	.panel-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: #e0e0ff;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.entry-count {
		font-size: 0.65rem;
		color: #666;
		background: #1a1a2e;
		padding: 2px 6px;
		border-radius: 8px;
	}

	.search-bar {
		padding: 8px;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
		position: relative;
	}

	.search-input {
		width: 100%;
		background: #0a0a1a;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 6px 28px 6px 8px;
		outline: none;
		box-sizing: border-box;
	}

	.search-input:focus {
		border-color: #7c3aed;
	}

	.search-input::placeholder {
		color: #555;
	}

	.search-clear {
		position: absolute;
		right: 14px;
		top: 50%;
		transform: translateY(-50%);
		background: none;
		border: none;
		color: #666;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 2px 4px;
		line-height: 1;
	}

	.search-clear:hover {
		color: #aaa;
	}

	.entry-list {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0f0f23;
	}

	.entry-list::-webkit-scrollbar {
		width: 6px;
	}

	.entry-list::-webkit-scrollbar-track {
		background: #0f0f23;
	}

	.entry-list::-webkit-scrollbar-thumb {
		background: #2a2a4a;
		border-radius: 3px;
	}

	.entry-row {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		border-bottom: 1px solid #111;
		border-left: 2px solid transparent;
		padding: 8px 12px;
		cursor: pointer;
		transition: background 0.1s;
		font-family: inherit;
	}

	.entry-row:hover {
		background: #1a1a2e;
	}

	.entry-row.active {
		background: rgba(124, 58, 237, 0.15);
		border-left-color: #7c3aed;
	}

	.entry-row.future {
		opacity: 0.4;
	}

	.entry-row.future.active {
		opacity: 1;
	}

	.entry-time {
		font-size: 0.6rem;
		color: #555;
		font-family: monospace;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
		padding-top: 2px;
		min-width: 3em;
	}

	.entry-text {
		font-size: 0.75rem;
		color: #ccc;
		line-height: 1.4;
		margin: 0;
		word-break: break-word;
	}

	.entry-row.active .entry-text {
		color: #e0e0ff;
	}

	.empty-entries {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 24px 12px;
		color: #555;
		font-size: 0.75rem;
		text-align: center;
		gap: 4px;
	}

	.empty-entries p {
		margin: 0;
	}
</style>
