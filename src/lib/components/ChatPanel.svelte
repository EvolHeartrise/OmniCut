<script lang="ts">
	import {
		streams,
		syncOffsets,
		focusedStreamId,
		soloStreamId,
		masterTime,
		seekRequest
	} from '$lib/stores/streams.js';
	import { TRACK_COLORS as COLORS } from '$lib/constants.js';
	import { getMultiStreamChat } from '$lib/streams.remote';

	const FETCH_WINDOW = 120; // ±120 seconds around playhead
	const REFETCH_THRESHOLD = 30; // re-fetch when playhead drifts 30s from last center

	let searchQuery = $state('');
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	interface ChatEntry {
		streamId: string;
		channel: string;
		color: string;
		username: string;
		text: string;
		masterTime: number; // epoch seconds
	}

	// Debounced center for query args — only updates when playhead drifts far enough.
	// IMPORTANT: we must NOT clear+reschedule on every frame, or the timeout never fires
	// during continuous playback. Instead, only schedule if no timer is already pending.
	let debouncedCenter = $state($masterTime);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const now = $masterTime;
		if (Math.abs(now - debouncedCenter) >= REFETCH_THRESHOLD && !debounceTimer) {
			const snapshotTime = now;
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				debouncedCenter = snapshotTime;
			}, 300);
		}
	});

	// Build stream lookup for visible streams
	let visibleStreams = $derived.by(() => {
		const allStreams = $streams;
		const offsets = $syncOffsets;
		const focused = $focusedStreamId || $soloStreamId;

		return allStreams
			.filter((s) => !focused || s.id === focused)
			.map((s, i) => ({
				id: s.id,
				channel: s.channel,
				anchor: s.startedAt / 1000,
				offset: offsets[s.id] || 0,
				color: COLORS[allStreams.indexOf(s) % COLORS.length]
			}));
	});

	// Derive query ranges from debounced center + visible streams
	let chatRanges = $derived(
		visibleStreams.map((s) => {
			const localCenter = debouncedCenter - s.anchor + s.offset;
			return {
				streamId: s.id,
				from: Math.max(0, localCenter - FETCH_WINDOW),
				to: localCenter + FETCH_WINDOW
			};
		})
	);

	// Fetch chat messages via remote query — re-fetches when chatRanges changes
	const rawMessages = $derived(await getMultiStreamChat({ ranges: chatRanges }));

	// Transform server data to ChatEntry format with master-time positioning
	let fetchedEntries = $derived.by(() => {
		if (!rawMessages || rawMessages.length === 0) return [] as ChatEntry[];
		const streamLookup = new Map(visibleStreams.map((s) => [s.id, s]));
		return rawMessages.map((m) => {
			const s = streamLookup.get(m.streamId);
			return {
				streamId: m.streamId,
				channel: s?.channel || '',
				color: s?.color || '#888',
				username: m.username,
				text: m.text,
				masterTime: m.timestamp + (s ? s.anchor - s.offset : 0)
			};
		});
	});

	// Apply search filter
	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return fetchedEntries;
		const q = searchQuery.trim().toLowerCase();
		return fetchedEntries.filter(
			(e) => e.text.toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
		);
	});

	// Find the active entry based on current master playhead
	let activeEntryIndex = $derived.by(() => {
		const now = $masterTime;
		// Find last entry at or before the playhead
		for (let i = filteredEntries.length - 1; i >= 0; i--) {
			if (filteredEntries[i].masterTime <= now) return i;
		}
		return -1;
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

	function seekToEntry(entry: ChatEntry) {
		seekRequest.update((r) => ({ time: entry.masterTime, seq: r.seq + 1 }));
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

<div class="chat-panel">
	<div class="panel-header">
		<span class="panel-title">Chat</span>
		<span class="entry-count">{filteredEntries.length}</span>
	</div>

	<div class="search-bar">
		<input
			type="text"
			class="search-input"
			placeholder="Search chat..."
			bind:value={searchQuery}
		/>
		{#if searchQuery}
			<button class="search-clear" onclick={clearSearch}>&times;</button>
		{/if}
	</div>

	<div class="entry-list" bind:this={listEl} onscroll={handleListScroll}>
		{#each filteredEntries as entry, i (i)}
			<button
				class="entry-row"
				class:active={i === activeEntryIndex}
				data-index={i}
				onclick={() => seekToEntry(entry)}
			>
				<div class="entry-meta">
					<span class="color-dot" style="background: {entry.color}"></span>
					<span class="entry-username">{entry.username}</span>
					<span class="entry-time">{formatTime(entry.masterTime)}</span>
				</div>
				<p class="entry-text">{entry.text}</p>
			</button>
		{/each}

		{#if filteredEntries.length === 0}
			<div class="empty-entries">
				{#if searchQuery}
					<p>No matches for &ldquo;{searchQuery}&rdquo;</p>
				{:else}
					<p>No chat messages nearby</p>
					<p class="empty-hint">Chat messages appear around the playhead position</p>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.chat-panel {
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
		padding: 6px 12px;
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
		margin-bottom: 1px;
	}

	.color-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.entry-username {
		font-size: 0.7rem;
		color: #a78bfa;
		font-weight: 700;
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
		line-height: 1.3;
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
