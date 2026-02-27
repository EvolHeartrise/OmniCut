<script lang="ts">
	import { streams, syncOffsets, type ClipRegion } from '$lib/stores/streams.js';
	import { getMultiStreamChat } from '$lib/streams.remote';
	import { usernameColor, getClipLocalBounds } from '$lib/utils.js';
	import { parseEmotes, getThirdPartyEmotes, type ChatSegment, type EmoteMap } from '$lib/emoteParser.js';
	import { fetchTwitchBadges, resolveBadges, type BadgeInfo, type BadgeMap } from '$lib/badgeParser.js';

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
	let thirdPartyEmotes = $state<EmoteMap | undefined>(undefined);
	let badgeMap = $state<BadgeMap>(new Map());
	let listEl = $state<HTMLDivElement | null>(null);
	let userScrolled = $state(false);
	let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

	interface ChatEntry {
		id: number;
		username: string;
		text: string;
		localTime: number;
		userColor: string;
		segments: ChatSegment[];
		badges: BadgeInfo[];
	}

	// Fetch badges and third-party emotes for the clip's channel
	$effect(() => {
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream || stream.platform !== 'twitch') return;
		getThirdPartyEmotes(stream.channel).then((map) => {
			thirdPartyEmotes = map;
		});
		fetchTwitchBadges(stream.channel).then((map) => {
			badgeMap = map;
		});
	});

	// Derive clip-local bounds
	let clipBounds = $derived(
		getClipLocalBounds(clip, $streams.find((s) => s.id === clip.streamId), $syncOffsets[clip.streamId] || 0)
	);

	// Fetch all chat for the clip range
	const rawMessages = $derived(
		clipBounds
			? await getMultiStreamChat({
					ranges: [{ streamId: clip.streamId, from: clipBounds.localStart, to: clipBounds.localEnd }]
				})
			: []
	);

	let entries = $derived.by(() => {
		if (!rawMessages || rawMessages.length === 0) return [] as ChatEntry[];
		const _emotes = thirdPartyEmotes;
		const _badges = badgeMap;
		return rawMessages.map((m) => ({
			id: m.id,
			username: m.username,
			text: m.text,
			localTime: m.timestamp,
			userColor: m.color || usernameColor(m.username),
			segments: parseEmotes(m.text, m.emotes, _emotes),
			badges: resolveBadges(m.badges, _badges)
		}));
	});

	let filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return entries;
		const q = searchQuery.trim().toLowerCase();
		return entries.filter(
			(e) => e.text.toLowerCase().includes(q) || e.username.toLowerCase().includes(q)
		);
	});

	// Only show messages at or before the current playhead
	let displayEntries = $derived.by(() => {
		const now = currentLocalTime;
		let lo = 0,
			hi = filteredEntries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (filteredEntries[mid].localTime <= now) lo = mid + 1;
			else hi = mid;
		}
		const all = filteredEntries.slice(0, lo);
		return all.length > 200 ? all.slice(all.length - 200) : all;
	});

	// Auto-scroll to bottom
	$effect(() => {
		const _len = displayEntries.length;
		if (!listEl || userScrolled) return;
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
</script>

<div class="chat-panel">
	<div class="chat-header">
		<span class="header-title">Chat</span>
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
			<button class="chat-line" onclick={() => onseek(entry.localTime)}>
				{#each entry.badges as badge}<img class="badge" src={badge.imageUrl} alt={badge.title} title={badge.title} />{/each}<span class="user" style="color:{entry.userColor}">{entry.username}</span><span class="sep">:</span>
				<span class="msg">{#each entry.segments as seg}{#if seg.type === 'emote'}<img class="emote" src={seg.emoteUrl} alt={seg.text} title={seg.text} />{:else}{seg.text}{/if}{/each}</span>
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
