/**
 * Resolve Twitch chat badges to image URLs.
 *
 * Fetches global badges from Twitch GQL and channel-specific badges
 * (custom subscriber tiers, etc.) on first use per channel (cached).
 *
 * Badge string format: "setID/version,setID/version,..." (e.g. "subscriber/12,vip/1")
 * Legacy format without versions is also supported: "subscriber,vip"
 */

const TWITCH_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';

export interface BadgeInfo {
	setID: string;
	title: string;
	imageUrl: string;
}

/** "setID/version" → BadgeInfo, with "setID" fallback entries for version-less lookups */
export type BadgeMap = Map<string, BadgeInfo>;

// ---------------------------------------------------------------------------
// Global badges
// ---------------------------------------------------------------------------

let globalBadgeCache: BadgeMap | null = null;
let globalBadgeFetchPromise: Promise<BadgeMap> | null = null;

/** Fetch global Twitch badges via GQL (cached). */
async function fetchGlobalBadges(): Promise<BadgeMap> {
	if (globalBadgeCache) return globalBadgeCache;
	if (globalBadgeFetchPromise) return globalBadgeFetchPromise;

	globalBadgeFetchPromise = (async () => {
		const map: BadgeMap = new Map();
		try {
			const res = await fetch('https://gql.twitch.tv/gql', {
				method: 'POST',
				headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: '{ badges { setID version title imageURL(size: NORMAL) } }'
				})
			});
			if (!res.ok) return map;
			const data = await res.json();
			const badges: Array<{ setID: string; version: string; title: string; imageURL: string }> =
				data?.data?.badges ?? [];
			for (const b of badges) {
				const key = `${b.setID}/${b.version}`;
				map.set(key, { setID: b.setID, title: b.title, imageUrl: b.imageURL });
				// Also store a setID-only fallback (first version wins) for legacy badge strings
				if (!map.has(b.setID)) {
					map.set(b.setID, { setID: b.setID, title: b.title, imageUrl: b.imageURL });
				}
			}
		} catch {
			// silently fail — badges are cosmetic
		}
		globalBadgeCache = map;
		globalBadgeFetchPromise = null;
		return map;
	})();

	return globalBadgeFetchPromise;
}

// ---------------------------------------------------------------------------
// Channel badges (custom subscriber tiers, etc.)
// ---------------------------------------------------------------------------

const channelBadgeCache = new Map<string, BadgeMap>();

/** Fetch channel-specific badges by login (cached). */
async function fetchChannelBadges(login: string): Promise<BadgeMap> {
	const key = login.toLowerCase();
	const cached = channelBadgeCache.get(key);
	if (cached) return cached;

	const map: BadgeMap = new Map();
	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				query: `query($login: String!) { user(login: $login) { broadcastBadges { setID version title imageURL(size: NORMAL) } } }`,
				variables: { login: key }
			})
		});
		if (!res.ok) {
			channelBadgeCache.set(key, map);
			return map;
		}
		const data = await res.json();
		const badges: Array<{ setID: string; version: string; title: string; imageURL: string }> =
			data?.data?.user?.broadcastBadges ?? [];
		for (const b of badges) {
			const compositeKey = `${b.setID}/${b.version}`;
			map.set(compositeKey, { setID: b.setID, title: b.title, imageUrl: b.imageURL });
		}
	} catch {
		// silently fail
	}
	channelBadgeCache.set(key, map);
	return map;
}

// ---------------------------------------------------------------------------
// Combined badge fetching
// ---------------------------------------------------------------------------

/**
 * Fetch combined global + channel badge map for a channel (cached).
 * Channel badges override globals on collision (e.g. custom subscriber icons).
 */
export async function fetchTwitchBadges(channelLogin?: string | null): Promise<BadgeMap> {
	const [globalMap, channelMap] = await Promise.all([
		fetchGlobalBadges(),
		channelLogin ? fetchChannelBadges(channelLogin) : Promise.resolve(new Map() as BadgeMap)
	]);

	if (channelMap.size === 0) return globalMap;

	// Merge: channel overrides global
	const merged: BadgeMap = new Map(globalMap);
	for (const [k, v] of channelMap) {
		merged.set(k, v);
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Badge resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a comma-separated badge string into BadgeInfo objects.
 *
 * Supports both versioned ("subscriber/12,vip/1") and legacy ("subscriber,vip") formats.
 * Lookup order: exact "setID/version" first, then "setID" fallback.
 */
export function resolveBadges(badges: string | null | undefined, badgeMap: BadgeMap | undefined): BadgeInfo[] {
	if (!badges || !badgeMap || badgeMap.size === 0) return [];
	const result: BadgeInfo[] = [];
	for (const entry of badges.split(',')) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		// Try exact match first (setID/version), then setID-only fallback
		const info = badgeMap.get(trimmed) ?? badgeMap.get(trimmed.split('/')[0]);
		if (info) result.push(info);
	}
	return result;
}
