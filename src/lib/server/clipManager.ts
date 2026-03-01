/**
 * Clip region management module.
 * In-memory store of clip regions backed by SQLite persistence.
 */

import type { ClipRegion } from '../types.js';
import * as db from './db/index.js';
import { broadcastClipUpsert, broadcastClipDelete } from './sseBroadcaster.js';

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
	broadcastClipUpsert(region);
	return region;
}

/**
 * Add or update a clip region (upsert by ID).
 * Validates that startTime < endTime.
 */
export function addClipRegion(region: ClipRegion): void {
	if (region.startTime >= region.endTime) {
		throw new Error(
			`Invalid clip region: startTime (${region.startTime}) must be less than endTime (${region.endTime})`
		);
	}

	clipRegionsStore.set(region.id, region);
	db.saveClipRegion(region);
	broadcastClipUpsert(region);
}

/**
 * Remove a clip region by ID.
 */
export function removeClipRegion(id: string): boolean {
	if (!clipRegionsStore.delete(id)) return false;
	db.deleteClipRegion(id);
	broadcastClipDelete(id);
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
 * Get the count of stored clip regions.
 */
export function getClipRegionCount(): number {
	return clipRegionsStore.size;
}
