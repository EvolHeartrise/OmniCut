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
	createClipRegion as smCreateClipRegion,
	removeClipRegion,
	getChatHeatmap as smGetChatHeatmap,
	getChatMessagesInRange as smGetChatMessagesInRange,
	getTranscriptionsInRange as smGetTranscriptionsInRange,
	createAndQueueExport,
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport,
	getClipEncodeStatuses as smGetClipEncodeStatuses
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
import {
	twitchGql,
	fetchTwitchChannel,
	fetchDouyuChannel,
	mapBrowseEdges,
	mapVideoEdges,
	BROWSE_STREAMS_GQL,
	BROWSE_GAME_STREAMS_GQL,
	SEARCH_CATEGORIES_GQL,
	CHANNEL_VODS_GQL,
	type BrowseStreamEdge,
	type VideoEdge
} from '$lib/server/twitchApi.js';
import type { ChannelInfo, VodInfo } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Queries — Stream & Media Data
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

/** Chat messages in a time range for multiple streams (merged & sorted).
 *  Optional `limit` caps total results per stream (returns the most recent N). */
export const getMultiStreamChat = query(
	'unchecked',
	async (args: { ranges: Array<{ streamId: string; from: number; to: number }>; limit?: number }) => {
		const results: Array<ReturnType<typeof smGetChatMessagesInRange>[number] & { streamId: string }> = [];
		for (const range of args.ranges) {
			const messages = smGetChatMessagesInRange(range.streamId, range.from, range.to, undefined, args.limit);
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
		const results: Array<{ id: number; streamId: string; text: string; startTime: number; endTime: number }> = [];
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
// Queries — Browse & Discovery
// ---------------------------------------------------------------------------

/** Browse live Twitch streams, optionally filtered by game. */
export const browseStreams = query('unchecked', async (args: { gameId?: string; first?: number; after?: string }) => {
	const gameId = args.gameId;
	const maxFirst = gameId ? 100 : 30;
	const first = Math.min(Math.max(args.first ?? maxFirst, 1), maxFirst);
	const after = args.after;

	try {
		const gqlQuery = gameId ? BROWSE_GAME_STREAMS_GQL : BROWSE_STREAMS_GQL;
		const variables: Record<string, unknown> = { first, opts: { languages: ['EN'] } };
		if (after) variables.after = after;
		if (gameId) variables.id = gameId;

		const data = await twitchGql<Record<string, unknown>>(gqlQuery, variables);

		if ((data as { errors?: unknown[] }).errors) {
			console.error('Twitch GQL errors:', (data as { errors: unknown[] }).errors);
			return { streams: [] as ChannelInfo[], cursor: null as string | null, hasNextPage: false };
		}

		const connection = gameId
			? (
					data as {
						data?: { game?: { streams?: { edges: BrowseStreamEdge[]; pageInfo?: { hasNextPage?: boolean } } } };
					}
				)?.data?.game?.streams
			: (data as { data?: { streams?: { edges: BrowseStreamEdge[]; pageInfo?: { hasNextPage?: boolean } } } })?.data
					?.streams;

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
});

/** Search Twitch game categories by name. */
export const searchCategories = query('unchecked', async (args: { query: string }) => {
	const q = args.query ?? '';
	if (!q.trim()) return { categories: [] as Array<{ id: string; name: string }> };

	try {
		const data = await twitchGql<{
			data?: { searchCategories?: { edges?: Array<{ node: { id: string; name: string } }> } };
		}>(SEARCH_CATEGORIES_GQL, { query: q });
		const edges = data?.data?.searchCategories?.edges ?? [];
		const categories = edges.map((e) => ({ id: e.node.id, name: e.node.name }));
		return { categories };
	} catch (err) {
		console.error('Category search error:', err);
		return { categories: [] as Array<{ id: string; name: string }> };
	}
});

/** Load ignored channel logins from the database. */
export const getIgnoredChannels = query(async () => {
	return { channels: loadIgnoredChannels() };
});

/** Batch channel info lookup (Twitch or Douyu). */
export const lookupChannels = query('unchecked', async (args: { channels: string[]; platform?: string }) => {
	const channels = args.channels;
	const platform = args.platform || 'twitch';

	if (!Array.isArray(channels) || channels.length === 0) {
		return { channels: [] as ChannelInfo[] };
	}

	const fetcher = platform === 'douyu' ? fetchDouyuChannel : fetchTwitchChannel;
	const results = await Promise.all(channels.map(fetcher));
	return { channels: results };
});

/** Get past VODs for a Twitch channel. */
export const getChannelVods = query('unchecked', async (args: { login: string; first?: number; after?: string }) => {
	const login = args.login;
	const first = Math.min(Math.max(args.first ?? 20, 1), 100);
	const after = args.after;

	if (!login) {
		return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
	}

	try {
		const variables: Record<string, unknown> = { login, first, type: 'ARCHIVE' };
		if (after) variables.after = after;

		const data = await twitchGql<{
			errors?: unknown[];
			data?: { user?: { videos?: { edges: VideoEdge[]; pageInfo?: { hasNextPage?: boolean } } } };
		}>(CHANNEL_VODS_GQL, variables);

		if (data.errors) {
			console.error('Twitch GQL errors (vods):', data.errors);
			return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
		}

		const connection = data?.data?.user?.videos;
		if (!connection) {
			return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
		}

		const edges: VideoEdge[] = connection.edges ?? [];
		const lastCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
		const hasNextPage = connection.pageInfo?.hasNextPage ?? false;
		const vods = mapVideoEdges(edges);

		return { vods, cursor: lastCursor, hasNextPage };
	} catch (err) {
		console.error('Vods API error:', err);
		return { vods: [] as VodInfo[], cursor: null as string | null, hasNextPage: false };
	}
});

// ---------------------------------------------------------------------------
// Queries — Settings & Watchlist
// ---------------------------------------------------------------------------

/** Load all per-channel settings from the database. */
export const getAllChannelSettings = query(async () => {
	return { settings: loadAllChannelSettings() };
});

/** Load the watchlist from the database. */
export const getWatchlist = query(async () => {
	return { watchlist: dbLoadWatchlist() };
});

// ---------------------------------------------------------------------------
// Commands — Stream Management
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Commands — Clip Regions
// ---------------------------------------------------------------------------

/** Create a new clip region (server generates ID). Returns the created clip. */
export const createClipCmd = command(
	'unchecked',
	async (data: {
		streamId: string;
		startTime: number;
		endTime: number;
		createdBy?: 'human' | 'ai';
		title?: string;
		notes?: string;
	}) => {
		return smCreateClipRegion(data);
	}
);

/** Update an existing clip region (ID required). */
export const updateClipCmd = command(
	'unchecked',
	async (region: {
		id: string;
		streamId: string;
		startTime: number;
		endTime: number;
		createdBy?: 'human' | 'ai';
		title?: string;
		notes?: string;
	}) => {
		addClipRegion(region);
	}
);

/** Delete a clip region. */
export const deleteClipCmd = command('unchecked', async (args: { id: string }) => {
	removeClipRegion(args.id);
});

// ---------------------------------------------------------------------------
// Commands — Channel Settings & Watchlist
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
export const saveChannelSettingsCmd = command(
	'unchecked',
	async (args: { login: string; language?: string | null }) => {
		if (!args.login?.trim()) throw new Error('login required');
		saveChannelSettings(args.login.trim(), args.language || null);
	}
);

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

/** Export all clip regions into a single video file (via export queue). */
export const exportVideoCmd = command('unchecked', async (args: { filename: string }) => {
	if (!args.filename || typeof args.filename !== 'string' || args.filename.trim().length === 0) {
		throw new Error('Filename is required');
	}
	const { getAllClipRegions } = await import('$lib/server/streamManager.js');
	const clips = getAllClipRegions();
	if (clips.length === 0) {
		throw new Error('No clip regions to export');
	}
	// Sort by startTime for the UI export path
	const sortedIds = [...clips].sort((a, b) => a.startTime - b.startTime).map((c) => c.id);
	const record = createAndQueueExport(sortedIds, args.filename.trim());
	return { success: true, exportId: record.id };
});

/** List all video exports. */
export const listExportsCmd = query(async () => {
	return { exports: smLoadAllExports() };
});

/** Get a specific export by ID. */
export const getExportCmd = query('unchecked', async (args: { id: string }) => {
	const record = smLoadExport(args.id);
	if (!record) throw new Error('Export not found');
	return record;
});

/** Get encode statuses for a list of clip IDs. */
export const getClipEncodeStatuses = query('unchecked', async (args: { clipIds: string[] }) => {
	return smGetClipEncodeStatuses(args.clipIds);
});

/** Re-export an existing export (creates a new export with the same clips/title/description). */
export const reexportCmd = command('unchecked', async (args: { id: string }) => {
	const existing = smLoadExport(args.id);
	if (!existing) throw new Error('Export not found');
	const record = createAndQueueExport(existing.clipIds, existing.title, existing.description);
	return { exportId: record.id };
});

/** Export selected clips by IDs (in order). */
export const exportSelectedClipsCmd = command('unchecked', async (args: { clipIds: string[]; title: string }) => {
	if (!args.clipIds || args.clipIds.length === 0) {
		throw new Error('No clips selected');
	}
	if (!args.title?.trim()) {
		throw new Error('Title is required');
	}
	const record = createAndQueueExport(args.clipIds, args.title.trim());
	return { success: true, exportId: record.id };
});
