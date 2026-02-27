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
	createClipRegion,
	getChatMessagesInRange,
	getTranscriptionsInRange,
	getChatHeatmap,
	retranscribeStream,
	createAndQueueExport,
	createAndQueueExportFromVideo,
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport,
	getStreamRecordingDir,
	createVideo,
	updateVideo,
	deleteVideo,
	getVideo,
	getAllVideos
} from './streamManager.js';

import { extractFrame, extractFrameCropped } from './hlsUtils.js';
import { loadWatchlist, loadWordTimestamps, saveCameraBounds, resolveCameraBounds } from './persistence.js';

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
				'OmniCut — live-stream capture and clipping tool. Observe streams, search chat/transcriptions, look up channels, create clips, and export video.'
		}
	);

	// ---------------------------------------------------------------------------
	// Tool 1 — list_streams
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'list_streams',
		'List all streams with status, metadata, and clip counts.',
		{},
		async () => {
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
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(streams)
					}
				]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool 2 — get_clips
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'get_clips',
		'Get clips by ID or filter. No arguments returns all.',
		{
			ids: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe('Clip ID or array of IDs'),
			streamId: z.string().optional(),
			channel: z.string().optional().describe('Filter by channel (case-insensitive)'),
			after: z
				.string()
				.optional()
				.describe('Clips ending after this ISO 8601 datetime'),
			before: z
				.string()
				.optional()
				.describe('Clips starting before this ISO 8601 datetime')
		},
		async ({ ids, streamId, channel, after, before }) => {
			const allClips = getAllClipRegions();

			// --- ID lookup mode ---
			if (ids !== undefined) {
				const idList = Array.isArray(ids) ? ids : [ids];
				const found = [];
				const notFound = [];
				for (const clipId of idList) {
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
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								count: found.length,
								clips: found,
								...(notFound.length > 0 && { notFound })
							})
						}
					]
				};
			}

			// --- Filter mode ---
			let clips = allClips;

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

			let afterEpoch: number | null = null;
			let beforeEpoch: number | null = null;
			if (after) {
				afterEpoch = new Date(after).getTime() / 1000;
				if (isNaN(afterEpoch)) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: `Invalid "after" datetime: "${after}". Use ISO 8601 format.` }]
					};
				}
			}
			if (before) {
				beforeEpoch = new Date(before).getTime() / 1000;
				if (isNaN(beforeEpoch)) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: `Invalid "before" datetime: "${before}". Use ISO 8601 format.` }]
					};
				}
			}
			if (afterEpoch !== null) clips = clips.filter((c) => c.endTime > afterEpoch);
			if (beforeEpoch !== null) clips = clips.filter((c) => c.startTime < beforeEpoch);

			clips.sort((a, b) => a.startTime - b.startTime);

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
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ count: enriched.length, clips: enriched })
					}
				]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool 3 — search_stream
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'search_stream',
		'Search chat and/or transcription in a time range. Supports regex, badge filter, and pagination.',
		{
			type: z.enum(['chat', 'transcript', 'both']),
			ranges: z
				.array(
					z.object({
						streamId: z.string(),
						from: z.number().describe('Stream-local seconds'),
						to: z.number().describe('Stream-local seconds')
					})
				)
				.min(1)
				.describe('Time ranges to query'),
			query: z
				.string()
				.optional()
				.describe('Case-insensitive regex filter'),
			badges: z
				.array(z.string())
				.optional()
				.describe(
					'Filter by badges (chat only)'
				),
			limit: z.number().optional(),
			offset: z.number().optional().default(0)
		},
		async ({ type, ranges, query, badges, limit, offset }) => {
			// sqlite-regex uses Rust's regex crate which is case-sensitive by default.
			// Prepend (?i) to make the pattern case-insensitive, matching the old behaviour.
			let regexPattern: string | undefined;
			if (query) {
				try {
					// Validate the pattern by attempting to compile it
					new RegExp(query, 'i');
					regexPattern = `(?i)${query}`;
				} catch (err) {
					return {
						isError: true,
						content: [
							{ type: 'text' as const, text: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` }
						]
					};
				}
			}

			const singleStream = new Set(ranges.map((r) => r.streamId)).size === 1;
			const sections: string[] = [];

			// --- Chat ---
			if (type === 'chat' || type === 'both') {
				const badgeSet = badges && badges.length > 0 ? new Set(badges) : null;
				const results: Array<{ streamId: string; username: string; text: string; timestamp: number; badges?: string | null }> = [];
				for (const range of ranges) {
					const messages = getChatMessagesInRange(range.streamId, range.from, range.to, undefined, undefined, regexPattern);
					for (const m of messages) {
						if (badgeSet) {
							const msgBadges = m.badges ? m.badges.split(',') : [];
							if (!msgBadges.some((b) => badgeSet.has(b))) continue;
						}
						results.push({ streamId: range.streamId, username: m.username, text: m.text, timestamp: m.timestamp, badges: m.badges });
					}
				}
				results.sort((a, b) => a.timestamp - b.timestamp);
				const sliced =
					limit !== undefined ? results.slice(offset ?? 0, (offset ?? 0) + limit) : results.slice(offset ?? 0);

				const header = singleStream
					? `${ranges[0].streamId} | ${results.length} messages, returning ${sliced.length}`
					: `${results.length} messages, returning ${sliced.length}`;
				const lines = sliced.map((m) => {
					const t = +m.timestamp.toFixed(1);
					const badgePrefix = m.badges ? `[${m.badges}] ` : '';
					return singleStream
						? `[${t}] ${badgePrefix}${m.username}: ${m.text}`
						: `[${m.streamId}|${t}] ${badgePrefix}${m.username}: ${m.text}`;
				});
				sections.push('--- chat ---\n' + header + '\n' + lines.join('\n'));
			}

			// --- Transcript ---
			if (type === 'transcript' || type === 'both') {
				const streamChannels = new Map<string, string>();
				const results: Array<{ streamId: string; text: string; startTime: number; endTime: number }> = [];
				for (const range of ranges) {
					if (!streamChannels.has(range.streamId)) {
						const s = getStream(range.streamId);
						if (s) streamChannels.set(range.streamId, s.channel);
					}
					const entries = getTranscriptionsInRange(range.streamId, range.from, range.to, undefined, regexPattern);
					for (const e of entries) {
						results.push({ streamId: range.streamId, text: e.text, startTime: e.startTime, endTime: e.endTime });
					}
				}
				results.sort((a, b) => a.startTime - b.startTime);
				const sliced =
					limit !== undefined ? results.slice(offset ?? 0, (offset ?? 0) + limit) : results.slice(offset ?? 0);

				const header = singleStream
					? `${ranges[0].streamId} | ${results.length} segments, returning ${sliced.length}`
					: `${results.length} segments, returning ${sliced.length}`;
				const lines = sliced.map((e) => {
					const s = +e.startTime.toFixed(1);
					const end = +e.endTime.toFixed(1);
					const channel = streamChannels.get(e.streamId) ?? e.streamId;
					return singleStream
						? `[${s}-${end}] ${channel}: ${e.text}`
						: `[${e.streamId}|${s}-${end}] ${channel}: ${e.text}`;
				});
				sections.push('--- transcript ---\n' + header + '\n' + lines.join('\n'));
			}

			return {
				content: [{ type: 'text' as const, text: sections.join('\n\n') }]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool 4 — lookup_channel
	// ---------------------------------------------------------------------------

	mcpServer.tool(
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

	mcpServer.tool('get_watchlist', 'Get the current watchlist of monitored channels.', {}, async () => {
		const watchlist = loadWatchlist();
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ watchlist })
				}
			]
		};
	});

	// ---------------------------------------------------------------------------
	// Tool — query_at_time
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'query_at_time',
		'Get chat and transcription in a window centered on a timestamp.',
		{
			streamId: z.string(),
			timestamp: z.number().describe('Center timestamp (stream-local seconds)'),
			windowSeconds: z.number().optional().default(30)
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

			// Sample chat: at most 30 messages per 5-second bucket
			const MAX_PER_BUCKET = 30;
			const BUCKET_SECONDS = 5;
			const totalChat = chat.length;
			const buckets = new Map<number, typeof chat>();
			for (const m of chat) {
				const key = Math.floor(m.timestamp / BUCKET_SECONDS);
				let bucket = buckets.get(key);
				if (!bucket) {
					bucket = [];
					buckets.set(key, bucket);
				}
				bucket.push(m);
			}
			const sampled: typeof chat = [];
			for (const [, bucket] of buckets) {
				if (bucket.length <= MAX_PER_BUCKET) {
					sampled.push(...bucket);
				} else {
					// Always keep badged messages, fill remaining slots randomly
					const badged = bucket.filter((m) => m.badges);
					const unbadged = bucket.filter((m) => !m.badges);
					if (badged.length >= MAX_PER_BUCKET) {
						// More badged than slots — shuffle and take MAX_PER_BUCKET
						for (let i = badged.length - 1; i > 0; i--) {
							const j = Math.floor(Math.random() * (i + 1));
							[badged[i], badged[j]] = [badged[j], badged[i]];
						}
						sampled.push(...badged.slice(0, MAX_PER_BUCKET));
					} else {
						sampled.push(...badged);
						const remaining = MAX_PER_BUCKET - badged.length;
						// Fisher-Yates partial shuffle on unbadged to pick remaining random items
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

			const note =
				sampled.length < totalChat
					? `Too many messages to display. Showing ${sampled.length}/${totalChat} randomly sampled messages.`
					: undefined;

			const parts = [
				JSON.stringify({ channel: stream.channel, status: stream.status, durationSeconds: stream.durationSeconds, ...(note && { note }) }),
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
	// Tool — upsert_clip  (mutating, supports batch)
	// ---------------------------------------------------------------------------

	const clipSchema = z.object({
		id: z.string().optional(),
		streamId: z.string().optional().describe('Required for new clips'),
		startTime: z.number().optional(),
		endTime: z.number().optional(),
		timeFormat: z
			.enum(['master', 'local'])
			.optional()
			.default('master')
			.describe('"master" (epoch) or "local" (stream-relative)'),
		title: z.string().optional(),
		notes: z.string().optional()
	});

	type ClipInput = z.infer<typeof clipSchema>;

	function upsertOneClip(input: ClipInput): { ok: true; id: string; action: string; duration: number; channel: string } | { ok: false; error: string } {
		const { id, streamId, startTime, endTime, timeFormat, title, notes } = input;
		const existing = id ? getAllClipRegions().find((c) => c.id === id) : undefined;

		if (!id && !streamId) {
			return { ok: false, error: 'streamId is required when creating a new clip.' };
		}

		const resolvedStreamId = streamId ?? existing?.streamId;
		if (!resolvedStreamId) {
			return { ok: false, error: 'streamId is required when creating a new clip.' };
		}

		const stream = getStream(resolvedStreamId);
		if (!stream) {
			return { ok: false, error: `Stream "${resolvedStreamId}" not found.` };
		}

		if (!existing && (startTime === undefined || endTime === undefined)) {
			return { ok: false, error: 'startTime and endTime are required when creating a new clip.' };
		}

		let newStart = startTime ?? existing!.startTime;
		let newEnd = endTime ?? existing!.endTime;

		if (timeFormat === 'local' && (startTime !== undefined || endTime !== undefined)) {
			const anchor = stream.startedAt / 1000;
			if (startTime !== undefined) newStart = anchor + startTime;
			if (endTime !== undefined) newEnd = anchor + endTime;
		}

		const streamStartEpoch = stream.startedAt / 1000;
		const streamEndEpoch = stream.durationSeconds
			? streamStartEpoch + stream.durationSeconds
			: null;

		if (newStart < streamStartEpoch) {
			return { ok: false, error: `Clip startTime (${new Date(newStart * 1000).toISOString()}) is before stream start (${new Date(stream.startedAt).toISOString()}).` };
		}
		if (streamEndEpoch && newEnd > streamEndEpoch + 60) {
			return { ok: false, error: `Clip endTime (${new Date(newEnd * 1000).toISOString()}) is after stream end (${new Date(streamEndEpoch * 1000).toISOString()}).` };
		}

		const clipData = {
			streamId: resolvedStreamId,
			startTime: newStart,
			endTime: newEnd,
			createdBy: (existing?.createdBy ?? 'ai') as 'human' | 'ai',
			...(title !== undefined && { title }),
			...(notes !== undefined && { notes })
		};

		let resolvedId: string;
		if (existing) {
			resolvedId = existing.id;
			addClipRegion({ ...existing, ...clipData, id: resolvedId });
		} else {
			const created = createClipRegion(clipData);
			resolvedId = created.id;
		}

		return {
			ok: true,
			id: resolvedId,
			action: existing ? 'updated' : 'created',
			duration: Math.round(newEnd - newStart),
			channel: stream.channel
		};
	}

	mcpServer.tool(
		'upsert_clip',
		'Create or update a clip. Provide streamId+startTime+endTime to create; omit to update existing fields.',
		{
			clips: z.array(clipSchema).min(1)
		},
		async (params) => {
			const batch: ClipInput[] = params.clips;

			const results: string[] = [];
			let created = 0;
			let updated = 0;
			let errors = 0;

			for (let i = 0; i < batch.length; i++) {
				try {
					const result = upsertOneClip(batch[i]);
					if (result.ok === true) {
						if (result.action === 'created') created++;
						else updated++;
						results.push(`${result.action} ${result.id} (${result.duration}s on "${result.channel}")`);
					} else {
						errors++;
						results.push(`[${i}] error: ${result.error}`);
					}
				} catch (err) {
					errors++;
					results.push(`[${i}] error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			const summary = [
				created > 0 && `${created} created`,
				updated > 0 && `${updated} updated`,
				errors > 0 && `${errors} failed`
			].filter(Boolean).join(', ');

			return {
				isError: errors > 0 && created === 0 && updated === 0,
				content: [{
					type: 'text' as const,
					text: batch.length === 1
						? (errors > 0 ? results[0] : `Clip ${results[0]}`)
						: `${summary}\n${results.join('\n')}`
				}]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — set_camera_bounds  (mutating)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'set_camera_bounds',
		'Set webcam camera bounds for a channel at a specific timestamp. Bounds are stored per-channel and resolved by time when needed.',
		{
			channel: z.string().describe('Channel login (case-insensitive)'),
			timestamp: z.number().describe('Master time (epoch seconds) when these bounds apply'),
			camX: z.number().min(0).max(1).describe('Camera region left edge (normalized 0-1)'),
			camY: z.number().min(0).max(1).describe('Camera region top edge (normalized 0-1)'),
			camW: z.number().min(0).max(1).describe('Camera region width (normalized 0-1)'),
			camH: z.number().min(0).max(1).describe('Camera region height (normalized 0-1)')
		},
		async ({ channel, timestamp, camX, camY, camW, camH }) => {
			const entry = saveCameraBounds(channel, timestamp, camX, camY, camW, camH);
			return {
				content: [{
					type: 'text' as const,
					text: JSON.stringify({
						success: true,
						id: entry.id,
						channel: entry.channel,
						timestamp: entry.timestamp,
						message: `Camera bounds saved for "${entry.channel}" at ${new Date(timestamp * 1000).toISOString()}`
					})
				}]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — get_hotspots  (chat density)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
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
			if (notFound.length > 0) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Stream(s) not found: ${notFound.join(', ')}` }]
				};
			}

			const allBuckets: [string, string, number, number][] = [];

			for (const id of ids) {
				const stream = getStream(id)!;
				const heatmap = getChatHeatmap(id, chatBucket);
				let buckets = heatmap.buckets;
				if (from !== undefined) buckets = buckets.filter((b) => b.time >= from);
				if (to !== undefined) buckets = buckets.filter((b) => b.time < to);
				for (const b of buckets) {
					allBuckets.push([id, stream.channel, b.time, b.count]);
				}
			}

			allBuckets.sort((a, b) => b[3] - a[3]);

			const result = {
				streamIds: ids,
				bucketSeconds: chatBucket,
				totalBuckets: allBuckets.length,
				hotspots: allBuckets.slice(0, n)
			};

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result) }]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool 11 — retranscribe  (mutating)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'retranscribe',
		'Re-run transcription on a stopped stream (clears existing).',
		{
			streamId: z.string()
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
						text: JSON.stringify({
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
		'Get word-level timestamps for a transcription segment.',
		{
			transcriptionId: z.number()
		},
		async ({ transcriptionId }) => {
			const words = loadWordTimestamps(transcriptionId);
			if (words.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								transcriptionId,
								words: [],
								message: 'No word timestamps found for this transcription.'
							})
						}
					]
				};
			}
			const tuples = words.map((w) => [w.word, w.startTime, w.endTime]);
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ transcriptionId, wordCount: words.length, words: tuples })
					}
				]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — create_video  (mutating)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'create_video',
		'Create a video composition from clips. Returns the video record.',
		{
			clipIds: z.array(z.string()).min(1).describe('Ordered clip IDs for the video'),
			title: z.string().describe('Video title'),
			description: z.string().optional(),
			format: z
				.enum(['standard', 'mobile_short', 'chat_overlay'])
				.optional()
				.default('standard')
				.describe('"standard" (16:9), "mobile_short" (9:16), or "chat_overlay"')
		},
		async ({ clipIds, title, description, format }) => {
			try {
				const clipEntries = clipIds.map((clipId) => ({ clipId }));
				const video = createVideo({ title, description, clipEntries, format });
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							success: true,
							video,
							message: `Video "${title}" created with ${clipIds.length} clip(s).`
						})
					}]
				};
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Failed to create video: ${err instanceof Error ? err.message : String(err)}` }]
				};
			}
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — get_videos
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'get_videos',
		'Get video by ID, or list all if omitted.',
		{
			id: z.string().optional()
		},
		async ({ id }) => {
			if (id) {
				const video = getVideo(id);
				if (!video) {
					return { isError: true, content: [{ type: 'text' as const, text: `Video "${id}" not found.` }] };
				}
				return { content: [{ type: 'text' as const, text: JSON.stringify(video) }] };
			}
			const videos = getAllVideos();
			return { content: [{ type: 'text' as const, text: JSON.stringify({ count: videos.length, videos }) }] };
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — update_video  (mutating)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'update_video',
		'Update a video composition. Only provided fields are changed.',
		{
			id: z.string(),
			title: z.string().optional(),
			description: z.string().optional(),
			clipIds: z.array(z.string()).optional().describe('New ordered clip IDs (replaces all entries)'),
			format: z.enum(['standard', 'mobile_short', 'chat_overlay']).optional()
		},
		async ({ id, title, description, clipIds, format }) => {
			try {
				const updates: Parameters<typeof updateVideo>[1] = {};
				if (title !== undefined) updates.title = title;
				if (description !== undefined) updates.description = description;
				if (clipIds !== undefined) updates.clipEntries = clipIds.map((clipId) => ({ clipId }));
				if (format !== undefined) updates.format = format;
				const video = updateVideo(id, updates);
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ success: true, video }) }]
				};
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Failed to update video: ${err instanceof Error ? err.message : String(err)}` }]
				};
			}
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — delete_video  (mutating)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'delete_video',
		'Delete a video composition. Does not delete associated exports.',
		{
			id: z.string()
		},
		async ({ id }) => {
			const deleted = deleteVideo(id);
			if (!deleted) {
				return { isError: true, content: [{ type: 'text' as const, text: `Video "${id}" not found.` }] };
			}
			return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `Video "${id}" deleted.` }) }] };
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — export_video  (mutating)
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'export_video',
		'Export video from clips or a video composition. Returns export ID; runs in background.',
		{
			videoId: z.string().optional().describe('Video ID to export. If provided, clipIds/title/format are ignored.'),
			clipIds: z.array(z.string()).min(1).optional().describe('Clip IDs (legacy path). Creates a video and exports it.'),
			title: z.string().optional().describe('Used as filename (required if clipIds provided)'),
			description: z.string().optional(),
			chronological: z.boolean().optional().default(false),
			format: z
				.enum(['standard', 'mobile_short', 'chat_overlay'])
				.optional()
				.default('standard')
				.describe('"standard" (16:9) or "mobile_short" (9:16 vertical with gameplay + webcam) or "chat_overlay" (transparent WebM with chat panel)')
		},
		async ({ videoId, clipIds, title, description, chronological, format }) => {
			try {
				if (videoId) {
					// Export from existing video
					const record = createAndQueueExportFromVideo(videoId);
					return {
						content: [{
							type: 'text' as const,
							text: JSON.stringify({
								success: true,
								exportId: record.id,
								videoId,
								message: `Export queued from video "${record.title}". Use get_exports to check status.`
							})
						}]
					};
				}

				// Legacy path: clipIds required
				if (!clipIds || clipIds.length === 0) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: 'Either videoId or clipIds must be provided.' }]
					};
				}
				if (!title) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: 'title is required when using clipIds.' }]
					};
				}

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

				// Auto-create a video, then export it
				const clipEntries = finalClipIds.map((clipId) => ({ clipId }));
				const video = createVideo({ title, description, clipEntries, format });
				const record = createAndQueueExportFromVideo(video.id);
				const formatLabel = format === 'mobile_short' ? ' (9:16 vertical)' : format === 'chat_overlay' ? ' (transparent chat overlay)' : '';

				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							success: true,
							exportId: record.id,
							videoId: video.id,
							message: `Video + export "${title}" queued with ${finalClipIds.length} clip(s)${chronological ? ' (sorted chronologically)' : ''}${formatLabel}. Use get_exports to check status.`
						})
					}]
				};
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Failed to queue export: ${err instanceof Error ? err.message : String(err)}` }]
				};
			}
		}
	);

	// ---------------------------------------------------------------------------
	// Tool — get_exports
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'get_exports',
		'Get export by ID, or list all if omitted.',
		{
			id: z.string().optional()
		},
		async ({ id }) => {
			if (id) {
				const record = smLoadExport(id);
				if (!record) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: `Export "${id}" not found.` }]
					};
				}
				return {
					content: [{ type: 'text' as const, text: JSON.stringify(record) }]
				};
			}
			const exports = smLoadAllExports();
			return {
				content: [{ type: 'text' as const, text: JSON.stringify({ count: exports.length, exports }) }]
			};
		}
	);

	// ---------------------------------------------------------------------------
	// Tool 16 — get_screenshot
	// ---------------------------------------------------------------------------

	mcpServer.tool(
		'get_screenshot',
		'Capture a JPEG frame from a stream at a given timestamp. Use region "camera" to crop to the channel\'s webcam camera bounds (resolved from channel_camera_bounds table).',
		{
			streamId: z.string(),
			timestamp: z.number(),
			timeFormat: z
				.enum(['master', 'local'])
				.optional()
				.default('local')
				.describe('"local" (stream-relative, default) or "master" (epoch)'),
			region: z
				.enum(['full', 'camera'])
				.optional()
				.default('full')
				.describe('"full" (entire frame, default) or "camera" (crop to channel\'s webcam region)')
		},
		async ({ streamId, timestamp, timeFormat, region }) => {
			const stream = getStream(streamId);
			if (!stream) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `Stream "${streamId}" not found.` }]
				};
			}

			const recordingDir = getStreamRecordingDir(streamId);
			if (!recordingDir) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `No recording directory found for stream "${streamId}".` }]
				};
			}

			let localTs = timestamp;
			if (timeFormat === 'master') {
				localTs = timestamp - stream.startedAt / 1000 + stream.offset;
			}

			if (localTs < 0) {
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Timestamp resolves to ${localTs.toFixed(1)}s (before stream start). Provide a later timestamp.`
						}
					]
				};
			}

			// Resolve camera crop filter if requested
			let cropFilter: string | null = null;
			if (region === 'camera') {
				// Resolve bounds from channel table using stream's channel + timestamp
				const cam = resolveCameraBounds(stream.channel, timestamp);
				if (!cam) {
					return {
						isError: true,
						content: [{ type: 'text' as const, text: `No camera bounds set for channel "${stream.channel}". Use set_camera_bounds first.` }]
					};
				}
				// Build crop filter using normalized coords — ffmpeg crop uses iw/ih expressions
				cropFilter = `crop=iw*${cam.camW.toFixed(6)}:ih*${cam.camH.toFixed(6)}:iw*${cam.camX.toFixed(6)}:ih*${cam.camY.toFixed(6)}`;
			}

			try {
				const buffer = cropFilter
					? await extractFrameCropped(recordingDir, localTs, cropFilter)
					: await extractFrame(recordingDir, localTs);
				return {
					content: [
						{
							type: 'image' as const,
							data: buffer.toString('base64'),
							mimeType: 'image/jpeg'
						}
					]
				};
			} catch (err) {
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Failed to extract frame: ${err instanceof Error ? err.message : String(err)}`
						}
					]
				};
			}
		}
	);

	return mcpServer;
} // end createMcpServer
