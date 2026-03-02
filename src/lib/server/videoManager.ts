/**
 * Video composition management module.
 * In-memory store of video compositions backed by SQLite persistence.
 */

import type { VideoRecord, ClipEntry, EffectEntry } from '../types.js';
import { newVideoId } from '../ids.js';
import * as db from './db/index.js';
import { broadcastVideoCreate, broadcastVideoUpdate, broadcastVideoDelete } from './sseBroadcaster.js';
import { validateClipIds } from './clipValidation.js';

// In-memory store of videos keyed by ID (hot cache; persisted to SQLite)
const videosStore = new Map<string, VideoRecord>();

/**
 * Restore videos from the database.
 */
export function restoreVideos(): void {
	const saved = db.loadAllVideos();
	for (const video of saved) {
		videosStore.set(video.id, video);
	}
}

/**
 * Create a new video composition.
 * Validates that all referenced clip IDs exist.
 */
export function createVideo(data: {
	title: string;
	description?: string;
	clipEntries: ClipEntry[];
	effectEntries?: EffectEntry[];
	format?: VideoRecord['format'];
}): VideoRecord {
	validateClipIds(data.clipEntries.map((e) => e.clipId));

	const now = Math.floor(Date.now() / 1000);
	const video: VideoRecord = {
		id: newVideoId(),
		title: data.title,
		...(data.description && { description: data.description }),
		clipEntries: data.clipEntries,
		...(data.effectEntries && data.effectEntries.length > 0 && { effectEntries: data.effectEntries }),
		format: data.format ?? 'standard',
		createdAt: now,
		updatedAt: now
	};

	db.saveVideo(video);
	videosStore.set(video.id, video);
	broadcastVideoCreate(video);
	return video;
}

/**
 * Update a video composition.
 * Validates clip IDs if clipEntries is provided.
 */
export function updateVideo(
	id: string,
	updates: Partial<Pick<VideoRecord, 'title' | 'description' | 'clipEntries' | 'effectEntries' | 'format'>>
): VideoRecord {
	const existing = videosStore.get(id);
	if (!existing) {
		throw new Error(`Video not found: ${id}`);
	}

	if (updates.clipEntries) {
		validateClipIds(updates.clipEntries.map((e) => e.clipId));
	}

	const updated: VideoRecord = {
		...existing,
		...updates,
		updatedAt: Math.floor(Date.now() / 1000)
	};

	db.updateVideoRecord(id, updates);
	// Re-read updatedAt from the record we built (DB uses unixepoch() which may differ by a second)
	videosStore.set(id, updated);
	broadcastVideoUpdate(updated);
	return updated;
}

/**
 * Delete a video composition.
 * Does NOT cascade-delete associated exports.
 */
export function deleteVideo(id: string): boolean {
	if (!videosStore.delete(id)) return false;
	db.deleteVideoRecord(id);
	broadcastVideoDelete(id);
	return true;
}

/**
 * Get a video by ID.
 */
export function getVideo(id: string): VideoRecord | undefined {
	return videosStore.get(id);
}

/**
 * Get all videos.
 */
export function getAllVideos(): VideoRecord[] {
	return Array.from(videosStore.values());
}
