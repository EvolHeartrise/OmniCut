/**
 * OmniCut MCP Server
 *
 * Exposes OmniCut's read-heavy workflow to AI agents via MCP (Model Context Protocol).
 * Tools are intentionally limited to non-destructive operations — agents can observe
 * streams, search chat & transcriptions, look up channels, and create clips, but cannot
 * stop captures, delete streams, or remove data.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
	listStreams,
	getStream,
	getAllClipRegions,
	addClipRegion,
	getChatMessagesInRange,
	getTranscriptionsInRange,
	getChatHeatmap,
	retranscribeStream,
	createAndQueueExport,
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport
} from './streamManager.js';

import {
	loadAllChannelSettings,
	loadWatchlist,
	loadWordTimestamps
} from './persistence.js';

import {
	fetchTwitchChannel,
	fetchDouyuChannel,
	twitchGql,
	CHANNEL_VODS_GQL,
	mapVideoEdges,
	type VideoEdge
} from './twitchApi.js';

// ---------------------------------------------------------------------------
// Server factory — one McpServer instance per transport/session
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {

const mcpServer = new McpServer(
	{
		name: 'omnicut',
		version: '1.0.0'
	},
	{
		capabilities: {
			tools: {}
		},
		instructions:
			'OmniCut is a live-stream capture and clipping tool. Use these tools to observe active captures, search chat and transcription data, look up channels, and create clip regions for export.'
	}
);

// ---------------------------------------------------------------------------
// Tool 1 — list_streams
// ---------------------------------------------------------------------------

mcpServer.tool(
	'list_streams',
	'List all active and stopped streams with their status and metadata. Includes a count of clip regions per stream (use list_clips to see full clip details).',
	{},
	async () => {
		const streams = listStreams();
		const clipRegions = getAllClipRegions();
		// Count clips per stream instead of returning full clip data
		const clipCountsByStream: Record<string, number> = {};
		for (const r of clipRegions) {
			clipCountsByStream[r.streamId] = (clipCountsByStream[r.streamId] || 0) + 1;
		}
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ streams, clipCounts: clipCountsByStream, totalClips: clipRegions.length })
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 2 — list_clips
// ---------------------------------------------------------------------------

mcpServer.tool(
	'list_clips',
	'List clip regions, optionally filtered by stream ID, channel name, and/or a datetime range. Times are ISO 8601 datetime strings (e.g. "2026-02-20T14:30:00Z").',
	{
		streamId: z.string().optional().describe('Filter clips to a specific stream ID'),
		channel: z.string().optional().describe('Filter clips to a specific channel name (case-insensitive)'),
		after: z.string().optional().describe('Only include clips that end after this datetime (ISO 8601, e.g. "2026-02-20T14:30:00Z")'),
		before: z.string().optional().describe('Only include clips that start before this datetime (ISO 8601, e.g. "2026-02-21T02:00:00Z")')
	},
	async ({ streamId, channel, after, before }) => {
		let clips = getAllClipRegions();

		if (streamId) {
			clips = clips.filter((c) => c.streamId === streamId);
		}
		if (channel) {
			const lowerChannel = channel.toLowerCase();
			clips = clips.filter((c) => {
				const stream = getStream(c.streamId);
				return stream?.channel.toLowerCase() === lowerChannel;
			});
		}

		// Parse datetime filters to epoch seconds for comparison against master time
		let afterEpoch: number | null = null;
		let beforeEpoch: number | null = null;
		if (after) {
			afterEpoch = new Date(after).getTime() / 1000;
			if (isNaN(afterEpoch)) {
				return { isError: true, content: [{ type: 'text' as const, text: `Invalid "after" datetime: "${after}". Use ISO 8601 format.` }] };
			}
		}
		if (before) {
			beforeEpoch = new Date(before).getTime() / 1000;
			if (isNaN(beforeEpoch)) {
				return { isError: true, content: [{ type: 'text' as const, text: `Invalid "before" datetime: "${before}". Use ISO 8601 format.` }] };
			}
		}
		if (afterEpoch !== null) clips = clips.filter((c) => c.endTime > afterEpoch);
		if (beforeEpoch !== null) clips = clips.filter((c) => c.startTime < beforeEpoch);

		// Sort by start time ascending
		clips.sort((a, b) => a.startTime - b.startTime);

		// Enrich with channel name and readable times
		const enriched = clips.map((c) => {
			const stream = getStream(c.streamId);
			return {
				...c,
				channel: stream?.channel ?? null,
				startTimeISO: new Date(c.startTime * 1000).toISOString(),
				endTimeISO: new Date(c.endTime * 1000).toISOString(),
				durationSeconds: Math.round(c.endTime - c.startTime)
			};
		});

		return {
			content: [{
				type: 'text' as const,
				text: JSON.stringify({ count: enriched.length, clips: enriched })
			}]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 3 — search_chat
// ---------------------------------------------------------------------------

mcpServer.tool(
	'search_chat',
	'Search chat messages in a time range across one or multiple streams. Times are in stream-local seconds (seconds since capture started). Supports optional text filtering (substring or regex) and pagination.',
	{
		ranges: z
			.array(
				z.object({
					streamId: z.string().describe('The stream ID to search'),
					from: z.number().describe('Start of range in stream-local seconds'),
					to: z.number().describe('End of range in stream-local seconds')
				})
			)
			.min(1)
			.describe('Time ranges to query (one per stream)'),
		query: z.string().optional().describe('Text filter — only return messages matching this string. Substring match by default, or regex if useRegex is true.'),
		useRegex: z.boolean().optional().default(false).describe('Treat query as a regular expression (case-insensitive)'),
		limit: z.number().optional().describe('Maximum number of results to return'),
		offset: z.number().optional().default(0).describe('Number of results to skip (for pagination)')
	},
	async ({ ranges, query, useRegex, limit, offset }) => {
		let regex: RegExp | null = null;
		if (query && useRegex) {
			try {
				regex = new RegExp(query, 'i');
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` }]
				};
			}
		}

		const singleStream = new Set(ranges.map((r) => r.streamId)).size === 1;
		const results: Array<{ streamId: string; username: string; text: string; timestamp: number }> = [];
		for (const range of ranges) {
			const messages = getChatMessagesInRange(range.streamId, range.from, range.to, regex ? undefined : query);
			for (const m of messages) {
				if (regex && !regex.test(m.text)) continue;
				results.push({ streamId: range.streamId, username: m.username, text: m.text, timestamp: m.timestamp });
			}
		}
		results.sort((a, b) => a.timestamp - b.timestamp);
		const sliced = limit !== undefined ? results.slice(offset ?? 0, (offset ?? 0) + limit) : results.slice(offset ?? 0);

		const header = singleStream
			? `${ranges[0].streamId} | ${results.length} messages, returning ${sliced.length}`
			: `${results.length} messages, returning ${sliced.length}`;
		const lines = sliced.map((m) =>
			singleStream
				? `[${m.timestamp}] ${m.username}: ${m.text}`
				: `[${m.streamId}|${m.timestamp}] ${m.username}: ${m.text}`
		);
		return {
			content: [{ type: 'text' as const, text: header + '\n' + lines.join('\n') }]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 3 — search_transcriptions
// ---------------------------------------------------------------------------

mcpServer.tool(
	'search_transcriptions',
	'Search transcription segments in a time range across one or multiple streams. Times are in stream-local seconds. Supports optional text filtering (substring or regex) and pagination.',
	{
		ranges: z
			.array(
				z.object({
					streamId: z.string().describe('The stream ID to search'),
					from: z.number().describe('Start of range in stream-local seconds'),
					to: z.number().describe('End of range in stream-local seconds')
				})
			)
			.min(1)
			.describe('Time ranges to query (one per stream)'),
		query: z.string().optional().describe('Text filter — only return segments matching this string. Substring match by default, or regex if useRegex is true.'),
		useRegex: z.boolean().optional().default(false).describe('Treat query as a regular expression (case-insensitive)'),
		limit: z.number().optional().describe('Maximum number of results to return'),
		offset: z.number().optional().default(0).describe('Number of results to skip (for pagination)')
	},
	async ({ ranges, query, useRegex, limit, offset }) => {
		let regex: RegExp | null = null;
		if (query && useRegex) {
			try {
				regex = new RegExp(query, 'i');
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` }]
				};
			}
		}

		const singleStream = new Set(ranges.map((r) => r.streamId)).size === 1;
		const streamChannels = new Map<string, string>();
		const results: Array<{ streamId: string; text: string; startTime: number; endTime: number }> = [];
		for (const range of ranges) {
			if (!streamChannels.has(range.streamId)) {
				const s = getStream(range.streamId);
				if (s) streamChannels.set(range.streamId, s.channel);
			}
			const entries = getTranscriptionsInRange(range.streamId, range.from, range.to, regex ? undefined : query);
			for (const e of entries) {
				if (regex && !regex.test(e.text)) continue;
				results.push({ streamId: range.streamId, text: e.text, startTime: e.startTime, endTime: e.endTime });
			}
		}
		results.sort((a, b) => a.startTime - b.startTime);
		const sliced = limit !== undefined ? results.slice(offset ?? 0, (offset ?? 0) + limit) : results.slice(offset ?? 0);

		const header = singleStream
			? `${ranges[0].streamId} | ${results.length} segments, returning ${sliced.length}`
			: `${results.length} segments, returning ${sliced.length}`;
		const lines = sliced.map((e) => {
			const channel = streamChannels.get(e.streamId) ?? e.streamId;
			return singleStream
				? `[${e.startTime}-${e.endTime}] ${channel}: ${e.text}`
				: `[${e.streamId}|${e.startTime}-${e.endTime}] ${channel}: ${e.text}`;
		});
		return {
			content: [{ type: 'text' as const, text: header + '\n' + lines.join('\n') }]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 4 — lookup_channel
// ---------------------------------------------------------------------------

mcpServer.tool(
	'lookup_channel',
	'Look up a channel to check if it is live, get its title, game, viewer count, and VOD availability.',
	{
		channel: z.string().describe('Channel login name or room ID'),
		platform: z
			.enum(['twitch', 'douyu'])
			.optional()
			.default('twitch')
			.describe('Platform (default: twitch)')
	},
	async ({ channel, platform }) => {
		try {
			const fetcher = platform === 'douyu' ? fetchDouyuChannel : fetchTwitchChannel;
			const info = await fetcher(channel);
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(info)
					}
				]
			};
		} catch (err) {
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Failed to look up channel "${channel}" on ${platform}: ${err instanceof Error ? err.message : String(err)}`
					}
				]
			};
		}
	}
);

// ---------------------------------------------------------------------------
// Tool 5 — get_channel_vods
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_channel_vods',
	'List past VODs (archives) for a Twitch channel.',
	{
		login: z.string().describe('Twitch channel login name'),
		first: z.number().optional().default(20).describe('Number of VODs to return (max 100)'),
		after: z.string().optional().describe('Pagination cursor from a previous response')
	},
	async ({ login, first, after }) => {
		const clampedFirst = Math.min(Math.max(first, 1), 100);
		try {
			const variables: Record<string, unknown> = { login, first: clampedFirst, type: 'ARCHIVE' };
			if (after) variables.after = after;

			const data = await twitchGql<{
				errors?: unknown[];
				data?: {
					user?: {
						videos?: {
							edges: VideoEdge[];
							pageInfo?: { hasNextPage?: boolean };
						};
					};
				};
			}>(CHANNEL_VODS_GQL, variables);

			if (data.errors) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Twitch GQL errors: ${JSON.stringify(data.errors)}` }]
				};
			}

			const connection = data?.data?.user?.videos;
			if (!connection) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ vods: [], cursor: null, hasNextPage: false }) }]
				};
			}

			const edges: VideoEdge[] = connection.edges ?? [];
			const lastCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
			const hasNextPage = connection.pageInfo?.hasNextPage ?? false;
			const vods = mapVideoEdges(edges);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ vods, cursor: lastCursor, hasNextPage })
					}
				]
			};
		} catch (err) {
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Failed to fetch VODs for "${login}": ${err instanceof Error ? err.message : String(err)}`
					}
				]
			};
		}
	}
);

// ---------------------------------------------------------------------------
// Tool 6 — get_watchlist
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_watchlist',
	'Get the current watchlist of monitored channels.',
	{},
	async () => {
		const watchlist = loadWatchlist();
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ watchlist })
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 7 — get_channel_settings
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_channel_settings',
	'Get per-channel transcription language settings.',
	{},
	async () => {
		const settings = loadAllChannelSettings();
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ settings })
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 8 — query_at_time
// ---------------------------------------------------------------------------

mcpServer.tool(
	'query_at_time',
	'Query a stream at a specific timestamp. Returns stream details and a window of all chat messages and transcription segments centered on the given timestamp.',
	{
		streamId: z.string().describe('The stream ID to query'),
		timestamp: z.number().describe('The timestamp in stream-local seconds to center the window on'),
		windowSeconds: z.number().optional().default(30).describe('Total window size in seconds (default 30, centered on timestamp)')
	},
	async ({ streamId, timestamp, windowSeconds }) => {
		const stream = getStream(streamId);
		if (!stream) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
			};
		}

		const half = (windowSeconds ?? 30) / 2;
		const windowStart = Math.max(0, timestamp - half);
		const windowEnd = timestamp + half;

		const chat = getChatMessagesInRange(streamId, windowStart, windowEnd);
		const transcriptions = getTranscriptionsInRange(streamId, windowStart, windowEnd);

		// Sample chat: at most 10 messages per 1-second bucket
		const MAX_PER_SECOND = 10;
		const totalChat = chat.length;
		const buckets = new Map<number, typeof chat>();
		for (const m of chat) {
			const key = Math.floor(m.timestamp);
			let bucket = buckets.get(key);
			if (!bucket) { bucket = []; buckets.set(key, bucket); }
			bucket.push(m);
		}
		const sampled: typeof chat = [];
		for (const [, bucket] of buckets) {
			if (bucket.length <= MAX_PER_SECOND) {
				sampled.push(...bucket);
			} else {
				// Fisher-Yates partial shuffle to pick MAX_PER_SECOND random items
				for (let i = bucket.length - 1; i > bucket.length - 1 - MAX_PER_SECOND; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[bucket[i], bucket[j]] = [bucket[j], bucket[i]];
				}
				sampled.push(...bucket.slice(bucket.length - MAX_PER_SECOND));
			}
		}
		sampled.sort((a, b) => a.timestamp - b.timestamp);

		const chatLines = sampled.map((m) => `[${m.timestamp}] ${m.username}: ${m.text}`);
		const transcriptLines = transcriptions.map((t) => `[${t.startTime}-${t.endTime}] ${stream.channel}: ${t.text}`);

		const note = sampled.length < totalChat
			? `Too many messages to display. Showing ${sampled.length}/${totalChat} randomly sampled messages.`
			: undefined;

		const parts = [
			JSON.stringify({ stream, timestamp, windowStart, windowEnd, ...(note && { note }) }),
			'',
			'--- chat ---',
			...chatLines,
			'',
			'--- transcription ---',
			...transcriptLines
		];
		return {
			content: [{ type: 'text' as const, text: parts.join('\n') }]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 9 — create_clip  (mutating)
// ---------------------------------------------------------------------------

mcpServer.tool(
	'create_clip',
	'Create a clip region on a stream. Defines a time range that can later be exported as video. Times default to master time (epoch seconds) but can be stream-local seconds if timeFormat is set to "local".',
	{
		id: z.string().describe('Unique clip ID (use a UUID)'),
		streamId: z.string().describe('The stream ID this clip belongs to'),
		startTime: z.number().describe('Clip start time'),
		endTime: z.number().describe('Clip end time'),
		timeFormat: z.enum(['master', 'local']).optional().default('master').describe('Time format: "master" for epoch seconds (default), "local" for stream-local seconds since capture start'),
		title: z.string().optional().describe('Short clip title/label'),
		notes: z.string().optional().describe('Longer notes explaining why this was clipped')
	},
	async ({ id, streamId, startTime, endTime, timeFormat, title, notes }) => {
		// Verify stream exists
		const stream = getStream(streamId);
		if (!stream) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
			};
		}

		// Convert local time to master time if needed
		let masterStart = startTime;
		let masterEnd = endTime;
		if (timeFormat === 'local') {
			const anchor = stream.startedAt / 1000;
			masterStart = anchor + startTime;
			masterEnd = anchor + endTime;
		}

		try {
			addClipRegion({ id, streamId, startTime: masterStart, endTime: masterEnd, createdBy: 'ai', title, notes });
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								success: true,
								clip: { id, streamId, startTime: masterStart, endTime: masterEnd, createdBy: 'ai', title, notes },
								message: `Clip created: ${masterEnd - masterStart}s region on stream "${stream.channel}".`
							})
					}
				]
			};
		} catch (err) {
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Failed to create clip: ${err instanceof Error ? err.message : String(err)}`
					}
				]
			};
		}
	}
);

// ---------------------------------------------------------------------------
// Tool 10 — update_clip  (mutating)
// ---------------------------------------------------------------------------

mcpServer.tool(
	'update_clip',
	'Update an existing clip region. Can change start/end times, title, and/or notes. Only provided fields are updated; omitted fields keep their current values.',
	{
		id: z.string().describe('The clip ID to update'),
		startTime: z.number().optional().describe('New start time (epoch seconds by default, or stream-local if timeFormat is "local")'),
		endTime: z.number().optional().describe('New end time (epoch seconds by default, or stream-local if timeFormat is "local")'),
		timeFormat: z.enum(['master', 'local']).optional().default('master').describe('Time format: "master" for epoch seconds (default), "local" for stream-local seconds since capture start'),
		title: z.string().optional().describe('New clip title'),
		notes: z.string().optional().describe('New clip notes')
	},
	async ({ id, startTime, endTime, timeFormat, title, notes }) => {
		const existing = getAllClipRegions().find((c) => c.id === id);
		if (!existing) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Clip "${id}" not found.` }]
			};
		}

		let newStart = startTime ?? existing.startTime;
		let newEnd = endTime ?? existing.endTime;

		if (timeFormat === 'local' && (startTime !== undefined || endTime !== undefined)) {
			const stream = getStream(existing.streamId);
			if (!stream) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Stream "${existing.streamId}" not found.` }]
				};
			}
			const anchor = stream.startedAt / 1000;
			if (startTime !== undefined) newStart = anchor + startTime;
			if (endTime !== undefined) newEnd = anchor + endTime;
		}

		try {
			addClipRegion({
				...existing,
				startTime: newStart,
				endTime: newEnd,
				...(title !== undefined && { title }),
				...(notes !== undefined && { notes })
			});
			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						success: true,
						clip: { id, streamId: existing.streamId, startTime: newStart, endTime: newEnd, title: title ?? existing.title, notes: notes ?? existing.notes },
						message: `Clip updated: ${newEnd - newStart}s region.`
					})
				}]
			};
		} catch (err) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Failed to update clip: ${err instanceof Error ? err.message : String(err)}` }]
			};
		}
	}
);

// ---------------------------------------------------------------------------
// Tool 11 — get_clips
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_clips',
	'Get the full details of one or more clips by ID. Accepts a single clip ID string or an array of clip ID strings.',
	{
		id: z.union([z.string(), z.array(z.string())]).describe('A single clip ID or an array of clip IDs to look up')
	},
	async ({ id }) => {
		const ids = Array.isArray(id) ? id : [id];
		const allClips = getAllClipRegions();
		const found = [];
		const notFound = [];

		for (const clipId of ids) {
			const clip = allClips.find((c) => c.id === clipId);
			if (clip) {
				const stream = getStream(clip.streamId);
				found.push({
					...clip,
					channel: stream?.channel ?? null,
					startTimeISO: new Date(clip.startTime * 1000).toISOString(),
					endTimeISO: new Date(clip.endTime * 1000).toISOString(),
					durationSeconds: Math.round(clip.endTime - clip.startTime)
				});
			} else {
				notFound.push(clipId);
			}
		}

		return {
			content: [{
				type: 'text' as const,
				text: JSON.stringify({
					count: found.length,
					clips: found,
					...(notFound.length > 0 && { notFound })
				})
			}]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 12 — get_chat_hotspots
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_chat_hotspots',
	'Find the most active chat moments in a stream. Returns the top N time windows ranked by message density, useful for finding hype moments, fails, or big reactions.',
	{
		streamId: z.string().describe('The stream ID to analyze'),
		bucketSeconds: z.number().optional().default(30).describe('Size of each time bucket in seconds (default 30)'),
		topN: z.number().optional().default(10).describe('Number of top hotspots to return (default 10)')
	},
	async ({ streamId, bucketSeconds, topN }) => {
		const stream = getStream(streamId);
		if (!stream) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
			};
		}

		const heatmap = getChatHeatmap(streamId, bucketSeconds ?? 30);
		const sorted = [...heatmap.buckets].sort((a, b) => b.count - a.count);
		const top = sorted.slice(0, topN ?? 10);

		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							streamId,
							channel: stream.channel,
							bucketSeconds: bucketSeconds ?? 30,
							totalBuckets: heatmap.buckets.length,
							peakMessagesPerBucket: heatmap.max,
							hotspots: top.map((h) => ({
								timeLocal: h.time,
								messageCount: h.count
							}))
						})
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 11 — retranscribe  (mutating)
// ---------------------------------------------------------------------------

mcpServer.tool(
	'retranscribe',
	'Re-run transcription on a stopped stream. Clears existing transcriptions and processes all audio again. Only works on streams with status "stopped".',
	{
		streamId: z.string().describe('The stream ID to retranscribe')
	},
	async ({ streamId }) => {
		const stream = getStream(streamId);
		if (!stream) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
			};
		}

		const success = retranscribeStream(streamId);
		if (!success) {
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Cannot retranscribe stream "${streamId}": stream must be in "stopped" status (current: "${stream.status}").`
					}
				]
			};
		}

		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							success: true,
							message: `Retranscription started for stream "${stream.channel}" (${streamId}).`
						})
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 12 — get_word_timestamps
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_word_timestamps',
	'Get word-level timestamps for a transcription segment. Returns an array of words with their precise start/end times (in stream-local seconds). Use the transcription ID from search_transcriptions results.',
	{
		transcriptionId: z.number().describe('The transcription segment ID (from search_transcriptions)')
	},
	async ({ transcriptionId }) => {
		const words = loadWordTimestamps(transcriptionId);
		if (words.length === 0) {
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ transcriptionId, words: [], message: 'No word timestamps found for this transcription.' })
					}
				]
			};
		}
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ transcriptionId, wordCount: words.length, words })
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 13 — export_video  (mutating)
// ---------------------------------------------------------------------------

mcpServer.tool(
	'export_video',
	'Export a video from one or more clips, stitched in the specified order. Returns immediately with an export ID — the encode runs in the background. Use list_exports to check status.',
	{
		clipIds: z.array(z.string()).min(1).describe('Ordered list of clip IDs to include in the export'),
		title: z.string().describe('Title for the exported video (used as filename)'),
		description: z.string().optional().describe('Optional description of the export'),
		chronological: z.boolean().optional().default(false).describe('If true, automatically sort clips by start time instead of using the provided order')
	},
	async ({ clipIds, title, description, chronological }) => {
		try {
			let finalClipIds = clipIds;
			if (chronological) {
				const allClips = getAllClipRegions();
				const clipMap = new Map(allClips.map((c) => [c.id, c]));
				finalClipIds = [...clipIds].sort((a, b) => {
					const ca = clipMap.get(a);
					const cb = clipMap.get(b);
					if (!ca || !cb) return 0;
					return ca.startTime - cb.startTime;
				});
			}
			const record = createAndQueueExport(finalClipIds, title, description);
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({
							success: true,
							exportId: record.id,
							message: `Export "${title}" queued with ${finalClipIds.length} clip(s)${chronological ? ' (sorted chronologically)' : ''}. Use list_exports to check status.`
						})
					}
				]
			};
		} catch (err) {
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Failed to queue export: ${err instanceof Error ? err.message : String(err)}`
					}
				]
			};
		}
	}
);

// ---------------------------------------------------------------------------
// Tool 14 — list_exports
// ---------------------------------------------------------------------------

mcpServer.tool(
	'list_exports',
	'List all video exports with their status (pending, exporting, ready, error). Most recent first.',
	{},
	async () => {
		const exports = smLoadAllExports();
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ count: exports.length, exports })
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 15 — get_export
// ---------------------------------------------------------------------------

mcpServer.tool(
	'get_export',
	'Get the status and details of a specific video export by ID.',
	{
		exportId: z.string().describe('The export ID to look up')
	},
	async ({ exportId }) => {
		const record = smLoadExport(exportId);
		if (!record) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Export "${exportId}" not found.` }]
			};
		}
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(record)
				}
			]
		};
	}
);

return mcpServer;

} // end createMcpServer
