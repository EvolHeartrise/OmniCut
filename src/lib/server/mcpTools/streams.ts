/**
 * MCP tools: list_streams, query_at_time, retranscribe, get_word_timestamps, get_hotspots
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult, jsonResult } from './types.js';
import {
	listStreams, getStream, getAllClipRegions,
	getChatMessagesInRange, getTranscriptionsInRange, getChatHeatmap,
	retranscribeStream
} from '../streamManager.js';
import { loadWordTimestamps } from '../db/index.js';

export function registerStreamTools(server: ToolRegistrar): void {
	// --- list_streams ---
	server.tool('list_streams', 'List all streams with status, metadata, and clip counts.', {}, async () => {
		const clipRegions = getAllClipRegions();
		const clipCountsByStream: Record<string, number> = {};
		for (const r of clipRegions) {
			clipCountsByStream[r.streamId] = (clipCountsByStream[r.streamId] || 0) + 1;
		}
		const streams = listStreams().map((s) => ({
			id: s.id,
			channel: s.channel,
			status: s.status,
			startedAt: s.startedAt,
			streamTitle: s.streamTitle,
			gameName: s.gameName,
			platform: s.platform,
			sourceType: s.sourceType,
			viewerCount: s.viewerCount,
			durationSeconds: s.durationSeconds,
			clipCount: clipCountsByStream[s.id] ?? 0,
			...(s.error && { error: s.error })
		}));
		return jsonResult(streams);
	});

	// --- query_at_time ---
	server.tool(
		'query_at_time',
		'Get chat and transcription in a window centered on a timestamp.',
		{
			streamId: z.string(),
			timestamp: z.number().describe('Center timestamp (stream-local seconds)'),
			windowSeconds: z.number().optional().default(30)
		},
		async ({ streamId, timestamp, windowSeconds }) => {
			const stream = getStream(streamId);
			if (!stream) return textResult(`Stream "${streamId}" not found.`, true);

			const half = (windowSeconds ?? 30) / 2;
			const windowStart = Math.max(0, timestamp - half);
			const windowEnd = timestamp + half;

			const chat = getChatMessagesInRange(streamId, windowStart, windowEnd);
			const transcriptions = getTranscriptionsInRange(streamId, windowStart, windowEnd);

			// Sample chat: at most 30 messages per 5-second bucket
			const MAX_PER_BUCKET = 30;
			const BUCKET_SECONDS = 5;
			const totalChat = chat.length;
			const buckets = new Map<number, typeof chat>();
			for (const m of chat) {
				const key = Math.floor(m.timestamp / BUCKET_SECONDS);
				let bucket = buckets.get(key);
				if (!bucket) { bucket = []; buckets.set(key, bucket); }
				bucket.push(m);
			}
			const sampled: typeof chat = [];
			for (const [, bucket] of buckets) {
				if (bucket.length <= MAX_PER_BUCKET) {
					sampled.push(...bucket);
				} else {
					const badged = bucket.filter((m) => m.badges);
					const unbadged = bucket.filter((m) => !m.badges);
					if (badged.length >= MAX_PER_BUCKET) {
						for (let i = badged.length - 1; i > 0; i--) {
							const j = Math.floor(Math.random() * (i + 1));
							[badged[i], badged[j]] = [badged[j], badged[i]];
						}
						sampled.push(...badged.slice(0, MAX_PER_BUCKET));
					} else {
						sampled.push(...badged);
						const remaining = MAX_PER_BUCKET - badged.length;
						for (let i = unbadged.length - 1; i > unbadged.length - 1 - remaining; i--) {
							const j = Math.floor(Math.random() * (i + 1));
							[unbadged[i], unbadged[j]] = [unbadged[j], unbadged[i]];
						}
						sampled.push(...unbadged.slice(unbadged.length - remaining));
					}
				}
			}
			sampled.sort((a, b) => a.timestamp - b.timestamp);

			const chatLines = sampled.map((m) => {
				const t = +m.timestamp.toFixed(1);
				const badgePrefix = m.badges ? `[${m.badges}] ` : '';
				return `[${t}] ${badgePrefix}${m.username}: ${m.text}`;
			});
			const transcriptLines = transcriptions.map((t) => `[${+t.startTime.toFixed(1)}-${+t.endTime.toFixed(1)}] ${stream.channel}: ${t.text}`);

			const note = sampled.length < totalChat
				? `Too many messages to display. Showing ${sampled.length}/${totalChat} randomly sampled messages.`
				: undefined;

			const parts = [
				JSON.stringify({ channel: stream.channel, status: stream.status, durationSeconds: stream.durationSeconds, ...(note && { note }) }),
				'', '--- chat ---', ...chatLines, '', '--- transcription ---', ...transcriptLines
			];
			return textResult(parts.join('\n'));
		}
	);

	// --- get_hotspots ---
	server.tool(
		'get_hotspots',
		'Find peak moments by chat density. Accepts a single stream ID or an array. When multiple streams are provided, the top N hotspots are ranked across all streams combined. Each hotspot is a tuple: [streamId, channel, timeLocal, messageCount].',
		{
			streamId: z.union([z.string(), z.array(z.string())]),
			bucketSeconds: z.number().optional(),
			topN: z.number().optional().default(10),
			from: z.number().optional().describe('Stream-local seconds'),
			to: z.number().optional().describe('Stream-local seconds')
		},
		async ({ streamId, bucketSeconds, topN, from, to }) => {
			const ids = Array.isArray(streamId) ? streamId : [streamId];
			const n = topN ?? 10;
			const chatBucket = bucketSeconds ?? 30;

			const notFound = ids.filter((id) => !getStream(id));
			if (notFound.length > 0) return textResult(`Stream(s) not found: ${notFound.join(', ')}`, true);

			const allBuckets: [string, string, number, number][] = [];
			for (const id of ids) {
				const stream = getStream(id)!;
				const heatmap = getChatHeatmap(id, chatBucket);
				let buckets = heatmap.buckets;
				if (from !== undefined) buckets = buckets.filter((b) => b.time >= from);
				if (to !== undefined) buckets = buckets.filter((b) => b.time < to);
				for (const b of buckets) allBuckets.push([id, stream.channel, b.time, b.count]);
			}
			allBuckets.sort((a, b) => b[3] - a[3]);

			return jsonResult({ streamIds: ids, bucketSeconds: chatBucket, totalBuckets: allBuckets.length, hotspots: allBuckets.slice(0, n) });
		}
	);

	// --- retranscribe ---
	server.tool(
		'retranscribe',
		'Re-run transcription on a stopped stream (clears existing).',
		{ streamId: z.string() },
		async ({ streamId }) => {
			const stream = getStream(streamId);
			if (!stream) return textResult(`Stream "${streamId}" not found.`, true);

			const success = retranscribeStream(streamId);
			if (!success) {
				return textResult(`Cannot retranscribe stream "${streamId}": stream must be in "stopped" status (current: "${stream.status}").`, true);
			}
			return jsonResult({ success: true, message: `Retranscription started for stream "${stream.channel}" (${streamId}).` });
		}
	);

	// --- get_word_timestamps ---
	server.tool(
		'get_word_timestamps',
		'Get word-level timestamps for a transcription segment.',
		{ transcriptionId: z.number() },
		async ({ transcriptionId }) => {
			const words = loadWordTimestamps(transcriptionId);
			if (words.length === 0) {
				return jsonResult({ transcriptionId, words: [], message: 'No word timestamps found for this transcription.' });
			}
			const tuples = words.map((w) => [w.word, w.startTime, w.endTime]);
			return jsonResult({ transcriptionId, wordCount: words.length, words: tuples });
		}
	);
}
