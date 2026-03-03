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
	deleteExport as smDeleteExport,
	createVideo as smCreateVideo,
	updateVideo as smUpdateVideo,
	deleteVideo as smDeleteVideo,
	getVideo as smGetVideo,
	getAllVideos as smGetAllVideos
} from '$lib/server/streamManager.js';
import {
	loadAllChannelSettings,
	saveChannelSettings,
	loadWatchlist as dbLoadWatchlist,
	addToWatchlist as dbAddToWatchlist,
	removeFromWatchlist as dbRemoveFromWatchlist,
	saveCameraBounds as dbSaveCameraBounds,
	resolveCameraBounds as dbResolveCameraBounds,
	deleteCameraBounds as dbDeleteCameraBounds,
	loadCameraBoundsForChannel as dbLoadCameraBoundsForChannel,
	loadChatMessageByTwitchId as dbLoadChatMessageByTwitchId,
	loadAllCensorTerms as dbLoadAllCensorTerms,
	addCensorTerm as dbAddCensorTerm,
	removeCensorTerm as dbRemoveCensorTerm
} from '$lib/server/db/index.js';
import {
	twitchGql,
	fetchTwitchChannel,
	mapVideoEdges,
	CHANNEL_VODS_GQL,
	type VideoEdge
} from '$lib/server/twitchApi.js';
import type { ChannelInfo, VodInfo, CameraBoundsEntry, ClipEntry, EffectEntry, VideoRecord } from '$lib/types.js';

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

/** Look up a single chat message by its Twitch message ID. */
export const getChatMessageByTwitchId = query('unchecked', async (args: { twitchId: string }) => {
	return dbLoadChatMessageByTwitchId(args.twitchId);
});

// ---------------------------------------------------------------------------
// Queries — Channel Lookup & VODs
// ---------------------------------------------------------------------------

/** Batch channel info lookup. */
export const lookupChannels = query('unchecked', async (args: { channels: string[]; platform?: string }) => {
	const channels = args.channels;

	if (!Array.isArray(channels) || channels.length === 0) {
		return { channels: [] as ChannelInfo[] };
	}

	const results = await Promise.all(channels.map(fetchTwitchChannel));
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

/** Load all censor terms from the database. */
export const getCensorTerms = query(async () => {
	return dbLoadAllCensorTerms();
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
			: await smAddStream(cleanChannel, args.language ?? null);

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

/** Add a censor term. */
export const addCensorTermCmd = command('unchecked', async (args: { term: string }) => {
	if (!args.term?.trim()) throw new Error('term required');
	dbAddCensorTerm(args.term.trim());
	await getCensorTerms().refresh();
});

/** Remove a censor term. */
export const removeCensorTermCmd = command('unchecked', async (args: { term: string }) => {
	if (!args.term?.trim()) throw new Error('term required');
	dbRemoveCensorTerm(args.term.trim());
	await getCensorTerms().refresh();
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

// ---------------------------------------------------------------------------
// Commands — Videos
// ---------------------------------------------------------------------------

/** Create a new video composition. */
export const createVideoCmd = command('unchecked', async (args: {
	clipIds: string[];
	title: string;
	description?: string;
	format?: 'standard' | 'mobile_short';
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
	effectEntries?: EffectEntry[];
	format?: 'standard' | 'mobile_short';
}): Promise<VideoRecord> => {
	const updates: Partial<Pick<VideoRecord, 'title' | 'description' | 'clipEntries' | 'effectEntries' | 'format'>> = {};
	if (args.title !== undefined) updates.title = args.title;
	if (args.description !== undefined) updates.description = args.description;
	if (args.clipEntries !== undefined) updates.clipEntries = args.clipEntries;
	if (args.effectEntries !== undefined) updates.effectEntries = args.effectEntries;
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

/** List all video exports. */
export const listExports = query(async () => {
	return { exports: smLoadAllExports() };
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
	const { loadAllYouTubeAccounts } = await import('$lib/server/db/index.js');
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
	const { deleteYouTubeAccount } = await import('$lib/server/db/index.js');
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

/** Upload an overlay image (base64 data) → saves to data/overlays/ and returns ID + dimensions. */
export const uploadOverlayImageCmd = command('unchecked', async (args: { data: string; filename: string }) => {
	const { newOverlayImageId } = await import('$lib/ids.js');
	const { loadImage } = await import('@napi-rs/canvas');
	const path = await import('node:path');
	const fs = await import('node:fs');

	const OVERLAYS_DIR = path.resolve(process.cwd(), 'data', 'overlays');
	if (!fs.existsSync(OVERLAYS_DIR)) fs.mkdirSync(OVERLAYS_DIR, { recursive: true });

	const ext = path.extname(args.filename).toLowerCase() || '.png';
	const id = newOverlayImageId();
	const filePath = path.join(OVERLAYS_DIR, `${id}${ext}`);

	const buffer = Buffer.from(args.data, 'base64');
	fs.writeFileSync(filePath, buffer);

	const img = await loadImage(buffer);
	return { id: `${id}${ext}`, width: img.width, height: img.height };
});

/** Upload an overlay audio file (base64 data) → saves to data/audio/ and returns ID + duration. */
export const uploadOverlayAudioCmd = command('unchecked', async (args: { data: string; filename: string }) => {
	const { newOverlayAudioId } = await import('$lib/ids.js');
	const path = await import('node:path');
	const fs = await import('node:fs');

	const AUDIO_DIR = path.resolve(process.cwd(), 'data', 'audio');
	if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

	const ext = path.extname(args.filename).toLowerCase() || '.mp3';
	const id = newOverlayAudioId();
	const filePath = path.join(AUDIO_DIR, `${id}${ext}`);

	const buffer = Buffer.from(args.data, 'base64');
	fs.writeFileSync(filePath, buffer);

	// Probe duration via ffprobe
	let duration = 0;
	try {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'json', filePath],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code === 0) {
			const data = JSON.parse(stdout);
			duration = parseFloat(data.format?.duration) || 0;
		}
	} catch { /* fallback to 0 */ }

	return { id: `${id}${ext}`, duration };
});

/** Export selected clips by IDs (in order). */
export const exportSelectedClipsCmd = command('unchecked', async (args: { clipIds: string[]; title: string; format?: 'standard' | 'mobile_short' }) => {
	if (!args.clipIds || args.clipIds.length === 0) {
		throw new Error('No clips selected');
	}
	if (!args.title?.trim()) {
		throw new Error('Title is required');
	}
	const record = createAndQueueExport(args.clipIds, args.title.trim(), undefined, args.format);
	return { success: true, exportId: record.id };
});
