/**
 * MCP tools: get_videos, update_video, delete_video, get_exports, create_export
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult, jsonResult } from './types.js';
import {
	loadAllExports as smLoadAllExports,
	loadExport as smLoadExport,
	updateVideo, deleteVideo, getVideo, getAllVideos
} from '../streamManager.js';
import { createAndQueueExportFromVideo } from '../exportQueue.js';

export function registerVideoTools(server: ToolRegistrar): void {
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
			clipIds: z.array(z.string()).optional().describe('New ordered clip IDs (replaces all entries)')
		},
		async ({ id, title, description, clipIds }) => {
			try {
				const updates: Parameters<typeof updateVideo>[1] = {};
				if (title !== undefined) updates.title = title;
				if (description !== undefined) updates.description = description;
				if (clipIds !== undefined) updates.clipEntries = clipIds.map((clipId) => ({ clipId }));
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

	// --- create_export ---
	server.tool(
		'create_export',
		'Export a video composition to an MP4 file. Queues the export and returns the export record with its ID.',
		{ videoId: z.string().describe('ID of the video to export') },
		async ({ videoId }) => {
			try {
				const record = createAndQueueExportFromVideo(videoId);
				return jsonResult({ success: true, exportId: record.id, status: record.status, message: `Export queued for video "${videoId}".` });
			} catch (err) {
				return textResult(`Failed to create export: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);
}
