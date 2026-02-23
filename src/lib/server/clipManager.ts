/**
 * Clip region management module.
 * In-memory store of clip regions backed by SQLite persistence.
 * Triggers clip encoding on add/update and cancellation on remove.
 */

import type { ClipRegion } from './types.js';
import * as db from './persistence.js';
import { broadcastClipRegionsChanged } from './sseBroadcaster.js';
import { enqueueClipEncode, cancelClipEncode } from './clipEncoder.js';

// In-memory store of clip regions keyed by ID (hot cache; persisted to SQLite)
const clipRegionsStore = new Map<string, ClipRegion>();

/**
 * Restore clip regions from the database.
 * Loads all clips, including those whose streams have been deleted
 * (clips survive stream deletion).
 */
export function restoreClipRegions(): void {
	const savedClips = db.loadAllClipRegions();
	for (const region of savedClips) {
		clipRegionsStore.set(region.id, region);
	}
}

/**
 * Create a new clip region with a DB-generated auto-incrementing ID.
 * Returns the full region (including the new ID).
 */
export function createClipRegion(data: Omit<ClipRegion, 'id'>): ClipRegion {
	if (data.startTime >= data.endTime) {
		throw new Error(
			`Invalid clip region: startTime (${data.startTime}) must be less than endTime (${data.endTime})`
		);
	}

	const id = db.insertClipRegion(data);
	const region: ClipRegion = { id, ...data };
	clipRegionsStore.set(id, region);
	broadcastClipRegionsChanged(getAllClipRegions());
	enqueueClipEncode(id);
	return region;
}

/**
 * Add or update a clip region (upsert by ID).
 * Validates that startTime < endTime.
 * Triggers clip encoding (or re-encoding if times changed).
 */
export function addClipRegion(region: ClipRegion): void {
	if (region.startTime >= region.endTime) {
		throw new Error(
			`Invalid clip region: startTime (${region.startTime}) must be less than endTime (${region.endTime})`
		);
	}

	// Check if this is an update with changed times — invalidate and re-encode
	const existing = clipRegionsStore.get(region.id);
	const timesChanged =
		!existing ||
		existing.startTime !== region.startTime ||
		existing.endTime !== region.endTime ||
		existing.streamId !== region.streamId;

	clipRegionsStore.set(region.id, region);
	db.saveClipRegion(region);
	broadcastClipRegionsChanged(getAllClipRegions());

	if (timesChanged) {
		enqueueClipEncode(region.id);
	}
}

/**
 * Remove a clip region by ID.
 * Cancels any pending/active encode and deletes the encoded file.
 */
export function removeClipRegion(id: string): boolean {
	if (!clipRegionsStore.delete(id)) return false;
	db.deleteClipRegion(id);
	cancelClipEncode(id);
	broadcastClipRegionsChanged(getAllClipRegions());
	return true;
}

/**
 * Get a clip region by ID.
 */
export function getClipRegion(id: string): ClipRegion | undefined {
	return clipRegionsStore.get(id);
}

/**
 * Get all clip regions.
 */
export function getAllClipRegions(): ClipRegion[] {
	return Array.from(clipRegionsStore.values());
}

/**
 * Remove all clip regions for a given stream.
 * Cancels encoding for each removed clip.
 */
export function removeClipRegionsForStream(streamId: string): void {
	for (const [clipId, region] of clipRegionsStore) {
		if (region.streamId === streamId) {
			clipRegionsStore.delete(clipId);
			cancelClipEncode(clipId);
		}
	}
}

/**
 * Get the count of stored clip regions.
 */
export function getClipRegionCount(): number {
	return clipRegionsStore.size;
}
