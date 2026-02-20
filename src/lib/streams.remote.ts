import { query, command } from '$app/server';
import {
	listStreams,
	getTranscriptions,
	getAllClipRegions,
	addStream as smAddStream,
	addVodStream,
	addVodByUrl,
	stopStream as smStopStream,
	removeStream as smRemoveStream,
	retranscribeStream as smRetranscribe,
	resumeVodStream as smResumeVod,
	updateStreamOffset,
	addClipRegion,
	removeClipRegion,
	getChatHeatmap as smGetChatHeatmap,
	getChatMessagesInRange as smGetChatMessagesInRange
} from '$lib/server/streamManager.js';
import type { ChatMessage } from '$lib/server/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List all streams with transcriptions and clip regions. */
export const getStreams = query(async () => {
	const streams = listStreams();
	const transcriptions: Record<string, Array<{ text: string; startTime: number; endTime: number }>> = {};
	for (const s of streams) {
		const entries = getTranscriptions(s.id);
		if (entries.length > 0) {
			transcriptions[s.id] = entries;
		}
	}
	const clipRegions = getAllClipRegions();
	return { streams, transcriptions, clipRegions };
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

		const cleanChannel = args.channel
			.replace(/^https?:\/\/(www\.)?(twitch\.tv|douyu\.com)\//, '')
			.replace(/\/.*$/, '')
			.trim()
			.toLowerCase();

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
