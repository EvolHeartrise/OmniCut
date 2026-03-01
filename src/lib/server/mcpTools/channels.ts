/**
 * MCP tools: lookup_channel, get_channel_vods, get_watchlist
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult, jsonResult } from './types.js';
import { loadWatchlist } from '../db/index.js';
import {
	fetchTwitchChannel, fetchDouyuChannel,
	twitchGql, CHANNEL_VODS_GQL, mapVideoEdges, type VideoEdge
} from '../twitchApi.js';

export function registerChannelTools(server: ToolRegistrar): void {
	// --- lookup_channel ---
	server.tool(
		'lookup_channel',
		'Look up a channel\'s live status, title, game, and viewer count.',
		{
			channel: z.string().describe('Channel login or room ID'),
			platform: z.enum(['twitch', 'douyu']).optional().default('twitch')
		},
		async ({ channel, platform }) => {
			try {
				const fetcher = platform === 'douyu' ? fetchDouyuChannel : fetchTwitchChannel;
				const info = await fetcher(channel);
				return jsonResult(info);
			} catch (err) {
				return textResult(`Failed to look up channel "${channel}" on ${platform}: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	// --- get_channel_vods ---
	server.tool(
		'get_channel_vods',
		'List past VODs (archives) for a Twitch channel.',
		{
			login: z.string(),
			first: z.number().optional().default(20).describe('Number of VODs (max 100)'),
			after: z.string().optional().describe('Cursor for pagination')
		},
		async ({ login, first, after }) => {
			const clampedFirst = Math.min(Math.max(first, 1), 100);
			try {
				const variables: Record<string, unknown> = { login, first: clampedFirst, type: 'ARCHIVE' };
				if (after) variables.after = after;

				const data = await twitchGql<{
					errors?: unknown[];
					data?: { user?: { videos?: { edges: VideoEdge[]; pageInfo?: { hasNextPage?: boolean } } } };
				}>(CHANNEL_VODS_GQL, variables);

				if (data.errors) return textResult(`Twitch GQL errors: ${JSON.stringify(data.errors)}`, true);

				const connection = data?.data?.user?.videos;
				if (!connection) return jsonResult({ vods: [], cursor: null, hasNextPage: false });

				const edges: VideoEdge[] = connection.edges ?? [];
				const lastCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
				const hasNextPage = connection.pageInfo?.hasNextPage ?? false;
				const vods = mapVideoEdges(edges);

				return jsonResult({ vods, cursor: lastCursor, hasNextPage });
			} catch (err) {
				return textResult(`Failed to fetch VODs for "${login}": ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	// --- get_watchlist ---
	server.tool('get_watchlist', 'Get the current watchlist of monitored channels.', {}, async () => {
		return jsonResult({ watchlist: loadWatchlist() });
	});
}
