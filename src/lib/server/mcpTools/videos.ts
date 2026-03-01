/**
 * MCP tools: create_video, get_videos, update_video, delete_video, export_video, get_exports
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult, jsonResult } from './types.js';
import {
	getAllClipRegions,
	createAndQueueExport,
	createAndQueueExportFromVideo,
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport,
	createVideo, updateVideo, deleteVideo, getVideo, getAllVideos
} from '../streamManager.js';

export function registerVideoTools(server: ToolRegistrar): void {
	// --- create_video ---
	server.tool(
		'create_video',
		'Create a video composition from clips. Returns the video record.',
		{
			clipIds: z.array(z.string()).min(1).describe('Ordered clip IDs for the video'),
			title: z.string().describe('Video title'),
			description: z.string().optional(),
			format: z.enum(['standard', 'mobile_short']).optional().default('standard')
				.describe('"standard" (16:9) or "mobile_short" (9:16)')
		},
		async ({ clipIds, title, description, format }) => {
			try {
				const clipEntries = clipIds.map((clipId) => ({ clipId }));
				const video = createVideo({ title, description, clipEntries, format });
				return jsonResult({ success: true, video, message: `Video "${title}" created with ${clipIds.length} clip(s).` });
			} catch (err) {
				return textResult(`Failed to create video: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	// --- get_videos ---
	server.tool(
		'get_videos',
		'Get video by ID, or list all if omitted.',
		{ id: z.string().optional() },
		async ({ id }) => {
			if (id) {
				const video = getVideo(id);
				if (!video) return textResult(`Video "${id}" not found.`, true);
				return jsonResult(video);
			}
			const videos = getAllVideos();
			return jsonResult({ count: videos.length, videos });
		}
	);

	// --- update_video ---
	server.tool(
		'update_video',
		'Update a video composition. Only provided fields are changed.',
		{
			id: z.string(),
			title: z.string().optional(),
			description: z.string().optional(),
			clipIds: z.array(z.string()).optional().describe('New ordered clip IDs (replaces all entries)'),
			format: z.enum(['standard', 'mobile_short']).optional()
		},
		async ({ id, title, description, clipIds, format }) => {
			try {
				const updates: Parameters<typeof updateVideo>[1] = {};
				if (title !== undefined) updates.title = title;
				if (description !== undefined) updates.description = description;
				if (clipIds !== undefined) updates.clipEntries = clipIds.map((clipId) => ({ clipId }));
				if (format !== undefined) updates.format = format;
				const video = updateVideo(id, updates);
				return jsonResult({ success: true, video });
			} catch (err) {
				return textResult(`Failed to update video: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	// --- delete_video ---
	server.tool(
		'delete_video',
		'Delete a video composition. Does not delete associated exports.',
		{ id: z.string() },
		async ({ id }) => {
			const deleted = deleteVideo(id);
			if (!deleted) return textResult(`Video "${id}" not found.`, true);
			return jsonResult({ success: true, message: `Video "${id}" deleted.` });
		}
	);

	// --- export_video ---
	server.tool(
		'export_video',
		'Export video from clips or a video composition. Returns export ID; runs in background.',
		{
			videoId: z.string().optional().describe('Video ID to export. If provided, clipIds/title/format are ignored.'),
			clipIds: z.array(z.string()).min(1).optional().describe('Clip IDs (legacy path). Creates a video and exports it.'),
			title: z.string().optional().describe('Used as filename (required if clipIds provided)'),
			description: z.string().optional(),
			chronological: z.boolean().optional().default(false),
			format: z.enum(['standard', 'mobile_short']).optional().default('standard')
				.describe('"standard" (16:9) or "mobile_short" (9:16 vertical with gameplay + webcam)')
		},
		async ({ videoId, clipIds, title, description, chronological, format }) => {
			try {
				if (videoId) {
					const record = createAndQueueExportFromVideo(videoId);
					return jsonResult({
						success: true,
						exportId: record.id,
						videoId,
						message: `Export queued from video "${record.title}". Use get_exports to check status.`
					});
				}

				if (!clipIds || clipIds.length === 0) return textResult('Either videoId or clipIds must be provided.', true);
				if (!title) return textResult('title is required when using clipIds.', true);

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

				const clipEntries = finalClipIds.map((clipId) => ({ clipId }));
				const video = createVideo({ title, description, clipEntries, format });
				const record = createAndQueueExportFromVideo(video.id);
				const formatLabel = format === 'mobile_short' ? ' (9:16 vertical)' : '';

				return jsonResult({
					success: true,
					exportId: record.id,
					videoId: video.id,
					message: `Video + export "${title}" queued with ${finalClipIds.length} clip(s)${chronological ? ' (sorted chronologically)' : ''}${formatLabel}. Use get_exports to check status.`
				});
			} catch (err) {
				return textResult(`Failed to queue export: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);

	// --- get_exports ---
	server.tool(
		'get_exports',
		'Get export by ID, or list all if omitted.',
		{ id: z.string().optional() },
		async ({ id }) => {
			if (id) {
				const record = smLoadExport(id);
				if (!record) return textResult(`Export "${id}" not found.`, true);
				return jsonResult(record);
			}
			const exports = smLoadAllExports();
			return jsonResult({ count: exports.length, exports });
		}
	);
}
