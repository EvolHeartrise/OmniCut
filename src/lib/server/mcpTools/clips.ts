/**
 * MCP tools: get_clips, upsert_clip, set_camera_bounds
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult, jsonResult } from './types.js';
import { getStream, getAllClipRegions, addClipRegion, createClipRegion } from '../streamManager.js';
import { saveCameraBounds } from '../db/index.js';

export function registerClipTools(server: ToolRegistrar): void {
	// --- get_clips ---
	server.tool(
		'get_clips',
		'Get clips by ID or filter. No arguments returns all.',
		{
			ids: z.union([z.string(), z.array(z.string())]).optional().describe('Clip ID or array of IDs'),
			streamId: z.string().optional(),
			channel: z.string().optional().describe('Filter by channel (case-insensitive)'),
			after: z.string().optional().describe('Clips ending after this ISO 8601 datetime'),
			before: z.string().optional().describe('Clips starting before this ISO 8601 datetime')
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
				return jsonResult({ count: found.length, clips: found, ...(notFound.length > 0 && { notFound }) });
			}

			// --- Filter mode ---
			let clips = allClips;
			if (streamId) clips = clips.filter((c) => c.streamId === streamId);
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
				if (isNaN(afterEpoch)) return textResult(`Invalid "after" datetime: "${after}". Use ISO 8601 format.`, true);
			}
			if (before) {
				beforeEpoch = new Date(before).getTime() / 1000;
				if (isNaN(beforeEpoch)) return textResult(`Invalid "before" datetime: "${before}". Use ISO 8601 format.`, true);
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

			return jsonResult({ count: enriched.length, clips: enriched });
		}
	);

	// --- upsert_clip ---
	const clipSchema = z.object({
		id: z.string().optional(),
		streamId: z.string().optional().describe('Required for new clips'),
		startTime: z.number().optional(),
		endTime: z.number().optional(),
		timeFormat: z.enum(['master', 'local']).optional().default('master').describe('"master" (epoch) or "local" (stream-relative)'),
		title: z.string().optional(),
		notes: z.string().optional()
	});

	type ClipInput = z.infer<typeof clipSchema>;

	function upsertOneClip(input: ClipInput): { ok: true; id: string; action: string; duration: number; channel: string } | { ok: false; error: string } {
		const { id, streamId, startTime, endTime, timeFormat, title, notes } = input;
		const existing = id ? getAllClipRegions().find((c) => c.id === id) : undefined;

		if (!id && !streamId) return { ok: false, error: 'streamId is required when creating a new clip.' };

		const resolvedStreamId = streamId ?? existing?.streamId;
		if (!resolvedStreamId) return { ok: false, error: 'streamId is required when creating a new clip.' };

		const stream = getStream(resolvedStreamId);
		if (!stream) return { ok: false, error: `Stream "${resolvedStreamId}" not found.` };

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
		const streamEndEpoch = stream.durationSeconds ? streamStartEpoch + stream.durationSeconds : null;

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

		return { ok: true, id: resolvedId, action: existing ? 'updated' : 'created', duration: Math.round(newEnd - newStart), channel: stream.channel };
	}

	server.tool(
		'upsert_clip',
		'Create or update a clip. Provide streamId+startTime+endTime to create; omit to update existing fields.',
		{ clips: z.array(clipSchema).min(1) },
		async (params) => {
			const batch: ClipInput[] = params.clips;
			const results: string[] = [];
			let created = 0, updated = 0, errors = 0;

			for (let i = 0; i < batch.length; i++) {
				try {
					const result = upsertOneClip(batch[i]);
					if (result.ok === true) {
						if (result.action === 'created') created++; else updated++;
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

			const summary = [created > 0 && `${created} created`, updated > 0 && `${updated} updated`, errors > 0 && `${errors} failed`].filter(Boolean).join(', ');

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

	// --- set_camera_bounds ---
	server.tool(
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
			return jsonResult({
				success: true,
				id: entry.id,
				channel: entry.channel,
				timestamp: entry.timestamp,
				message: `Camera bounds saved for "${entry.channel}" at ${new Date(timestamp * 1000).toISOString()}`
			});
		}
	);
}
