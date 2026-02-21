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
	retranscribeStream
} from './streamManager.js';

import {
	loadAllChannelSettings,
	loadWatchlist
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
// Server instance
// ---------------------------------------------------------------------------

export const mcpServer = new McpServer(
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
					text: JSON.stringify({ streams, clipRegions }, null, 2)
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
	'Search chat messages in a time range across one or multiple streams. Times are in stream-local seconds (seconds since capture started).',
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
			.describe('Time ranges to query (one per stream)')
	},
	async ({ ranges }) => {
		const results: Array<{ streamId: string; username: string; text: string; timestamp: number; color?: string | null }> = [];
		for (const range of ranges) {
			const messages = getChatMessagesInRange(range.streamId, range.from, range.to);
			for (const m of messages) {
				results.push({ streamId: range.streamId, ...m });
			}
		}
		results.sort((a, b) => a.timestamp - b.timestamp);
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ count: results.length, messages: results }, null, 2)
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 3 — search_transcriptions
// ---------------------------------------------------------------------------

mcpServer.tool(
	'search_transcriptions',
	'Search transcription segments in a time range across one or multiple streams. Times are in stream-local seconds.',
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
			.describe('Time ranges to query (one per stream)')
	},
	async ({ ranges }) => {
		const results: Array<{ streamId: string; text: string; startTime: number; endTime: number }> = [];
		for (const range of ranges) {
			const entries = getTranscriptionsInRange(range.streamId, range.from, range.to);
			for (const e of entries) {
				results.push({ streamId: range.streamId, ...e });
			}
		}
		results.sort((a, b) => a.startTime - b.startTime);
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ count: results.length, transcriptions: results }, null, 2)
				}
			]
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
						text: JSON.stringify(info, null, 2)
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
					content: [{ type: 'text' as const, text: JSON.stringify({ vods: [], cursor: null, hasNextPage: false }, null, 2) }]
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
						text: JSON.stringify({ vods, cursor: lastCursor, hasNextPage }, null, 2)
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
					text: JSON.stringify({ watchlist }, null, 2)
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
					text: JSON.stringify({ settings }, null, 2)
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
	'Query a stream at a specific timestamp. Returns stream details and a 30-second window (±15s) of all chat messages and transcription segments centered on the given timestamp.',
	{
		streamId: z.string().describe('The stream ID to query'),
		timestamp: z.number().describe('The timestamp in stream-local seconds to center the window on')
	},
	async ({ streamId, timestamp }) => {
		const stream = getStream(streamId);
		if (!stream) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
			};
		}

		const windowStart = Math.max(0, timestamp - 15);
		const windowEnd = timestamp + 15;

		const chat = getChatMessagesInRange(streamId, windowStart, windowEnd);
		const transcriptions = getTranscriptionsInRange(streamId, windowStart, windowEnd);

		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							stream,
							timestamp,
							windowStart,
							windowEnd,
							chat: chat.map((m) => ({
								username: m.username,
								text: m.text,
								timestamp: m.timestamp,
								color: m.color
							})),
							transcriptions: transcriptions.map((t) => ({
								text: t.text,
								startTime: t.startTime,
								endTime: t.endTime
							}))
						},
						null,
						2
					)
				}
			]
		};
	}
);

// ---------------------------------------------------------------------------
// Tool 9 — create_clip  (mutating)
// ---------------------------------------------------------------------------

mcpServer.tool(
	'create_clip',
	'Create a clip region on a stream. Defines a time range that can later be exported as video. Times are in master time (epoch seconds).',
	{
		id: z.string().describe('Unique clip ID (use a UUID)'),
		streamId: z.string().describe('The stream ID this clip belongs to'),
		startTime: z.number().describe('Clip start time in epoch seconds (master time)'),
		endTime: z.number().describe('Clip end time in epoch seconds (master time)')
	},
	async ({ id, streamId, startTime, endTime }) => {
		// Verify stream exists
		const stream = getStream(streamId);
		if (!stream) {
			return {
				isError: true,
				content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
			};
		}

		try {
			addClipRegion({ id, streamId, startTime, endTime });
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								success: true,
								clip: { id, streamId, startTime, endTime },
								message: `Clip created: ${endTime - startTime}s region on stream "${stream.channel}".`
							},
							null,
							2
						)
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
// Tool 10 — retranscribe  (mutating)
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
						},
						null,
						2
					)
				}
			]
		};
	}
);
