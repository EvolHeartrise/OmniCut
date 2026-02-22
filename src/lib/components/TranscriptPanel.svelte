<script lang="ts">
	import {
		masterTime,
		seekRequest,
		transcriptions,
		type TranscriptionEntry
	} from '$lib/stores/streams.js';
	import { createPanelQueryState } from '$lib/panelQueryRanges.svelte.js';
	import { getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { formatTime } from '$lib/utils.js';

	let searchQuery = $state('');
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	interface TaggedEntry {
		id: number;
		streamId: string;
		channel: string;
		color: string;
		text: string;
		masterStart: number; // epoch seconds
		masterEnd: number;
	}

	// Shared debounced query state (visible streams + windowed ranges)
	const queryState = createPanelQueryState();

	// Fetch transcriptions via remote query — re-fetches when ranges change
	const rawEntries = $derived(await getMultiStreamTranscriptions({ ranges: queryState.ranges }));

	// Feed StreamTile captions from the wider ±120s window (superset of ±60s caption window)
	$effect(() => {
		const data = rawEntries;
		if (!data) return;
		const grouped: Record<string, TranscriptionEntry[]> = {};
		for (const r of data) {
			if (!grouped[r.streamId]) grouped[r.streamId] = [];
			grouped[r.streamId].push({ id: r.id, text: r.text, startTime: r.startTime, endTime: r.endTime });
		}
		transcriptions.set(grouped);
	});

	// Transform server data to TaggedEntry format with master-time positioning
	let fetchedEntries = $derived.by(() => {
		if (!rawEntries || rawEntries.length === 0) return [] as TaggedEntry[];
		const streamLookup = new Map(queryState.visibleStreams.map((s) => [s.id, s]));
		return rawEntries.map((e) => {
			const s = streamLookup.get(e.streamId);
			return {
				id: e.id,
				streamId: e.streamId,
				channel: s?.channel || '',
				color: s?.color || '#888',
				text: e.text,
				masterStart: e.startTime + (s ? s.anchor - s.offset : 0),
				masterEnd: e.endTime + (s ? s.anchor - s.offset : 0)
			};
		});
	});

	// Apply search filter
	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return fetchedEntries;
		const q = searchQuery.trim().toLowerCase();
		return fetchedEntries.filter((e) => e.text.toLowerCase().includes(q));
	});

	// Find the active entry based on current master playhead (binary search)
	let activeEntryIndex = $derived.by(() => {
		const now = $masterTime;
		const entries = filteredEntries;
		if (entries.length === 0) return -1;

		// Binary search: find the last entry whose masterStart <= now
		let lo = 0, hi = entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (entries[mid].masterStart <= now) lo = mid + 1;
			else hi = mid;
		}
		// lo is now the first entry with masterStart > now; lo-1 is the candidate
		if (lo === 0) return -1;
		const candidate = lo - 1;
		// Prefer exact match (playhead within range)
		if (now < entries[candidate].masterEnd) return candidate;
		// Fallback: last entry that started before now
		return candidate;
	});

	// Auto-scroll to active entry (suppressed briefly after manual scroll)
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

	// Clean up scroll timeout on unmount
	$effect(() => {
		return () => {
			if (scrollTimeout) clearTimeout(scrollTimeout);
		};
	});

	function seekToEntry(entry: TaggedEntry) {
		seekRequest.update((r) => ({ time: entry.masterStart, seq: r.seq + 1 }));
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
		<input
			type="text"
			class="search-input"
			placeholder="Search transcripts..."
			bind:value={searchQuery}
		/>
		{#if searchQuery}
			<button class="search-clear" onclick={clearSearch}>&times;</button>
		{/if}
	</div>

	<div class="entry-list" bind:this={listEl} onscroll={handleListScroll}>
		{#each filteredEntries as entry, i (entry.id)}
			<button
				class="entry-row"
				class:active={i === activeEntryIndex}
				data-index={i}
				onclick={() => seekToEntry(entry)}
			>
				<div class="entry-meta">
					<span class="color-dot" style="background: {entry.color}"></span>
					<span class="entry-channel">{entry.channel}</span>
					<span class="entry-time">{formatTime(entry.masterStart)}</span>
				</div>
				<p class="entry-text">{entry.text}</p>
			</button>
		{/each}

		{#if filteredEntries.length === 0}
			<div class="empty-entries">
				{#if searchQuery}
					<p>No matches for &ldquo;{searchQuery}&rdquo;</p>
				{:else}
					<p>No transcriptions yet</p>
					<p class="empty-hint">Transcriptions appear as streams are captured</p>
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
		display: block;
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

	.entry-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
	}

	.color-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.entry-channel {
		font-size: 0.65rem;
		color: #888;
		font-weight: 600;
	}

	.entry-time {
		font-size: 0.6rem;
		color: #555;
		font-family: monospace;
		font-variant-numeric: tabular-nums;
		margin-left: auto;
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

	.empty-hint {
		font-size: 0.65rem;
		color: #444;
	}
</style>
