import type { ChannelInfo, VodInfo } from '../types.js';

// Public Android TV client ID — no secret, used for unauthenticated GQL queries
export const TWITCH_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';

// ---------------------------------------------------------------------------
// Shared GQL helper
// ---------------------------------------------------------------------------

/** Execute a Twitch GQL query with the shared client ID. */
export async function twitchGql<T = unknown>(gqlQuery: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch('https://gql.twitch.tv/gql', {
		method: 'POST',
		headers: {
			'Client-ID': TWITCH_CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query: gqlQuery, variables })
	});
	return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GQL Query Strings (centralized — used by captureProcess, streams.remote, etc.)
// ---------------------------------------------------------------------------

export const STREAM_META_GQL = `query($login: String!) {
	user(login: $login) {
		stream {
			viewersCount
			title
			game { name }
			createdAt
			archiveVideo { id }
		}
	}
}`;

export const VOD_META_GQL = `query($id: ID!) {
	video(id: $id) {
		owner { login }
		title
		createdAt
		lengthSeconds
	}
}`;

export const CHANNEL_LOOKUP_GQL = `query($login: String!) {
	user(login: $login) {
		displayName
		profileImageURL(width: 70)
		stream {
			viewersCount
			title
			game { name }
			createdAt
			archiveVideo { id }
		}
	}
}`;

export const BROWSE_STREAMS_GQL = `query($first: Int!, $after: Cursor, $opts: StreamOptions) {
	streams(first: $first, after: $after, options: $opts) {
		edges {
			cursor
			node {
				broadcaster {
					login
					displayName
					profileImageURL(width: 70)
				}
				viewersCount
				title
				game { name }
				createdAt
			}
		}
		pageInfo { hasNextPage }
	}
}`;

export const BROWSE_GAME_STREAMS_GQL = `query($id: ID!, $first: Int!, $after: Cursor, $opts: GameStreamOptions) {
	game(id: $id) {
		streams(first: $first, after: $after, options: $opts) {
			edges {
				cursor
				node {
					broadcaster {
						login
						displayName
						profileImageURL(width: 70)
					}
					viewersCount
					title
					game { name }
					createdAt
				}
			}
			pageInfo { hasNextPage }
		}
	}
}`;

export const SEARCH_CATEGORIES_GQL = `query($query: String!) {
	searchCategories(query: $query, first: 10) {
		edges {
			node {
				id
				name
			}
		}
	}
}`;

export const CHANNEL_VODS_GQL = `query($login: String!, $first: Int, $after: Cursor, $type: BroadcastType) {
	user(login: $login) {
		videos(first: $first, after: $after, type: $type, sort: TIME) {
			edges {
				cursor
				node {
					id
					title
					createdAt
					lengthSeconds
					previewThumbnailURL(width: 320, height: 180)
					viewCount
				}
			}
			pageInfo { hasNextPage }
		}
	}
}`;

// ---------------------------------------------------------------------------
// Shared types for GQL responses
// ---------------------------------------------------------------------------

export interface BrowseStreamEdge {
	cursor: string;
	node: {
		broadcaster: { login: string; displayName: string; profileImageURL: string };
		viewersCount: number;
		title: string;
		game: { name: string } | null;
		createdAt: string;
	};
}

export interface VideoEdge {
	cursor: string;
	node: {
		id: string;
		title: string | null;
		createdAt: string | null;
		lengthSeconds: number | null;
		previewThumbnailURL: string | null;
		viewCount: number | null;
	};
}

// ---------------------------------------------------------------------------
// Shared channel fetching (Twitch + Douyu) — single source of truth
// ---------------------------------------------------------------------------

/** Fetch Twitch channel info via GQL. */
export async function fetchTwitchChannel(login: string): Promise<ChannelInfo> {
	try {
		const data = await twitchGql<{ data?: { user?: Record<string, unknown> } }>(CHANNEL_LOOKUP_GQL, { login });
		const user = data?.data?.user;
		if (!user) {
			return { login, displayName: null, profileImageUrl: null, isLive: false, title: null, gameName: null, viewerCount: null, startedAt: null, hasVod: false, platform: 'twitch' };
		}
		const stream = user.stream as { viewersCount?: number; title?: string; game?: { name: string }; createdAt?: string; archiveVideo?: { id: string } } | null;
		return {
			login,
			displayName: (user.displayName as string) ?? null,
			profileImageUrl: (user.profileImageURL as string) ?? null,
			isLive: !!stream,
			title: stream?.title ?? null,
			gameName: stream?.game?.name ?? null,
			viewerCount: stream?.viewersCount ?? null,
			startedAt: stream?.createdAt ?? null,
			hasVod: !!stream?.archiveVideo?.id,
			platform: 'twitch'
		};
	} catch {
		return { login, displayName: null, profileImageUrl: null, isLive: false, title: null, gameName: null, viewerCount: null, startedAt: null, hasVod: false, platform: 'twitch' };
	}
}

/** Fetch Douyu channel info via their public API. */
export async function fetchDouyuChannel(roomId: string): Promise<ChannelInfo> {
	try {
		const res = await fetch(`https://open.douyucdn.cn/api/RoomApi/room/${roomId}`);
		const data = await res.json();
		const room = data?.data;
		if (!room) {
			return { login: roomId, displayName: null, profileImageUrl: null, isLive: false, title: null, gameName: null, viewerCount: null, startedAt: null, hasVod: false, platform: 'douyu' };
		}
		const isLive = String(room.room_status) === '1';
		return {
			login: roomId,
			displayName: room.owner_name ?? null,
			profileImageUrl: room.avatar ?? null,
			isLive,
			title: room.room_name ?? null,
			gameName: room.cate_name ?? null,
			viewerCount: room.online ?? null,
			startedAt: isLive && room.start_time ? new Date(room.start_time + '+08:00').toISOString() : null,
			hasVod: false,
			platform: 'douyu'
		};
	} catch {
		return { login: roomId, displayName: null, profileImageUrl: null, isLive: false, title: null, gameName: null, viewerCount: null, startedAt: null, hasVod: false, platform: 'douyu' };
	}
}

/** Map browse stream edges into ChannelInfo array with cursor. */
export function mapBrowseEdges(edges: BrowseStreamEdge[]): { streams: ChannelInfo[]; cursor: string | null } {
	const cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
	const streams: ChannelInfo[] = edges.map((edge) => ({
		login: edge.node.broadcaster.login,
		displayName: edge.node.broadcaster.displayName ?? null,
		profileImageUrl: edge.node.broadcaster.profileImageURL ?? null,
		isLive: true,
		title: edge.node.title ?? null,
		gameName: edge.node.game?.name ?? null,
		viewerCount: edge.node.viewersCount ?? null,
		startedAt: edge.node.createdAt ?? null,
		hasVod: false,
		platform: 'twitch' as const
	}));
	return { streams, cursor };
}

/** Map video edges into VodInfo array. */
export function mapVideoEdges(edges: VideoEdge[]): VodInfo[] {
	return edges.map((edge) => ({
		id: edge.node.id,
		title: edge.node.title ?? null,
		createdAt: edge.node.createdAt ?? null,
		durationSeconds: edge.node.lengthSeconds ?? null,
		thumbnailUrl: edge.node.previewThumbnailURL ?? null,
		viewCount: edge.node.viewCount ?? null
	}));
}
