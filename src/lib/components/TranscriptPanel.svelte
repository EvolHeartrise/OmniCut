<script lang="ts">
	import { masterTime, seekRequest, streams, syncOffsets, transcriptions, type TranscriptionEntry, type ClipRegion } from '$lib/stores/streams.js';
	import { createPanelQueryState } from '$lib/panelQueryRanges.svelte.js';
	import { getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { formatTime, formatDuration } from '$lib/utils.js';

	let {
		clip,
		currentLocalTime,
		onseek
	}: {
		clip?: ClipRegion;
		currentLocalTime?: number;
		onseek?: (localTime: number) => void;
	} = $props();

	const isClipMode = $derived(!!clip);

	let searchQuery = $state('');
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	interface Entry {
		id: number;
		text: string;
		/** Time value used for binary search (master-time in multi mode, local-time in clip mode) */
		sortStart: number;
		sortEnd: number;
		/** Formatted display time */
		displayTime: string;
		/** For multi mode: channel name */
		channel?: string;
		/** For multi mode: stream color */
		color?: string;
	}

	// --- Multi-stream mode ---
	const queryState = !clip ? createPanelQueryState() : null;

	const multiRawEntries = $derived(
		queryState ? await getMultiStreamTranscriptions({ ranges: queryState.ranges }) : null
	);

	// Feed StreamTile captions from the transcript data
	$effect(() => {
		const data = multiRawEntries;
		if (!data) return;
		const grouped: Record<string, TranscriptionEntry[]> = {};
		for (const r of data) {
			if (!grouped[r.streamId]) grouped[r.streamId] = [];
			grouped[r.streamId].push({ id: r.id, text: r.text, startTime: r.startTime, endTime: r.endTime });
		}
		transcriptions.set(grouped);
	});

	// --- Clip mode ---
	let clipBounds = $derived.by(() => {
		if (!clip) return null;
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return {
			localStart: clip.startTime - anchor + offset,
			localEnd: clip.endTime - anchor + offset
		};
	});

	const clipRawEntries = $derived(
		clip && clipBounds
			? await getMultiStreamTranscriptions({
					ranges: [{ streamId: clip.streamId, from: clipBounds.localStart, to: clipBounds.localEnd }]
				})
			: null
	);

	// --- Unified entries ---
	let entries = $derived.by((): Entry[] => {
		if (!isClipMode && multiRawEntries) {
			const streamLookup = new Map(queryState!.visibleStreams.map((s) => [s.id, s]));
			return multiRawEntries.map((e) => {
				const s = streamLookup.get(e.streamId);
				const masterStart = e.startTime + (s ? s.anchor - s.offset : 0);
				const masterEnd = e.endTime + (s ? s.anchor - s.offset : 0);
				return {
					id: e.id,
					text: e.text,
					sortStart: masterStart,
					sortEnd: masterEnd,
					displayTime: formatTime(masterStart),
					channel: s?.channel || '',
					color: s?.color || '#888'
				};
			});
		}
		if (isClipMode && clipRawEntries && clipBounds) {
			return clipRawEntries.map((e) => ({
				id: e.id,
				text: e.text,
				sortStart: e.startTime,
				sortEnd: e.endTime,
				displayTime: formatDuration(e.startTime - clipBounds.localStart)
			}));
		}
		return [];
	});

	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return entries;
		const q = searchQuery.trim().toLowerCase();
		return entries.filter((e) => e.text.toLowerCase().includes(q));
	});

	// Current time for tracking the active entry
	let now = $derived(isClipMode ? (currentLocalTime ?? 0) : $masterTime);

	// Binary search: find the last entry whose sortStart <= now
	let activeEntryIndex = $derived.by(() => {
		if (filteredEntries.length === 0) return -1;
		let lo = 0,
			hi = filteredEntries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (filteredEntries[mid].sortStart <= now) lo = mid + 1;
			else hi = mid;
		}
		if (lo === 0) return -1;
		const candidate = lo - 1;
		if (now < filteredEntries[candidate].sortEnd) return candidate;
		return candidate;
	});

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

	function handleSeek(entry: Entry) {
		if (isClipMode && onseek) {
			onseek(entry.sortStart);
		} else {
			seekRequest.update((r) => ({ time: entry.sortStart, seq: r.seq + 1 }));
		}
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
				class:future={isClipMode && entry.sortStart > now}
				data-index={i}
				onclick={() => handleSeek(entry)}
			>
				{#if entry.channel != null}
					<div class="entry-meta">
						<span class="color-dot" style="background: {entry.color}"></span>
						<span class="entry-channel">{entry.channel}</span>
						<span class="entry-time">{entry.displayTime}</span>
					</div>
					<p class="entry-text">{entry.text}</p>
				{:else}
					<span class="entry-time">{entry.displayTime}</span>
					<p class="entry-text">{entry.text}</p>
				{/if}
			</button>
		{/each}

		{#if filteredEntries.length === 0}
			<div class="empty-entries">
				{#if searchQuery}
					<p>No matches for &ldquo;{searchQuery}&rdquo;</p>
				{:else}
					<p>No transcriptions{isClipMode ? '' : ' yet'}</p>
					{#if !isClipMode}
						<p class="empty-hint">Transcriptions appear as streams are captured</p>
					{/if}
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
		flex-wrap: wrap;
		gap: 0;
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

	.entry-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
		width: 100%;
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

	.empty-hint {
		font-size: 0.65rem;
		color: #444;
	}
</style>
