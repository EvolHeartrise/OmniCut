/**
 * Video composition management module.
 * In-memory store of video compositions backed by SQLite persistence.
 */

import type { VideoRecord, ClipEntry } from '../types.js';
import { newVideoId } from '../ids.js';
import * as db from './persistence.js';
import { broadcastVideoCreate, broadcastVideoUpdate, broadcastVideoDelete } from './sseBroadcaster.js';
import { getClipRegion } from './clipManager.js';

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
	format?: VideoRecord['format'];
}): VideoRecord {
	// Validate all clip IDs exist
	const missing: string[] = [];
	for (const entry of data.clipEntries) {
		if (!getClipRegion(entry.clipId)) {
			missing.push(entry.clipId);
		}
	}
	if (missing.length > 0) {
		throw new Error(`Clip IDs not found: ${missing.join(', ')}`);
	}

	const now = Math.floor(Date.now() / 1000);
	const video: VideoRecord = {
		id: newVideoId(),
		title: data.title,
		...(data.description && { description: data.description }),
		clipEntries: data.clipEntries,
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
	updates: Partial<Pick<VideoRecord, 'title' | 'description' | 'clipEntries' | 'format'>>
): VideoRecord {
	const existing = videosStore.get(id);
	if (!existing) {
		throw new Error(`Video not found: ${id}`);
	}

	// Validate clip IDs if updating entries
	if (updates.clipEntries) {
		const missing: string[] = [];
		for (const entry of updates.clipEntries) {
			if (!getClipRegion(entry.clipId)) {
				missing.push(entry.clipId);
			}
		}
		if (missing.length > 0) {
			throw new Error(`Clip IDs not found: ${missing.join(', ')}`);
		}
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
