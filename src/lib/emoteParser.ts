/**
 * Parse Twitch emote position strings and produce renderable segments,
 * then apply third-party emote replacements (7TV, BTTV) on remaining text.
 *
 * Twitch emote format: "emoteId:start-end,start-end/emoteId:start-end"
 * Twitch CDN: https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0
 * 7TV CDN:    https://cdn.7tv.app/emote/{id}/1x.webp
 * BTTV CDN:   https://cdn.betterttv.net/emote/{id}/1x
 * FFZ CDN:    https://cdn.frankerfacez.com/emote/{id}/1
 */

export interface ChatSegment {
	type: 'text' | 'emote';
	text: string;
	emoteUrl?: string;
}

/** A map of emote name → image URL, used for text-based emote lookups (7TV, BTTV). */
export type EmoteMap = Map<string, string>;

/**
 * Parse a message into renderable segments:
 * 1. First apply Twitch native emotes (position-based from IRC tags)
 * 2. Then scan remaining text segments for 7TV emotes (name-based lookup)
 */
export function parseEmotes(
	text: string,
	emotes: string | null | undefined,
	thirdPartyEmotes?: EmoteMap
): ChatSegment[] {
	let segments = parseTwitchEmotes(text, emotes);

	if (thirdPartyEmotes && thirdPartyEmotes.size > 0) {
		segments = applyTextEmotes(segments, thirdPartyEmotes);
	}

	return segments;
}

/** Parse Twitch native emote positions into segments. */
function parseTwitchEmotes(text: string, emotes: string | null | undefined): ChatSegment[] {
	if (!emotes) return [{ type: 'text', text }];

	const positions: Array<{ start: number; end: number; emoteId: string }> = [];

	for (const group of emotes.split('/')) {
		const colonIdx = group.indexOf(':');
		if (colonIdx === -1) continue;
		const emoteId = group.slice(0, colonIdx);
		const ranges = group.slice(colonIdx + 1);
		for (const range of ranges.split(',')) {
			const dashIdx = range.indexOf('-');
			if (dashIdx === -1) continue;
			const start = parseInt(range.slice(0, dashIdx), 10);
			const end = parseInt(range.slice(dashIdx + 1), 10);
			if (!isNaN(start) && !isNaN(end)) {
				positions.push({ start, end, emoteId });
			}
		}
	}

	if (positions.length === 0) return [{ type: 'text', text }];

	positions.sort((a, b) => a.start - b.start);

	const segments: ChatSegment[] = [];
	let cursor = 0;

	for (const pos of positions) {
		if (pos.start > cursor) {
			segments.push({ type: 'text', text: text.slice(cursor, pos.start) });
		}
		const emoteText = text.slice(pos.start, pos.end + 1);
		segments.push({
			type: 'emote',
			text: emoteText,
			emoteUrl: `https://static-cdn.jtvnw.net/emoticons/v2/${pos.emoteId}/default/dark/1.0`
		});
		cursor = pos.end + 1;
	}

	if (cursor < text.length) {
		segments.push({ type: 'text', text: text.slice(cursor) });
	}

	return segments;
}

/**
 * Scan text segments for third-party emote names (word-boundary matching)
 * and split them into text + emote segments.
 */
function applyTextEmotes(segments: ChatSegment[], emoteMap: EmoteMap): ChatSegment[] {
	const result: ChatSegment[] = [];

	for (const seg of segments) {
		if (seg.type !== 'text') {
			result.push(seg);
			continue;
		}

		// Split text by whitespace, check each word against emote map
		const parts = seg.text.split(/(\s+)/);
		let accum = '';

		for (const part of parts) {
			const url = emoteMap.get(part);
			if (url) {
				// Flush accumulated text
				if (accum) {
					result.push({ type: 'text', text: accum });
					accum = '';
				}
				result.push({ type: 'emote', text: part, emoteUrl: url });
			} else {
				accum += part;
			}
		}

		if (accum) {
			result.push({ type: 'text', text: accum });
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Generic emote provider with fetch-and-cache pattern
// ---------------------------------------------------------------------------

interface EmoteProvider {
	fetchGlobal(): Promise<EmoteMap>;
	fetchChannel(key: string): Promise<EmoteMap>;
}

function createCachedProvider(opts: {
	fetchGlobal: () => Promise<EmoteMap>;
	fetchChannel: (key: string) => Promise<EmoteMap>;
}): EmoteProvider {
	let globalCache: EmoteMap | null = null;
	let globalPromise: Promise<EmoteMap> | null = null;
	const channelCache = new Map<string, EmoteMap>();

	return {
		async fetchGlobal() {
			if (globalCache) return globalCache;
			if (globalPromise) return globalPromise;
			globalPromise = opts.fetchGlobal().then((map) => {
				globalCache = map;
				globalPromise = null;
				return map;
			});
			return globalPromise;
		},
		async fetchChannel(key: string) {
			const cached = channelCache.get(key);
			if (cached) return cached;
			const map = await opts.fetchChannel(key);
			channelCache.set(key, map);
			return map;
		}
	};
}

// ---------------------------------------------------------------------------
// 7TV
// ---------------------------------------------------------------------------

interface SevenTVEmote {
	id: string;
	name: string;
	data?: {
		host?: {
			url?: string;
			files?: Array<{ name: string; format: string }>;
		};
	};
}

function buildSevenTVUrl(emote: SevenTVEmote): string | null {
	const host = emote.data?.host;
	if (!host?.url) return null;
	const file = host.files?.find((f) => f.name === '1x.webp') ?? host.files?.[0];
	if (!file) return null;
	return `https:${host.url}/${file.name}`;
}

const sevenTV = createCachedProvider({
	async fetchGlobal() {
		const map: EmoteMap = new Map();
		try {
			const res = await fetch('https://7tv.io/v3/emote-sets/global');
			if (!res.ok) return map;
			const data = await res.json();
			for (const emote of (data?.emotes ?? []) as SevenTVEmote[]) {
				const url = buildSevenTVUrl(emote);
				if (url) map.set(emote.name, url);
			}
		} catch { /* optional */ }
		return map;
	},
	async fetchChannel(twitchUserId: string) {
		const map: EmoteMap = new Map();
		try {
			const res = await fetch(`https://7tv.io/v3/users/twitch/${twitchUserId}`);
			if (!res.ok) return map;
			const data = await res.json();
			for (const emote of (data?.emote_set?.emotes ?? []) as SevenTVEmote[]) {
				const url = buildSevenTVUrl(emote);
				if (url) map.set(emote.name, url);
			}
		} catch { /* optional */ }
		return map;
	}
});

// ---------------------------------------------------------------------------
// BTTV
// ---------------------------------------------------------------------------

interface BTTVEmote {
	id: string;
	code: string;
}

const bttv = createCachedProvider({
	async fetchGlobal() {
		const map: EmoteMap = new Map();
		try {
			const res = await fetch('https://api.betterttv.net/3/cached/emotes/global');
			if (!res.ok) return map;
			for (const e of (await res.json()) as BTTVEmote[]) {
				map.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`);
			}
		} catch { /* optional */ }
		return map;
	},
	async fetchChannel(twitchUserId: string) {
		const map: EmoteMap = new Map();
		try {
			const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`);
			if (!res.ok) return map;
			const data = await res.json();
			for (const e of [...(data?.channelEmotes ?? []), ...(data?.sharedEmotes ?? [])] as BTTVEmote[]) {
				map.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`);
			}
		} catch { /* optional */ }
		return map;
	}
});

// ---------------------------------------------------------------------------
// FFZ
// ---------------------------------------------------------------------------

interface FFZEmoticon {
	id: number;
	name: string;
	urls: Record<string, string>;
}

function ffzEmoteUrl(emote: FFZEmoticon): string {
	return emote.urls['1'] ?? Object.values(emote.urls)[0] ?? '';
}

function parseFfzSets(data: { sets?: Record<string, { emoticons?: FFZEmoticon[] }> }): EmoteMap {
	const map: EmoteMap = new Map();
	for (const set of Object.values(data?.sets ?? {})) {
		for (const emote of set.emoticons ?? []) {
			const url = ffzEmoteUrl(emote);
			if (url) map.set(emote.name, url);
		}
	}
	return map;
}

const ffz = createCachedProvider({
	async fetchGlobal() {
		try {
			const res = await fetch('https://api.frankerfacez.com/v1/set/global');
			if (!res.ok) return new Map();
			return parseFfzSets(await res.json());
		} catch { return new Map(); }
	},
	async fetchChannel(login: string) {
		try {
			const res = await fetch(`https://api.frankerfacez.com/v1/room/${login.toLowerCase()}`);
			if (!res.ok) return new Map();
			return parseFfzSets(await res.json());
		} catch { return new Map(); }
	}
});

// ---------------------------------------------------------------------------
// Twitch login → numeric user ID resolution (client-side, cached)
// Uses the same public GQL client ID as the rest of the app.
// ---------------------------------------------------------------------------

import { TWITCH_CLIENT_ID } from './constants.js';

const userIdCache = new Map<string, string | null>();

async function resolveTwitchUserId(login: string): Promise<string | null> {
	const key = login.toLowerCase();
	if (userIdCache.has(key)) return userIdCache.get(key)!;

	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				query: `query($login: String!) { user(login: $login) { id } }`,
				variables: { login: key }
			})
		});
		if (!res.ok) {
			userIdCache.set(key, null);
			return null;
		}
		const data = await res.json();
		const id: string | null = data?.data?.user?.id ?? null;
		userIdCache.set(key, id);
		return id;
	} catch {
		userIdCache.set(key, null);
		return null;
	}
}

/**
 * Build a combined emote map for a channel (7TV + BTTV + FFZ, global + channel-specific).
 * Channel emotes override globals if names collide.
 * Accepts a Twitch channel login name (resolved to numeric ID internally).
 */
export async function getThirdPartyEmotes(channelLogin: string | null): Promise<EmoteMap> {
	const twitchUserId = channelLogin ? await resolveTwitchUserId(channelLogin) : null;
	const empty = Promise.resolve(new Map() as EmoteMap);

	const [sevenTVGlobal, sevenTVChannel, bttvGlobal, bttvChannel, ffzGlobal, ffzChannel] = await Promise.all([
		sevenTV.fetchGlobal(),
		twitchUserId ? sevenTV.fetchChannel(twitchUserId) : empty,
		bttv.fetchGlobal(),
		twitchUserId ? bttv.fetchChannel(twitchUserId) : empty,
		ffz.fetchGlobal(),
		channelLogin ? ffz.fetchChannel(channelLogin) : empty
	]);

	// Merge order: globals first, then channel-specific (channel overrides global).
	// FFZ → BTTV → 7TV so 7TV wins on name collisions (7TV is most commonly used).
	const merged: EmoteMap = new Map();
	for (const map of [ffzGlobal, bttvGlobal, sevenTVGlobal, ffzChannel, bttvChannel, sevenTVChannel]) {
		for (const [name, url] of map) {
			merged.set(name, url);
		}
	}
	return merged;
}
