<script lang="ts">
	import { masterTime, masterPlaying, seekRequest } from '$lib/stores/streams.js';
	import { createPanelQueryState } from '$lib/panelQueryRanges.svelte.js';
	import { usernameColor } from '$lib/utils.js';
	import { getMultiStreamChat } from '$lib/streams.remote';
	import { parseEmotes, getThirdPartyEmotes, type EmoteMap } from '$lib/emoteParser.js';
	import { fetchTwitchBadges, resolveBadges, type BadgeMap } from '$lib/badgeParser.js';
	import ChatList, { type ChatEntry } from './ChatList.svelte';

	let emoteMapByChannel = $state(new Map<string, EmoteMap>());
	let badgeMapByChannel = $state(new Map<string, BadgeMap>());

	// Shared debounced query state (visible streams + windowed ranges)
	const queryState = createPanelQueryState();

	// Fetch third-party emotes and badges for each visible channel
	$effect(() => {
		const channels = queryState.visibleStreams.map((s) => s.channel);
		for (const ch of channels) {
			if (!emoteMapByChannel.has(ch)) {
				getThirdPartyEmotes(ch).then((map) => {
					emoteMapByChannel.set(ch, map);
					emoteMapByChannel = new Map(emoteMapByChannel);
				});
			}
			if (!badgeMapByChannel.has(ch)) {
				fetchTwitchBadges(ch).then((map) => {
					badgeMapByChannel.set(ch, map);
					badgeMapByChannel = new Map(badgeMapByChannel);
				});
			}
		}
	});

	// Fetch chat messages via remote query
	const rawMessages = $derived(await getMultiStreamChat({ ranges: queryState.ranges, limit: 500 }));

	// Transform server data to ChatEntry format with master-time positioning
	let entries = $derived.by((): ChatEntry[] => {
		if (!rawMessages || rawMessages.length === 0) return [];
		const streamLookup = new Map(queryState.visibleStreams.map((s) => [s.id, s]));
		const _emotes = emoteMapByChannel;
		const _badges = badgeMapByChannel;
		return rawMessages.map((m) => {
			const s = streamLookup.get(m.streamId);
			const channel = s?.channel || '';
			return {
				id: m.id,
				username: m.username,
				text: m.text,
				time: m.timestamp + (s ? s.anchor - s.offset : 0),
				userColor: m.color || usernameColor(m.username),
				segments: parseEmotes(m.text, m.emotes, _emotes.get(channel)),
				badges: resolveBadges(m.badges, _badges.get(channel))
			};
		});
	});

	function handleSeek(entry: ChatEntry) {
		seekRequest.update((r) => ({ time: entry.time, seq: r.seq + 1 }));
	}
</script>

<ChatList
	{entries}
	currentTime={$masterTime}
	playing={$masterPlaying}
	maxVisible={100}
	title="Stream Chat"
	onseek={handleSeek}
/>
