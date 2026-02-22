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
	retranscribeStream
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
	'List all active and stopped streams with their status, metadata, and clip regions.',
	{},
	async () => {
		const streams = listStreams();
		const clipRegions = getAllClipRegions();
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ streams, clipRegions })
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 2 — search_chat
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

		const chatLines = chat.map((m) => `[${m.timestamp}] ${m.username}: ${m.text}`);
		const transcriptLines = transcriptions.map((t) => `[${t.startTime}-${t.endTime}] ${stream.channel}: ${t.text}`);

		const parts = [
			JSON.stringify({ stream, timestamp, windowStart, windowEnd }),
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
// Tool 10 — get_chat_hotspots
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

return mcpServer;

} // end createMcpServer
