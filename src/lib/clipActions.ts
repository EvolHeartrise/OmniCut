import { clipRegions, saveClipRegion, deleteClipRegion } from './stores/streams.js';
import type { ClipRegion } from './types.js';

/**
 * Split a clip region at the given master time into two halves.
 * Updates the store and persists to the server.
 * Returns the two new regions, or null if the split time is out of range.
 */
export function splitClipRegion(
	clip: ClipRegion,
	splitTime: number
): { firstHalf: ClipRegion; secondHalf: ClipRegion } | null {
	if (splitTime <= clip.startTime || splitTime >= clip.endTime) return null;

	const firstHalf: ClipRegion = {
		id: crypto.randomUUID(),
		streamId: clip.streamId,
		startTime: clip.startTime,
		endTime: splitTime
	};
	const secondHalf: ClipRegion = {
		id: crypto.randomUUID(),
		streamId: clip.streamId,
		startTime: splitTime,
		endTime: clip.endTime
	};

	clipRegions.update((regions) => [...regions.filter((r) => r.id !== clip.id), firstHalf, secondHalf]);
	deleteClipRegion(clip.id);
	saveClipRegion(firstHalf);
	saveClipRegion(secondHalf);

	return { firstHalf, secondHalf };
}

/**
 * Remove a clip region from the store and persist deletion to the server.
 */
export function removeClipRegionAction(clip: ClipRegion): void {
	clipRegions.update((regions) => regions.filter((r) => r.id !== clip.id));
	deleteClipRegion(clip.id);
}
