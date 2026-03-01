<script lang="ts">
	/**
	 * Compact chat preview overlay for the video editor.
	 * Shows scrolling chat messages filtered up to the current playback time.
	 */
	import { streams } from '$lib/stores/streams.js';
	import { getMultiStreamChat } from '$lib/streams.remote';
	import { usernameColor } from '$lib/utils.js';
	import { parseEmotes, getThirdPartyEmotes, type EmoteMap } from '$lib/emoteParser.js';
	import { fetchTwitchBadges, resolveBadges, type BadgeMap } from '$lib/badgeParser.js';

	interface RawMsg {
		id: number;
		username: string;
		text: string;
		timestamp: number;
		color: string | null;
		badges: string | null;
		emotes: string | null;
	}

	interface ChatEntry {
		id: number;
		username: string;
		userColor: string;
		time: number;
		segments: Array<{ type: string; text: string; emoteUrl?: string }>;
		badges: Array<{ imageUrl: string; title: string }>;
	}

	let {
		streamId,
		localStart,
		localEnd,
		currentTime,
		chatOffset = 0,
		fontWeight = 400,
		censorTerms = []
	}: {
		streamId: string;
		localStart: number;
		localEnd: number;
		currentTime: number;
		chatOffset?: number;
		fontWeight?: number;
		censorTerms?: string[];
	} = $props();

	let thirdPartyEmotes = $state<EmoteMap>(new Map());
	let badgeMap = $state<BadgeMap>(new Map());
	let emotesLoaded = $state(false);
	let lastEmoteChannel = '';
	let lastFetchKey = '';
	let rawMessages = $state<RawMsg[]>([]);
	let listEl = $state<HTMLDivElement | null>(null);

	// Fetch emotes/badges when stream changes
	$effect(() => {
		const stream = $streams.find((s) => s.id === streamId);
		if (!stream || stream.platform !== 'twitch') return;
		if (lastEmoteChannel === stream.channel) return;
		lastEmoteChannel = stream.channel;
		emotesLoaded = false;
		Promise.all([
			getThirdPartyEmotes(stream.channel),
			fetchTwitchBadges(stream.channel)
		]).then(([emotes, badges]) => {
			thirdPartyEmotes = emotes;
			badgeMap = badges;
			emotesLoaded = true;
		});
	});

	// Fetch chat messages when clip range or offset changes (backfill 60s so panel isn't empty at start)
	const BACKFILL_SECONDS = 60;
	$effect(() => {
		const key = `${streamId}:${localStart.toFixed(1)}:${localEnd.toFixed(1)}:${chatOffset.toFixed(1)}`;
		if (key === lastFetchKey) return;
		lastFetchKey = key;

		// chatOffset shifts which chat messages are shown: positive = pull from later in the stream
		const chatStart = localStart + chatOffset;
		const chatEnd = localEnd + chatOffset;
		const fetchStart = Math.max(0, chatStart - BACKFILL_SECONDS);
		getMultiStreamChat({ ranges: [{ streamId, from: fetchStart, to: chatEnd }] })
			.then((raw) => {
				rawMessages = raw.map((m) => ({
					id: m.id,
					username: m.username,
					text: m.text,
					// Shift timestamps back by offset to align with video time.
					// Don't clamp — backfilled messages keep their original timestamps
					// so they're already visible at currentTime=localStart (since timestamp < localStart).
					timestamp: m.timestamp - chatOffset,
					color: m.color ?? null,
					badges: m.badges ?? null,
					emotes: m.emotes ?? null
				}));
			})
			.catch(() => { rawMessages = []; });
	});

	// Derive parsed entries from raw + emote state
	let entries = $derived.by((): ChatEntry[] => {
		const _emotes = thirdPartyEmotes;
		const _badges = badgeMap;
		return rawMessages.map((m) => ({
			id: m.id,
			username: m.username,
			userColor: m.color || usernameColor(m.username),
			time: m.timestamp,
			segments: parseEmotes(m.text, m.emotes, _emotes),
			badges: resolveBadges(m.badges, _badges)
		}));
	});

	// Filter entries to those up to currentTime (MAX_VISIBLE matches chatEffectRenderer.ts)
	const MAX_VISIBLE = 200;
	let displayEntries = $derived.by(() => {
		let lo = 0, hi = entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (entries[mid].time <= currentTime) lo = mid + 1;
			else hi = mid;
		}
		const all = entries.slice(0, lo);
		return all.length > MAX_VISIBLE ? all.slice(all.length - MAX_VISIBLE) : all;
	});

	// Auto-scroll to bottom when new messages appear
	$effect(() => {
		const _len = displayEntries.length;
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	});

	// Censor term splitting for text segments
	function escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	function censorSplit(text: string, terms: string[]): Array<{ text: string; censored: boolean }> {
		if (!terms.length) return [{ text, censored: false }];
		const escaped = terms.map(escapeRegex).sort((a, b) => b.length - a.length);
		const re = new RegExp(`(${escaped.join('|')})`, 'gi');
		const parts: Array<{ text: string; censored: boolean }> = [];
		let lastIndex = 0;
		for (const match of text.matchAll(re)) {
			const idx = match.index!;
			if (idx > lastIndex) parts.push({ text: text.slice(lastIndex, idx), censored: false });
			parts.push({ text: match[0], censored: true });
			lastIndex = idx + match[0].length;
		}
		if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), censored: false });
		return parts.length ? parts : [{ text, censored: false }];
	}
</script>

<div class="preview-chat-log" bind:this={listEl} style="font-weight:{fontWeight}">
	{#each displayEntries as entry (entry.id)}
		<div class="pc-line">
			{#each entry.badges as badge}<img class="pc-badge" src={badge.imageUrl} alt={badge.title} />{/each}<span class="pc-user" style="color:{entry.userColor};font-weight:{Math.min(900, fontWeight + 300)}">{entry.username}</span><span class="pc-sep">: </span><span class="pc-msg">{#each entry.segments as seg}{#if seg.type === 'emote' && seg.emoteUrl}<img class="pc-emote" src={seg.emoteUrl} alt={seg.text} />{:else}{#each censorSplit(seg.text, censorTerms) as part}{#if part.censored}<span class="pc-censored">{part.text}</span>{:else}{part.text}{/if}{/each}{/if}{/each}</span>
		</div>
	{/each}
</div>

<style>
	/* Matches chatRenderer.ts / chatEffectRenderer.ts export constants:
	   CHAT_FONT = 13px, CHAT_LINE_HEIGHT = 1.4, CHAT_BADGE_SIZE = 18,
	   CHAT_BADGE_MARGIN = 3, CHAT_EMOTE_HEIGHT = 23, CHAT_PAD_X = 12, CHAT_PAD_Y = 2 */
	.preview-chat-log {
		width: 100%;
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		scrollbar-width: none;
		background: transparent;
		border-radius: inherit;
	}

	.preview-chat-log::-webkit-scrollbar {
		display: none;
	}

	.pc-line {
		padding: 2px 12px;
		font-size: 13px;
		line-height: 1.4;
		color: #efeff1;
		word-break: break-word;
		font-family: 'Inter', Arial, sans-serif;
	}

	.pc-badge {
		display: inline-block;
		width: 18px;
		height: 18px;
		vertical-align: middle;
		margin-right: 3px;
		border-radius: 2px;
	}

	.pc-user {
		font-size: 13px;
	}

	.pc-sep {
		color: #efeff1;
		margin-right: 2px;
	}

	.pc-msg {
		color: #efeff1;
		font-size: 13px;
	}

	.pc-emote {
		display: inline-block;
		height: 23px;
		vertical-align: middle;
		margin: -1px 2px;
	}

	.pc-censored {
		filter: blur(2.5px);
		display: inline;
		user-select: none;
	}
</style>
