<script lang="ts">
	import type { ChatSegment } from '$lib/emoteParser.js';
	import type { BadgeInfo } from '$lib/badgeParser.js';

	export interface ChatEntry {
		id: number;
		username: string;
		text: string;
		time: number;
		userColor: string;
		segments: ChatSegment[];
		badges: BadgeInfo[];
		twitchId?: string;
		[key: string]: unknown;
	}

	let {
		entries,
		currentTime,
		playing = false,
		maxVisible = 200,
		title = 'Chat',
		onseek,
		oncopyid
	}: {
		entries: ChatEntry[];
		currentTime: number;
		playing?: boolean;
		maxVisible?: number;
		title?: string;
		onseek?: (entry: ChatEntry) => void;
		oncopyid?: (twitchId: string) => void;
	} = $props();

	let searchQuery = $state('');
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
	let copiedId = $state<string | null>(null);

	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return entries;
		const q = searchQuery.trim().toLowerCase();
		return entries.filter(
			(e) => e.text.toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
		);
	});

	let displayEntries = $derived.by(() => {
		const now = currentTime;
		let lo = 0,
			hi = filteredEntries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (filteredEntries[mid].time <= now) lo = mid + 1;
			else hi = mid;
		}
		const all = filteredEntries.slice(0, lo);
		return all.length > maxVisible ? all.slice(all.length - maxVisible) : all;
	});

	$effect(() => {
		const _len = displayEntries.length;
		if (!listEl || userScrolled || (playing === false && _len > 0)) return;
		listEl.scrollTop = listEl.scrollHeight;
	});

	function handleListScroll() {
		if (!listEl) return;
		const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 50;
		if (atBottom) {
			userScrolled = false;
			if (scrollTimeout) {
				clearTimeout(scrollTimeout);
				scrollTimeout = null;
			}
			return;
		}
		userScrolled = true;
		if (scrollTimeout) clearTimeout(scrollTimeout);
		scrollTimeout = setTimeout(() => {
			userScrolled = false;
		}, 5000);
	}

	$effect(() => {
		return () => {
			if (scrollTimeout) clearTimeout(scrollTimeout);
		};
	});

	function scrollToBottom() {
		userScrolled = false;
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	}

	function clearSearch() {
		searchQuery = '';
	}

	function copyTwitchId(twitchId: string) {
		navigator.clipboard.writeText(twitchId).then(() => {
			copiedId = twitchId;
			setTimeout(() => { copiedId = null; }, 1500);
		});
		oncopyid?.(twitchId);
	}
</script>

<div class="chat-panel">
	<div class="chat-header">
		<span class="header-title">{title}</span>
		<span class="msg-count">{displayEntries.length}</span>
	</div>

	<div class="search-bar">
		<input type="text" class="search-input" placeholder="Filter..." bind:value={searchQuery} />
		{#if searchQuery}
			<button class="search-clear" onclick={clearSearch}>&times;</button>
		{/if}
	</div>

	<div class="chat-log" bind:this={listEl} onscroll={handleListScroll}>
		{#each displayEntries as entry (entry.id)}
			<div class="chat-line-wrap">
				<button class="chat-line" onclick={() => onseek?.(entry)}>
					{#each entry.badges as badge}<img class="badge" src={badge.imageUrl} alt={badge.title} title={badge.title} />{/each}<span class="user" style="color:{entry.userColor}">{entry.username}</span><span class="sep">:</span>
					<span class="msg">{#each entry.segments as seg}{#if seg.type === 'emote'}<img class="emote" src={seg.emoteUrl} alt={seg.text} title={seg.text} />{:else}{seg.text}{/if}{/each}</span>
				</button>
				{#if oncopyid && entry.twitchId}
					<button
						class="copy-id-btn"
						title="Copy Twitch message ID"
						onclick={(e) => { e.stopPropagation(); copyTwitchId(entry.twitchId!); }}
					>
						{copiedId === entry.twitchId ? 'Copied' : 'ID'}
					</button>
				{/if}
			</div>
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
		<button class="scroll-bottom" onclick={scrollToBottom}>More messages below</button>
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
		font-family: 'Inter', sans-serif;
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
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
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

	.chat-line-wrap {
		display: flex;
		align-items: flex-start;
		position: relative;
	}

	.chat-line-wrap:hover {
		background: #26262c;
	}

	.chat-line-wrap:hover .copy-id-btn {
		opacity: 1;
	}

	.chat-line {
		display: block;
		flex: 1;
		min-width: 0;
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

	.copy-id-btn {
		flex-shrink: 0;
		opacity: 0;
		background: #3a3a3e;
		border: none;
		color: #adadb8;
		font-size: 0.55rem;
		font-weight: 600;
		padding: 2px 5px;
		border-radius: 3px;
		cursor: pointer;
		margin: 3px 6px 0 0;
		white-space: nowrap;
		transition: opacity 0.1s;
		font-family: monospace;
	}

	.copy-id-btn:hover {
		background: #53535f;
		color: #efeff1;
	}

	.badge {
		display: inline-block;
		width: 18px;
		height: 18px;
		vertical-align: middle;
		margin-right: 3px;
		border-radius: 2px;
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

	.emote {
		display: inline-block;
		height: 1.75em;
		vertical-align: middle;
		margin: -2px 2px;
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
