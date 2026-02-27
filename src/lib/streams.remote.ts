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
	createAndQueueExportFromVideo,
	requeueExport as smRequeueExport,
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport,
	deleteExport as smDeleteExport,
	createVideo as smCreateVideo,
	updateVideo as smUpdateVideo,
	deleteVideo as smDeleteVideo,
	getVideo as smGetVideo,
	getAllVideos as smGetAllVideos
} from '$lib/server/streamManager.js';
import {
	addIgnoredChannel,
	removeIgnoredChannel,
	loadIgnoredChannels,
	loadAllChannelSettings,
	saveChannelSettings,
	loadWatchlist as dbLoadWatchlist,
	addToWatchlist as dbAddToWatchlist,
	removeFromWatchlist as dbRemoveFromWatchlist,
	saveCameraBounds as dbSaveCameraBounds,
	resolveCameraBounds as dbResolveCameraBounds,
	deleteCameraBounds as dbDeleteCameraBounds,
	loadCameraBoundsForChannel as dbLoadCameraBoundsForChannel
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
import type { ChannelInfo, VodInfo, CameraBoundsEntry, ClipEntry, VideoRecord } from '$lib/types.js';

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
		favourite?: boolean;
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
		favourite?: boolean;
	}) => {
		addClipRegion(region);
	}
);

/** Delete a clip region. */
export const deleteClipCmd = command('unchecked', async (args: { id: string }) => {
	removeClipRegion(args.id);
});

// ---------------------------------------------------------------------------
// Commands & Queries — Channel Camera Bounds
// ---------------------------------------------------------------------------

/** Save camera bounds for a channel at a specific timestamp. */
export const saveCameraBoundsCmd = command(
	'unchecked',
	async (args: { channel: string; timestamp: number; camX: number; camY: number; camW: number; camH: number }): Promise<CameraBoundsEntry> => {
		return dbSaveCameraBounds(args.channel, args.timestamp, args.camX, args.camY, args.camW, args.camH);
	}
);

/** Resolve camera bounds for a channel at a timestamp (most recent entry at or before). */
export const getCameraBounds = query(
	'unchecked',
	async (args: { channel: string; timestamp: number }): Promise<{ bounds: CameraBoundsEntry | null }> => {
		return { bounds: dbResolveCameraBounds(args.channel, args.timestamp) };
	}
);

/** Delete a camera bounds entry by ID. */
export const deleteCameraBoundsCmd = command(
	'unchecked',
	async (args: { id: number }) => {
		dbDeleteCameraBounds(args.id);
	}
);

/** Load all camera bounds entries for a channel. */
export const loadCameraBoundsForChannel = query(
	'unchecked',
	async (args: { channel: string }): Promise<{ bounds: CameraBoundsEntry[] }> => {
		return { bounds: dbLoadCameraBoundsForChannel(args.channel) };
	}
);

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

// ---------------------------------------------------------------------------
// Queries — Videos
// ---------------------------------------------------------------------------

/** List all video compositions. */
export const listVideos = query(async (): Promise<VideoRecord[]> => {
	return smGetAllVideos();
});

/** Get a video by ID. */
export const getVideoById = query('unchecked', async (args: { id: string }): Promise<VideoRecord> => {
	const video = smGetVideo(args.id);
	if (!video) throw new Error('Video not found');
	return video;
});

/** Get exports associated with a video. */
export const getExportsByVideo = query('unchecked', async (args: { videoId: string }) => {
	const { loadExportsByVideo } = await import('$lib/server/persistence.js');
	return { exports: loadExportsByVideo(args.videoId) };
});

/** Get thumbnail for a video. */
export const getThumbnailByVideo = query('unchecked', async (args: { videoId: string }) => {
	const { loadThumbnailByVideo } = await import('$lib/server/persistence.js');
	return { thumbnail: loadThumbnailByVideo(args.videoId) };
});

// ---------------------------------------------------------------------------
// Commands — Videos
// ---------------------------------------------------------------------------

/** Create a new video composition. */
export const createVideoCmd = command('unchecked', async (args: {
	clipIds: string[];
	title: string;
	description?: string;
	format?: 'standard' | 'mobile_short' | 'chat_overlay';
}): Promise<VideoRecord> => {
	const clipEntries: ClipEntry[] = args.clipIds.map((clipId) => ({ clipId }));
	return smCreateVideo({
		title: args.title,
		description: args.description,
		clipEntries,
		format: args.format
	});
});

/** Update a video composition. */
export const updateVideoCmd = command('unchecked', async (args: {
	id: string;
	title?: string;
	description?: string;
	clipEntries?: ClipEntry[];
	format?: 'standard' | 'mobile_short' | 'chat_overlay';
}): Promise<VideoRecord> => {
	const updates: Partial<Pick<VideoRecord, 'title' | 'description' | 'clipEntries' | 'format'>> = {};
	if (args.title !== undefined) updates.title = args.title;
	if (args.description !== undefined) updates.description = args.description;
	if (args.clipEntries !== undefined) updates.clipEntries = args.clipEntries;
	if (args.format !== undefined) updates.format = args.format;
	return smUpdateVideo(args.id, updates);
});

/** Delete a video composition. */
export const deleteVideoCmd = command('unchecked', async (args: { id: string }) => {
	const deleted = smDeleteVideo(args.id);
	if (!deleted) throw new Error('Video not found');
	return { success: true };
});

/** Export a video composition (creates and queues an export). */
export const exportVideoFromVideoCmd = command('unchecked', async (args: { videoId: string }) => {
	const record = createAndQueueExportFromVideo(args.videoId);
	return { success: true, exportId: record.id };
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
	const record = createAndQueueExport(sortedIds, args.filename.trim(), undefined, undefined);
	return { success: true, exportId: record.id };
});

/** List all video exports. */
export const listExports = query(async () => {
	return { exports: smLoadAllExports() };
});

/** Get a specific export by ID. */
export const getExport = query('unchecked', async (args: { id: string }) => {
	const record = smLoadExport(args.id);
	if (!record) throw new Error('Export not found');
	return record;
});

/** Re-export an existing export in place (resets status and re-queues). */
export const reexportCmd = command('unchecked', async (args: { id: string }) => {
	smRequeueExport(args.id);
	return { exportId: args.id };
});

/** Delete an export by ID (removes DB record and output file). */
export const deleteExportCmd = command('unchecked', async (args: { id: string }) => {
	if (!args.id || typeof args.id !== 'string') throw new Error('Missing or invalid "id" field');
	smDeleteExport(args.id);
	return { success: true };
});

// ---------------------------------------------------------------------------
// Queries — YouTube
// ---------------------------------------------------------------------------

/** YouTube integration status and connected accounts. */
export const youtubeStatus = query(async () => {
	const { isConfigured } = await import('$lib/server/youtubeClient.js');
	const { loadAllYouTubeAccounts } = await import('$lib/server/persistence.js');
	return {
		configured: isConfigured(),
		accounts: loadAllYouTubeAccounts().map((a) => ({
			id: a.id,
			channelId: a.channelId,
			channelName: a.channelName,
			channelThumbnail: a.channelThumbnail
		}))
	};
});

/** Fetch YouTube video categories. */
export const youtubeCategories = query('unchecked', async (args: { regionCode?: string }) => {
	const { getVideoCategories } = await import('$lib/server/youtubeClient.js');
	return { categories: await getVideoCategories(args.regionCode) };
});

/** Fetch YouTube playlists for a specific account. */
export const youtubePlaylists = query('unchecked', async (args: { accountId: string }) => {
	const { getUserPlaylists } = await import('$lib/server/youtubeClient.js');
	return { playlists: await getUserPlaylists(args.accountId) };
});

/** List all YouTube uploads. */
export const youtubeUploads = query(async () => {
	const { loadAllUploads } = await import('$lib/server/youtubeUploadQueue.js');
	return { uploads: loadAllUploads() };
});

/** List YouTube uploads for a specific export. */
export const youtubeUploadsByExport = query('unchecked', async (args: { exportId: string }) => {
	const { loadUploadsByExport } = await import('$lib/server/youtubeUploadQueue.js');
	return { uploads: loadUploadsByExport(args.exportId) };
});

// ---------------------------------------------------------------------------
// Commands — YouTube
// ---------------------------------------------------------------------------

/** Get the YouTube OAuth URL for connecting a new account. */
export const youtubeAuthUrl = query(async () => {
	const { getAuthUrl, isConfigured } = await import('$lib/server/youtubeClient.js');
	if (!isConfigured()) throw new Error('YouTube integration not configured');
	return { url: getAuthUrl() };
});

/** Remove a connected YouTube account. */
export const youtubeRemoveAccountCmd = command('unchecked', async (args: { accountId: string }) => {
	const { deleteYouTubeAccount } = await import('$lib/server/persistence.js');
	deleteYouTubeAccount(args.accountId);
	return { success: true };
});

/** Queue a YouTube upload. */
export const youtubeUploadCmd = command(
	'unchecked',
	async (args: {
		exportId: string;
		accountId: string;
		title: string;
		description?: string;
		privacy: string;
		tags?: string[];
		categoryId?: string;
		playlistId?: string;
	}) => {
		const { createAndQueueUpload } = await import('$lib/server/youtubeUploadQueue.js');
		const record = createAndQueueUpload(args.exportId, args.accountId, {
			title: args.title,
			description: args.description,
			privacy: args.privacy,
			tags: args.tags,
			categoryId: args.categoryId,
			playlistId: args.playlistId
		});
		return { uploadId: record.id };
	}
);

/** Delete a YouTube upload record. */
export const youtubeDeleteUploadCmd = command('unchecked', async (args: { id: string }) => {
	const { deleteUpload } = await import('$lib/server/youtubeUploadQueue.js');
	deleteUpload(args.id);
	return { success: true };
});

// ---------------------------------------------------------------------------
// Queries — Thumbnails
// ---------------------------------------------------------------------------

/** Get thumbnail for an export. */
export const getThumbnailByExport = query('unchecked', async (args: { exportId: string }) => {
	const { loadThumbnailByExport } = await import('$lib/server/persistence.js');
	return { thumbnail: loadThumbnailByExport(args.exportId) };
});

/** Check if AI (Gemini) is configured. */
export const isAIConfigured = query(async () => {
	const { isAIConfigured } = await import('$lib/server/thumbnailStore.js');
	return { configured: isAIConfigured() };
});

// ---------------------------------------------------------------------------
// Commands — Thumbnails
// ---------------------------------------------------------------------------

/** Save a thumbnail PNG for an export or video. */
export const saveThumbnailCmd = command('unchecked', async (args: {
	exportId: string;
	videoId?: string;
	pngBase64: string;
	width?: number;
	height?: number;
	layers?: Array<
		| {
			id: string; type: 'text';
			text: string; x: number; y: number;
			fontSize: number; fontFamily: string; color: string;
			strokeColor?: string; strokeWidth?: number; rotation?: number; scaleX?: number; scaleY?: number;
			cropX?: number; cropY?: number; cropW?: number; cropH?: number;
			shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
		}
		| {
			id: string; type: 'image';
			x: number; y: number;
			rotation?: number; scaleX?: number; scaleY?: number;
			opacity?: number;
			cropX?: number; cropY?: number; cropW?: number; cropH?: number;
			streamId?: string; timestamp?: number;
			dataUrl?: string;
			naturalWidth: number; naturalHeight: number;
		}
		| {
			id: string; type: 'effect';
			kind: 'blur' | 'ai';
			blurRadius?: number;
			prompt?: string;
		}
	>;
}) => {
	const { saveThumbnailFromPng } = await import('$lib/server/thumbnailStore.js');
	const pngBuffer = Buffer.from(args.pngBase64, 'base64');
	const record = saveThumbnailFromPng(args.exportId, pngBuffer, {
		width: args.width,
		height: args.height,
		layers: args.layers,
		videoId: args.videoId
	});
	return record;
});

/** Enhance a thumbnail with AI (Gemini). */
export const enhanceThumbnailCmd = command('unchecked', async (args: {
	thumbnailId: string;
	prompt: string;
	conversationHistory?: Array<{ role: 'user' | 'model'; text?: string; imageBase64?: string }>;
}) => {
	const { enhanceWithAI } = await import('$lib/server/thumbnailStore.js');
	return await enhanceWithAI(args.thumbnailId, args.prompt, args.conversationHistory);
});

/** Run Nano Banana Pro AI edit on a raw PNG (stateless, no disk I/O). */
export const aiEditImageCmd = command('unchecked', async (args: {
	pngBase64: string;
	prompt: string;
}) => {
	const { aiEditImage } = await import('$lib/server/thumbnailStore.js');
	const resultBase64 = await aiEditImage(args.pngBase64, args.prompt);
	return { pngBase64: resultBase64 };
});

/** Delete a thumbnail. */
export const deleteThumbnailCmd = command('unchecked', async (args: { id: string }) => {
	const { deleteThumbnailById } = await import('$lib/server/thumbnailStore.js');
	deleteThumbnailById(args.id);
	return { success: true };
});

/** Export selected clips by IDs (in order). */
export const exportSelectedClipsCmd = command('unchecked', async (args: { clipIds: string[]; title: string; format?: 'standard' | 'mobile_short' | 'chat_overlay' }) => {
	if (!args.clipIds || args.clipIds.length === 0) {
		throw new Error('No clips selected');
	}
	if (!args.title?.trim()) {
		throw new Error('Title is required');
	}
	const record = createAndQueueExport(args.clipIds, args.title.trim(), undefined, args.format);
	return { success: true, exportId: record.id };
});
