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
	getTranscriptionsInRange as smGetTranscriptionsInRange
} from '$lib/server/streamManager.js';
import type { ChatMessage } from '$lib/server/types.js';

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
// Commands
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
