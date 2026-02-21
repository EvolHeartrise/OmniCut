/**
 * Clip region management module.
 * In-memory store of clip regions backed by SQLite persistence.
 */

import type { ClipRegion } from './types.js';
import * as db from './persistence.js';

// In-memory store of clip regions keyed by ID (hot cache; persisted to SQLite)
const clipRegionsStore = new Map<string, ClipRegion>();

/**
 * Restore clip regions from the database, filtering to only those
 * belonging to known stream IDs.
 */
export function restoreClipRegions(knownStreamIds: Set<string>): void {
	const savedClips = db.loadAllClipRegions();
	for (const region of savedClips) {
		if (knownStreamIds.has(region.streamId)) {
			clipRegionsStore.set(region.id, region);
		}
	}
}

/**
 * Add or update a clip region (upsert by ID).
 * Validates that startTime < endTime.
 */
export function addClipRegion(region: ClipRegion): void {
	if (region.startTime >= region.endTime) {
		throw new Error(`Invalid clip region: startTime (${region.startTime}) must be less than endTime (${region.endTime})`);
	}
	clipRegionsStore.set(region.id, region);
	db.saveClipRegion(region);
}

/**
 * Remove a clip region by ID.
 */
export function removeClipRegion(id: string): boolean {
	if (!clipRegionsStore.delete(id)) return false;
	db.deleteClipRegion(id);
	return true;
}

/**
 * Get all clip regions.
 */
export function getAllClipRegions(): ClipRegion[] {
	return Array.from(clipRegionsStore.values());
}

/**
 * Remove all clip regions for a given stream.
 */
export function removeClipRegionsForStream(streamId: string): void {
	for (const [clipId, region] of clipRegionsStore) {
		if (region.streamId === streamId) {
			clipRegionsStore.delete(clipId);
		}
	}
}

/**
 * Get the count of stored clip regions.
 */
export function getClipRegionCount(): number {
	return clipRegionsStore.size;
}
