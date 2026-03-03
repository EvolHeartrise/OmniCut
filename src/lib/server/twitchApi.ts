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
// Channel fetching
// ---------------------------------------------------------------------------

/** Fetch Twitch channel info via GQL. */
export async function fetchTwitchChannel(login: string): Promise<ChannelInfo> {
	try {
		const data = await twitchGql<{ data?: { user?: Record<string, unknown> } }>(CHANNEL_LOOKUP_GQL, { login });
		const user = data?.data?.user;
		if (!user) {
			return {
				login,
				displayName: null,
				profileImageUrl: null,
				isLive: false,
				title: null,
				gameName: null,
				viewerCount: null,
				startedAt: null,
				hasVod: false,
				platform: 'twitch'
			};
		}
		const stream = user.stream as {
			viewersCount?: number;
			title?: string;
			game?: { name: string };
			createdAt?: string;
			archiveVideo?: { id: string };
		} | null;
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
		return {
			login,
			displayName: null,
			profileImageUrl: null,
			isLive: false,
			title: null,
			gameName: null,
			viewerCount: null,
			startedAt: null,
			hasVod: false,
			platform: 'twitch'
		};
	}
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
