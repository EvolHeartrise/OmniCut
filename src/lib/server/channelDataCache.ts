/**
 * Shared cache for channel emotes and badges.
 * Reused across effect renderers within the same export to avoid
 * redundant Twitch API fetches.
 */

import { getThirdPartyEmotes, type EmoteMap } from '../emoteParser.js';
import { fetchTwitchBadges, type BadgeMap } from '../badgeParser.js';

export type ChannelData = { emotes: EmoteMap; badges: BadgeMap };

const cache = new Map<string, ChannelData>();

export async function getChannelData(channel: string): Promise<ChannelData> {
	let data = cache.get(channel);
	if (!data) {
		const [emotes, badges] = await Promise.all([
			getThirdPartyEmotes(channel),
			fetchTwitchBadges(channel)
		]);
		data = { emotes, badges };
		cache.set(channel, data);
	}
	return data;
}

export function clearChannelDataCache(): void {
	cache.clear();
}
