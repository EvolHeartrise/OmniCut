/**
 * MCP tools: create_video, get_videos, update_video, delete_video, get_exports
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult, jsonResult } from './types.js';
import {
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport,
	createVideo, updateVideo, deleteVideo, getVideo, getAllVideos
} from '../streamManager.js';

const verticalSlotSchema = z.object({
	type: z.enum(['full', 'camera', 'custom']),
	cropX: z.number().min(0).max(1).optional(),
	cropY: z.number().min(0).max(1).optional(),
	cropW: z.number().min(0).max(1).optional(),
	cropH: z.number().min(0).max(1).optional()
});

const verticalLayoutSchema = z.object({
	top: verticalSlotSchema,
	bottom: verticalSlotSchema
}).optional().describe('Vertical (9:16) layout: top/bottom slot config. Each slot type: "full" (entire frame), "camera" (webcam bounds), or "custom" (user crop region).');

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
				.describe('"standard" (16:9) or "mobile_short" (9:16)'),
			verticalLayout: verticalLayoutSchema
		},
		async ({ clipIds, title, description, format, verticalLayout }) => {
			try {
				const clipEntries = clipIds.map((clipId) => ({ clipId }));
				const video = createVideo({ title, description, clipEntries, format, verticalLayout });
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
			format: z.enum(['standard', 'mobile_short']).optional(),
			verticalLayout: verticalLayoutSchema
		},
		async ({ id, title, description, clipIds, format, verticalLayout }) => {
			try {
				const updates: Parameters<typeof updateVideo>[1] = {};
				if (title !== undefined) updates.title = title;
				if (description !== undefined) updates.description = description;
				if (clipIds !== undefined) updates.clipEntries = clipIds.map((clipId) => ({ clipId }));
				if (format !== undefined) updates.format = format;
				if (verticalLayout !== undefined) updates.verticalLayout = verticalLayout;
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
