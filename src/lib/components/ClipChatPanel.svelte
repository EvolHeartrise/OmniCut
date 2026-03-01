<script lang="ts">
	import { streams, syncOffsets, type ClipRegion } from '$lib/stores/streams.js';
	import { getMultiStreamChat } from '$lib/streams.remote';
	import { usernameColor, getClipLocalBounds } from '$lib/utils.js';
	import { parseEmotes, getThirdPartyEmotes, type EmoteMap } from '$lib/emoteParser.js';
	import { fetchTwitchBadges, resolveBadges, type BadgeMap } from '$lib/badgeParser.js';
	import ChatList, { type ChatEntry } from './ChatList.svelte';

	let {
		clip,
		currentLocalTime,
		onseek,
		oncopyid
	}: {
		clip: ClipRegion | null;
		currentLocalTime: number;
		onseek: (localTime: number) => void;
		oncopyid?: (twitchId: string) => void;
	} = $props();

	let thirdPartyEmotes = $state<EmoteMap | undefined>(undefined);
	let badgeMap = $state<BadgeMap>(new Map());

	// Track which clip we've fetched emotes/badges for
	let lastEmoteChannel = '';

	// Fetch badges and third-party emotes for the clip's channel
	$effect(() => {
		if (!clip) return;
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream || stream.platform !== 'twitch') return;
		if (lastEmoteChannel === stream.channel) return;
		lastEmoteChannel = stream.channel;
		getThirdPartyEmotes(stream.channel).then((map) => {
			thirdPartyEmotes = map;
		});
		fetchTwitchBadges(stream.channel).then((map) => {
			badgeMap = map;
		});
	});

	// Derive clip-local bounds
	let clipBounds = $derived(
		clip
			? getClipLocalBounds(clip, $streams.find((s) => s.id === clip.streamId), $syncOffsets[clip.streamId] || 0)
			: null
	);

	// Fetch all chat for the clip range
	const rawMessages = $derived(
		clip && clipBounds
			? await getMultiStreamChat({
					ranges: [{ streamId: clip.streamId, from: clipBounds.localStart, to: clipBounds.localEnd }]
				})
			: []
	);

	let entries = $derived.by((): ChatEntry[] => {
		if (!rawMessages || rawMessages.length === 0) return [];
		const _emotes = thirdPartyEmotes;
		const _badges = badgeMap;
		return rawMessages.map((m) => ({
			id: m.id,
			username: m.username,
			text: m.text,
			time: m.timestamp,
			userColor: m.color || usernameColor(m.username),
			segments: parseEmotes(m.text, m.emotes, _emotes),
			badges: resolveBadges(m.badges, _badges),
			twitchId: m.twitchId
		}));
	});

	function handleSeek(entry: ChatEntry) {
		onseek(entry.time);
	}
</script>

{#if !clip}
	<div class="no-clip">
		<p>No clip selected</p>
	</div>
{:else}
	<ChatList
		{entries}
		currentTime={currentLocalTime}
		title="Chat"
		onseek={handleSeek}
		{oncopyid}
	/>
{/if}

<style>
	.no-clip {
		width: 340px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: #18181b;
		border-left: 1px solid #2a2a2e;
		height: 100%;
		color: #53535f;
		font-size: 0.8rem;
		font-family: 'Inter', sans-serif;
	}

	.no-clip p {
		margin: 0;
	}
</style>
