import { query, command } from '$app/server';
import { normalizeChannel } from '$lib/utils.js';
import {
	listStreams,
	getAllClipRegions,
	addStream as smAddStream,
	addVodStream,
	addVodByUrl,
	stopStream as smStopStream,
	removeStream as smRemoveStream,
	retranscribeStream as smRetranscribe,
	resumeVodStream as smResumeVod,
	refetchVodChat as smRefetchVodChat,
	updateStreamOffset,
	addClipRegion,
	removeClipRegion,
	getChatHeatmap as smGetChatHeatmap,
	getChatMessagesInRange as smGetChatMessagesInRange,
	getTranscriptionsInRange as smGetTranscriptionsInRange,
	exportVideo
} from '$lib/server/streamManager.js';
import {
	addIgnoredChannel,
	removeIgnoredChannel,
	loadIgnoredChannels,
	loadAllChannelSettings,
	saveChannelSettings,
	loadWatchlist as dbLoadWatchlist,
	addToWatchlist as dbAddToWatchlist,
	removeFromWatchlist as dbRemoveFromWatchlist
} from '$lib/server/persistence.js';
import { TWITCH_CLIENT_ID } from '$lib/server/twitchApi.js';
import type { ChatMessage } from '$lib/server/types.js';
import type { ChannelInfo, VodInfo } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List all streams with clip regions (transcriptions fetched on demand via windowed query). */
export const getStreams = query(async () => {
	const streams = listStreams();
	const clipRegions = getAllClipRegions();
	return { streams, clipRegions };
});

/** Pre-bucketed chat heatmap for a single stream. */
export const getChatHeatmap = query('unchecked', async (args: { streamId: string; bucket?: number }) => {
	return smGetChatHeatmap(args.streamId, args.bucket ?? 5);
});

/** Chat messages in a time range for multiple streams (merged & sorted). */
export const getMultiStreamChat = query(
	'unchecked',
	async (args: { ranges: Array<{ streamId: string; from: number; to: number }> }) => {
		const results: Array<ChatMessage & { streamId: string }> = [];
		for (const range of args.ranges) {
			const messages = smGetChatMessagesInRange(range.streamId, range.from, range.to);
			for (const m of messages) {
				results.push({ ...m, streamId: range.streamId });
			}
		}
		results.sort((a, b) => a.timestamp - b.timestamp);
		return results;
	}
);

/** Transcriptions in a time range for multiple streams (merged & sorted). */
export const getMultiStreamTranscriptions = query(
	'unchecked',
	async (args: { ranges: Array<{ streamId: string; from: number; to: number }> }) => {
		const results: Array<{ streamId: string; text: string; startTime: number; endTime: number }> = [];
		for (const range of args.ranges) {
			const entries = smGetTranscriptionsInRange(range.streamId, range.from, range.to);
			for (const e of entries) {
				results.push({ streamId: range.streamId, ...e });
			}
		}
		results.sort((a, b) => a.startTime - b.startTime);
		return results;
	}
);

// ---------------------------------------------------------------------------
// Twitch GQL helpers (moved from API routes)
// ---------------------------------------------------------------------------

const BROWSE_STREAMS_QUERY = `query($first: Int!, $after: Cursor, $opts: StreamOptions) {
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

const BROWSE_GAME_STREAMS_QUERY = `query($id: ID!, $first: Int!, $after: Cursor, $opts: GameStreamOptions) {
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

const SEARCH_CATEGORIES_GQL = `query($query: String!) {
	searchCategories(query: $query, first: 10) {
		edges {
			node {
				id
				name
			}
		}
	}
}`;

const CHANNEL_LOOKUP_GQL = `query($login: String!) {
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

const CHANNEL_VODS_GQL = `query($login: String!, $first: Int, $after: Cursor, $type: BroadcastType) {
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

interface BrowseStreamEdge {
	cursor: string;
	node: {
		broadcaster: { login: string; displayName: string; profileImageURL: string };
		viewersCount: number;
		title: string;
		game: { name: string } | null;
		createdAt: string;
	};
}

interface VideoEdge {
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

function mapBrowseEdges(edges: BrowseStreamEdge[]): { streams: ChannelInfo[]; cursor: string | null } {
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

async function twitchGql(gqlQuery: string, variables: Record<string, unknown>): Promise<unknown> {
	const res = await fetch('https://gql.twitch.tv/gql', {
		method: 'POST',
		headers: {
			'Client-ID': TWITCH_CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query: gqlQuery, variables })
	});
	return res.json();
}

async function fetchTwitchChannel(login: string): Promise<ChannelInfo> {
	try {
		const data = await twitchGql(CHANNEL_LOOKUP_GQL, { login }) as Record<string, unknown>;
		const user = (data as { data?: { user?: Record<string, unknown> } })?.data?.user;
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

async function fetchDouyuChannel(roomId: string): Promise<ChannelInfo> {
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

// ---------------------------------------------------------------------------
// Queries — Browse & Discovery
// ---------------------------------------------------------------------------

/** Browse live Twitch streams, optionally filtered by game. */
export const browseStreams = query(
	'unchecked',
	async (args: { gameId?: string; first?: number; after?: string }) => {
		const gameId = args.gameId;
		const maxFirst = gameId ? 100 : 30;
		const first = Math.min(Math.max(args.first ?? maxFirst, 1), maxFirst);
		const after = args.after;

		try {
			const gqlQuery = gameId ? BROWSE_GAME_STREAMS_QUERY : BROWSE_STREAMS_QUERY;
			const variables: Record<string, unknown> = { first, opts: { languages: ['EN'] } };
			if (after) variables.after = after;
			if (gameId) variables.id = gameId;

			const data = await twitchGql(gqlQuery, variables) as Record<string, unknown>;

			if ((data as { errors?: unknown[] }).errors) {
				console.error('Twitch GQL errors:', (data as { errors: unknown[] }).errors);
				return { streams: [] as ChannelInfo[], cursor: null as string | null, hasNextPage: false };
			}

			const connection = gameId
				? (data as { data?: { game?: { streams?: { edges: BrowseStreamEdge[]; pageInfo?: { hasNextPage?: boolean } } } } })?.data?.game?.streams
				: (data as { data?: { streams?: { edges: BrowseStreamEdge[]; pageInfo?: { hasNextPage?: boolean } } } })?.data?.streams;

			if (!connection) {
				return { streams: [] as ChannelInfo[], cursor: null as string | null, hasNextPage: false };
			}

			const edges: BrowseStreamEdge[] = connection.edges ?? [];
			const { streams, cursor: lastCursor } = mapBrowseEdges(edges);
			const hasNextPage = connection.pageInfo?.hasNextPage ?? false;

			return { streams, cursor: lastCursor, hasNextPage };
		} catch (err) {
			console.error('Browse API error:', err);
			return { streams: [] as ChannelInfo[], cursor: null as string | null, hasNextPage: false };
		}
	}
);

/** Search Twitch game categories by name. */
export const searchCategories = query(
	'unchecked',
	async (args: { query: string }) => {
		const q = args.query ?? '';
		if (!q.trim()) return { categories: [] as Array<{ id: string; name: string }> };

		try {
			const data = await twitchGql(SEARCH_CATEGORIES_GQL, { query: q }) as Record<string, unknown>;
			const edges = ((data as { data?: { searchCategories?: { edges?: Array<{ node: { id: string; name: string } }> } } })?.data?.searchCategories?.edges) ?? [];
			const categories = edges.map((e) => ({ id: e.node.id, name: e.node.name }));
			return { categories };
		} catch (err) {
			console.error('Category search error:', err);
			return { categories: [] as Array<{ id: string; name: string }> };
		}
	}
);

/** Load ignored channel logins from the database. */
export const getIgnoredChannels = query(async () => {
	return { channels: loadIgnoredChannels() };
});

/** Batch channel info lookup (Twitch or Douyu). */
export const lookupChannels = query(
	'unchecked',
	async (args: { channels: string[]; platform?: string }) => {
		const channels = args.channels;
		const platform = args.platform || 'twitch';

		if (!Array.isArray(channels) || channels.length === 0) {
			return { channels: [] as ChannelInfo[] };
		}

		const fetcher = platform === 'douyu' ? fetchDouyuChannel : fetchTwitchChannel;
		const results = await Promise.all(channels.map(fetcher));
		return { channels: results };
	}
);

/** Get past VODs for a Twitch channel. */
export const getChannelVods = query(
	'unchecked',
	async (args: { login: string; first?: number; after?: string }) => {
		const login = args.login;
		const first = Math.min(Math.max(args.first ?? 20, 1), 100);
		const after = args.after;

		if (!login) {
			return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
		}

		try {
			const variables: Record<string, unknown> = { login, first, type: 'ARCHIVE' };
			if (after) variables.after = after;

			const data = await twitchGql(CHANNEL_VODS_GQL, variables) as Record<string, unknown>;

			if ((data as { errors?: unknown[] }).errors) {
				console.error('Twitch GQL errors (vods):', (data as { errors: unknown[] }).errors);
				return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
			}

			const connection = (data as { data?: { user?: { videos?: { edges: VideoEdge[]; pageInfo?: { hasNextPage?: boolean } } } } })?.data?.user?.videos;
			if (!connection) {
				return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
			}

			const edges: VideoEdge[] = connection.edges ?? [];
			const lastCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
			const hasNextPage = connection.pageInfo?.hasNextPage ?? false;

			const vods: VodInfo[] = edges.map((edge) => ({
				id: edge.node.id,
				title: edge.node.title ?? null,
				createdAt: edge.node.createdAt ?? null,
				durationSeconds: edge.node.lengthSeconds ?? null,
				thumbnailUrl: edge.node.previewThumbnailURL ?? null,
				viewCount: edge.node.viewCount ?? null
			}));

			return { vods, cursor: lastCursor, hasNextPage };
		} catch (err) {
			console.error('Vods API error:', err);
			return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
		}
	}
);

/** Load all per-channel settings from the database. */
export const getAllChannelSettings = query(async () => {
	return { settings: loadAllChannelSettings() };
});

/** Load the watchlist from the database. */
export const getWatchlist = query(async () => {
	return { watchlist: dbLoadWatchlist() };
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Ignore a channel in the discovery browser. */
export const ignoreChannelCmd = command('unchecked', async (args: { login: string }) => {
	if (!args.login?.trim()) throw new Error('login required');
	addIgnoredChannel(args.login.trim());
});

/** Un-ignore a channel. */
export const unignoreChannelCmd = command('unchecked', async (args: { login: string }) => {
	if (!args.login?.trim()) throw new Error('login required');
	removeIgnoredChannel(args.login.trim());
});

/** Save per-channel transcription language setting. */
export const saveChannelSettingsCmd = command('unchecked', async (args: { login: string; language?: string | null }) => {
	if (!args.login?.trim()) throw new Error('login required');
	saveChannelSettings(args.login.trim(), args.language || null);
});

/** Add a channel to the watchlist. */
export const addToWatchlistCmd = command('unchecked', async (args: { login: string; platform?: string }) => {
	if (!args.login || typeof args.login !== 'string') throw new Error('Missing or invalid "login" field');
	dbAddToWatchlist(args.login.toLowerCase().trim(), args.platform || 'twitch');
});

/** Remove a channel from the watchlist. */
export const removeFromWatchlistCmd = command('unchecked', async (args: { login: string; platform?: string }) => {
	if (!args.login || typeof args.login !== 'string') throw new Error('Missing or invalid "login" field');
	dbRemoveFromWatchlist(args.login.toLowerCase().trim(), args.platform || 'twitch');
});

/** Export all clip regions into a single video file. */
export const exportVideoCmd = command('unchecked', async (args: { filename: string }) => {
	if (!args.filename || typeof args.filename !== 'string' || args.filename.trim().length === 0) {
		throw new Error('Filename is required');
	}
	const result = await exportVideo(args.filename.trim());
	return { success: true, outputPath: result.outputPath };
});

/** Add a stream (live or VOD). */
export const addStreamCmd = command(
	'unchecked',
	async (args: {
		channel: string;
		language?: string | null;
		vod?: boolean;
		vodUrl?: string;
		platform?: 'twitch' | 'douyu';
	}) => {
		if (args.vodUrl) {
			const info = await addVodByUrl(args.vodUrl.trim(), args.language ?? null);
			await getStreams().refresh();
			return info;
		}

		const cleanChannel = normalizeChannel(args.channel);

		if (!cleanChannel) throw new Error('Invalid channel name');

		const info = args.vod
			? await addVodStream(cleanChannel, args.language ?? null)
			: await smAddStream(cleanChannel, args.language ?? null, args.platform || 'twitch');

		await getStreams().refresh();
		return info;
	}
);

/** Stop a stream's capture. */
export const stopStreamCmd = command('unchecked', async (args: { id: string }) => {
	smStopStream(args.id);
	await getStreams().refresh();
});

/** Remove a stream entirely. */
export const removeStreamCmd = command('unchecked', async (args: { id: string }) => {
	const success = smRemoveStream(args.id);
	if (!success) throw new Error('Stream not found');
	await getStreams().refresh();
});

/** Re-transcribe a stopped stream. */
export const retranscribeCmd = command('unchecked', async (args: { id: string }) => {
	smRetranscribe(args.id);
});

/** Refetch VOD chat for a stopped Twitch VOD. */
export const refetchVodChatCmd = command('unchecked', async (args: { id: string }) => {
	const success = smRefetchVodChat(args.id);
	if (!success) throw new Error('Cannot refetch chat: stream must be a Twitch VOD');
});

/** Resume a stopped Twitch VOD capture. */
export const resumeVodCmd = command('unchecked', async (args: { id: string }) => {
	const success = smResumeVod(args.id);
	if (!success) throw new Error('Cannot resume: stream must be a stopped Twitch VOD');
	await getStreams().refresh();
});

/** Update a stream's sync offset. */
export const updateOffsetCmd = command('unchecked', async (args: { id: string; offset: number }) => {
	updateStreamOffset(args.id, args.offset);
});

/** Save (upsert) a clip region. */
export const saveClipCmd = command(
	'unchecked',
	async (region: { id: string; streamId: string; startTime: number; endTime: number }) => {
		addClipRegion(region);
	}
);

/** Delete a clip region. */
export const deleteClipCmd = command('unchecked', async (args: { id: string }) => {
	removeClipRegion(args.id);
});
