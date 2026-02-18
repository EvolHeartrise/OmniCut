<script lang="ts">
	import {
		transcriptions,
		streams,
		syncOffsets,
		focusedStreamId,
		soloStreamId,
		masterTime,
		seekRequest,
		type TranscriptionEntry
	} from '$lib/stores/streams.js';

	// Same palette as NLETimeline COLORS for visual consistency
	const COLORS = [
		'#7c3aed',
		'#2563eb',
		'#dc2626',
		'#16a34a',
		'#d97706',
		'#db2777',
		'#0891b2',
		'#84cc16'
	];

	let searchQuery = $state('');
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	interface TaggedEntry {
		streamId: string;
		channel: string;
		color: string;
		text: string;
		masterStart: number; // epoch seconds
		masterEnd: number;
	}

	// Build flat list of all entries with stream metadata, converted to master time
	let allTaggedEntries = $derived.by(() => {
		const allStreams = $streams;
		const allTranscriptions = $transcriptions;
		const offsets = $syncOffsets;
		const focused = $focusedStreamId || $soloStreamId;

		const result: TaggedEntry[] = [];

		for (let i = 0; i < allStreams.length; i++) {
			const stream = allStreams[i];
			// If a stream is focused/solo, only include that stream's transcriptions
			if (focused && stream.id !== focused) continue;

			const entries = allTranscriptions[stream.id];
			if (!entries || entries.length === 0) continue;

			const anchor = stream.startedAt / 1000;
			const offset = offsets[stream.id] || 0;
			const color = COLORS[i % COLORS.length];

			for (const entry of entries) {
				// Convert stream-local time to master (epoch) time:
				// localTime = masterTime - anchor + offset
				// therefore: masterTime = localTime + anchor - offset
				const masterStart = entry.startTime + anchor - offset;
				const masterEnd = entry.endTime + anchor - offset;

				result.push({
					streamId: stream.id,
					channel: stream.channel,
					color,
					text: entry.text,
					masterStart,
					masterEnd
				});
			}
		}

		result.sort((a, b) => a.masterStart - b.masterStart);
		return result;
	});

	// Apply search filter
	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return allTaggedEntries;
		const q = searchQuery.trim().toLowerCase();
		return allTaggedEntries.filter((e) => e.text.toLowerCase().includes(q));
	});

	// Find the active entry based on current master playhead
	let activeEntryIndex = $derived.by(() => {
		const now = $masterTime;
		// Find entry whose master time range contains the current playhead
		for (let i = filteredEntries.length - 1; i >= 0; i--) {
			const e = filteredEntries[i];
			if (now >= e.masterStart && now < e.masterEnd) return i;
		}
		// Fallback: last entry that started before now
		for (let i = filteredEntries.length - 1; i >= 0; i--) {
			if (filteredEntries[i].masterStart <= now) return i;
		}
		return -1;
	});

	// Auto-scroll to active entry (suppressed briefly after manual scroll)
	$effect(() => {
		const idx = activeEntryIndex;
		if (idx < 0 || !listEl || userScrolled) return;

		const activeEl = listEl.querySelector(`[data-index="${idx}"]`);
		if (activeEl) {
			activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	});

	function handleListScroll() {
		userScrolled = true;
		if (scrollTimeout) clearTimeout(scrollTimeout);
		scrollTimeout = setTimeout(() => {
			userScrolled = false;
		}, 3000);
	}

	function seekToEntry(entry: TaggedEntry) {
		seekRequest.update((r) => ({ time: entry.masterStart, seq: r.seq + 1 }));
	}

	function formatTime(epochSec: number): string {
		const d = new Date(epochSec * 1000);
		const h = d.getHours();
		const m = d.getMinutes();
		const s = d.getSeconds();
		return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
		{#each filteredEntries as entry, i (entry.masterStart.toString() + entry.streamId + entry.text.slice(0, 40))}
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
