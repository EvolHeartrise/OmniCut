/**
 * MCP tools: search_stream
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult } from './types.js';
import { getStream, getChatMessagesInRange, getTranscriptionsInRange } from '../streamManager.js';

export function registerSearchTools(server: ToolRegistrar): void {
	server.tool(
		'search_stream',
		'Search chat and/or transcription in a time range. Supports regex, badge filter, and pagination.',
		{
			type: z.enum(['chat', 'transcript', 'both']),
			ranges: z.array(z.object({
				streamId: z.string(),
				from: z.number().describe('Stream-local seconds'),
				to: z.number().describe('Stream-local seconds')
			})).min(1).describe('Time ranges to query'),
			query: z.string().optional().describe('Case-insensitive regex filter'),
			badges: z.array(z.string()).optional().describe('Filter by badges (chat only)'),
			limit: z.number().optional(),
			offset: z.number().optional().default(0)
		},
		async ({ type, ranges, query, badges, limit, offset }) => {
			// sqlite-regex uses Rust's regex crate — prepend (?i) for case-insensitive
			let regexPattern: string | undefined;
			if (query) {
				try {
					new RegExp(query, 'i');
					regexPattern = `(?i)${query}`;
				} catch (err) {
					return textResult(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`, true);
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
				const sliced = limit !== undefined ? results.slice(offset ?? 0, (offset ?? 0) + limit) : results.slice(offset ?? 0);

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
				const sliced = limit !== undefined ? results.slice(offset ?? 0, (offset ?? 0) + limit) : results.slice(offset ?? 0);

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

			return textResult(sections.join('\n\n'));
		}
	);
}
