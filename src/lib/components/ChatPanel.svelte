<script lang="ts">
	import {
		streams,
		syncOffsets,
		focusedStreamId,
		soloStreamId,
		masterTime,
		masterPlaying,
		seekRequest
	} from '$lib/stores/streams.js';
	import { TRACK_COLORS as COLORS } from '$lib/constants.js';
	import { usernameColor } from '$lib/utils.js';
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
		streamColor: string;
		username: string;
		text: string;
		masterTime: number; // epoch seconds
		userColor: string; // resolved chat color (real or fallback)
	}

	// Debounced center for query args — only updates when playhead drifts far enough.
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
			.map((s) => ({
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
				streamColor: s?.color || '#888',
				username: m.username,
				text: m.text,
				masterTime: m.timestamp + (s ? s.anchor - s.offset : 0),
				userColor: m.color || usernameColor(m.username)
			};
		});
	});

	// Apply search filter
	let searchFiltered = $derived.by(() => {
		if (!searchQuery.trim()) return fetchedEntries;
		const q = searchQuery.trim().toLowerCase();
		return fetchedEntries.filter(
			(e) => e.text.toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
		);
	});

	// Only show messages at or before the current playhead (no future messages)
	let displayEntries = $derived.by(() => {
		const now = $masterTime;
		// Binary search for the cutoff: first entry with masterTime > now
		let lo = 0, hi = searchFiltered.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (searchFiltered[mid].masterTime <= now) lo = mid + 1;
			else hi = mid;
		}
		const all = searchFiltered.slice(0, lo);
		return all.length > 100 ? all.slice(all.length - 100) : all;
	});

	// Auto-scroll to bottom while playing and not manually scrolled up
	$effect(() => {
		const _len = displayEntries.length;
		if (!listEl || userScrolled || !$masterPlaying) return;
		listEl.scrollTop = listEl.scrollHeight;
	});

	function handleListScroll() {
		if (!listEl) return;
		// If near the bottom, re-enable auto-scroll
		const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 50;
		if (atBottom) {
			userScrolled = false;
			if (scrollTimeout) { clearTimeout(scrollTimeout); scrollTimeout = null; }
			return;
		}
		userScrolled = true;
		if (scrollTimeout) clearTimeout(scrollTimeout);
		scrollTimeout = setTimeout(() => { userScrolled = false; }, 5000);
	}

	// Clean up scroll timeout and debounce timer on unmount
	$effect(() => {
		return () => {
			if (scrollTimeout) clearTimeout(scrollTimeout);
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	});

	function seekToEntry(entry: ChatEntry) {
		seekRequest.update((r) => ({ time: entry.masterTime, seq: r.seq + 1 }));
	}

	function scrollToBottom() {
		userScrolled = false;
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	}

	function formatTime(epochSec: number): string {
		const d = new Date(epochSec * 1000);
		return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
	}

	function clearSearch() {
		searchQuery = '';
	}
</script>

<div class="chat-panel">
	<div class="chat-header">
		<span class="header-title">Stream Chat</span>
		<span class="msg-count">{displayEntries.length}</span>
	</div>

	<div class="search-bar">
		<input
			type="text"
			class="search-input"
			placeholder="Filter..."
			bind:value={searchQuery}
		/>
		{#if searchQuery}
			<button class="search-clear" onclick={clearSearch}>&times;</button>
		{/if}
	</div>

	<div class="chat-log" bind:this={listEl} onscroll={handleListScroll}>
		{#each displayEntries as entry (entry.masterTime.toString() + entry.username + entry.text.slice(0, 30))}
			<button class="chat-line" onclick={() => seekToEntry(entry)}>
				<span class="user" style="color:{entry.userColor}">{entry.username}</span><span class="sep">:</span>
				<span class="msg">{entry.text}</span>
			</button>
		{/each}

		{#if displayEntries.length === 0}
			<div class="chat-empty">
				{#if searchQuery}
					<p>No matches for &ldquo;{searchQuery}&rdquo;</p>
				{:else}
					<p>No chat messages</p>
				{/if}
			</div>
		{/if}
	</div>

	{#if userScrolled}
		<button class="scroll-bottom" onclick={scrollToBottom}>
			More messages below
		</button>
	{/if}
</div>

<style>
	.chat-panel {
		width: 340px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		background: #18181b;
		border-left: 1px solid #2a2a2e;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	.chat-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid #2a2a2e;
		flex-shrink: 0;
	}

	.header-title {
		font-size: 0.8rem;
		font-weight: 700;
		color: #efeff1;
	}

	.msg-count {
		font-size: 0.65rem;
		color: #adadb8;
		background: #26262c;
		padding: 2px 6px;
		border-radius: 8px;
	}

	.search-bar {
		padding: 6px 10px;
		border-bottom: 1px solid #2a2a2e;
		flex-shrink: 0;
		position: relative;
	}

	.search-input {
		width: 100%;
		background: #0e0e10;
		border: 1px solid #3a3a3e;
		border-radius: 4px;
		color: #efeff1;
		font-size: 0.75rem;
		padding: 5px 26px 5px 8px;
		outline: none;
		box-sizing: border-box;
	}

	.search-input:focus {
		border-color: #9147ff;
	}

	.search-input::placeholder {
		color: #53535f;
	}

	.search-clear {
		position: absolute;
		right: 16px;
		top: 50%;
		transform: translateY(-50%);
		background: none;
		border: none;
		color: #53535f;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 2px 4px;
		line-height: 1;
	}

	.search-clear:hover {
		color: #adadb8;
	}

	.chat-log {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 4px 0;
		scrollbar-width: thin;
		scrollbar-color: #3a3a3e #18181b;
	}

	.chat-log::-webkit-scrollbar {
		width: 6px;
	}

	.chat-log::-webkit-scrollbar-track {
		background: #18181b;
	}

	.chat-log::-webkit-scrollbar-thumb {
		background: #3a3a3e;
		border-radius: 3px;
	}

	.chat-line {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 2px 12px;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		line-height: 1.4;
		color: #efeff1;
		word-break: break-word;
	}

	.chat-line:hover {
		background: #26262c;
	}

	.ts {
		font-size: 11px;
		color: #53535f;
		font-family: monospace;
		font-variant-numeric: tabular-nums;
		margin-right: 4px;
	}

	.stream-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		margin-right: 3px;
		vertical-align: middle;
	}

	.user {
		font-weight: 700;
		font-size: 13px;
	}

	.sep {
		color: #efeff1;
		margin-right: 4px;
	}

	.msg {
		color: #efeff1;
		font-size: 13px;
	}

	.chat-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 32px 12px;
		color: #53535f;
		font-size: 0.8rem;
		text-align: center;
	}

	.chat-empty p {
		margin: 0;
	}

	.scroll-bottom {
		position: absolute;
		bottom: 8px;
		left: 50%;
		transform: translateX(-50%);
		background: #9147ff;
		color: #fff;
		border: none;
		border-radius: 4px;
		padding: 6px 16px;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		opacity: 0.95;
		z-index: 10;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
	}

	.scroll-bottom:hover {
		opacity: 1;
		background: #772ce8;
	}
</style>
