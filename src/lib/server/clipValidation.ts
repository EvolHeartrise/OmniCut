/**
 * Shared clip ID validation utility.
 * Used by exportQueue and videoManager to validate clip IDs before operations.
 */

import { getClipRegion } from './clipManager.js';

/**
 * Validate that all clip IDs exist. Returns the list of missing IDs.
 * Throws an error if any are missing.
 */
export function validateClipIds(clipIds: string[]): void {
	const missing: string[] = [];
	for (const clipId of clipIds) {
		if (!getClipRegion(clipId)) {
			missing.push(clipId);
		}
	}
	if (missing.length > 0) {
		throw new Error(`Clip IDs not found: ${missing.join(', ')}`);
	}
}
