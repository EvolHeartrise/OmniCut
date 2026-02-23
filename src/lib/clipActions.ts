import { clipRegions, createClipRegion, deleteClipRegion } from './stores/streams.js';
import type { ClipRegion } from './types.js';

/**
 * Split a clip region at the given master time into two halves.
 * Deletes the original and creates two new regions server-side.
 * Returns the two new regions (with server-generated IDs), or null if the split time is out of range.
 */
export async function splitClipRegion(
	clip: ClipRegion,
	splitTime: number
): Promise<{ firstHalf: ClipRegion; secondHalf: ClipRegion } | null> {
	if (splitTime <= clip.startTime || splitTime >= clip.endTime) return null;

	deleteClipRegion(clip.id);

	const [firstHalf, secondHalf] = await Promise.all([
		createClipRegion({ streamId: clip.streamId, startTime: clip.startTime, endTime: splitTime }),
		createClipRegion({ streamId: clip.streamId, startTime: splitTime, endTime: clip.endTime })
	]);

	// No local store update needed — SSE broadcast handles it
	return { firstHalf, secondHalf };
}

/**
 * Remove a clip region from the store and persist deletion to the server.
 */
export function removeClipRegionAction(clip: ClipRegion): void {
	clipRegions.update((regions) => regions.filter((r) => r.id !== clip.id));
	deleteClipRegion(clip.id);
}
