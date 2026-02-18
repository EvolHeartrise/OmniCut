import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getStream, removeStream, stopStream, updateStreamOffset, addClipRegion, removeClipRegion } from '$lib/server/streamManager.js';

/**
 * GET /api/streams/:id — Get info about a specific stream
 */
export const GET: RequestHandler = async ({ params }) => {
	const stream = getStream(params.id);
	if (!stream) {
		return json({ error: 'Stream not found' }, { status: 404 });
	}
	return json({ stream });
};

/**
 * PATCH /api/streams/:id — Update stream properties (e.g. offset)
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	if (typeof body.offset === 'number') {
		const found = updateStreamOffset(params.id, body.offset);
		if (!found) {
			return json({ error: 'Stream not found' }, { status: 404 });
		}
	}
	if (body.addClipRegion) {
		const r = body.addClipRegion;
		addClipRegion({ id: r.id, streamId: r.streamId, startTime: r.startTime, endTime: r.endTime });
	}
	if (typeof body.removeClipRegionId === 'string') {
		removeClipRegion(body.removeClipRegionId);
	}
	if (body.stop === true) {
		stopStream(params.id);
	}
	const stream = getStream(params.id);
	return json({ stream });
};

/**
 * DELETE /api/streams/:id — Stop capturing a stream
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const success = removeStream(params.id);
	if (!success) {
		return json({ error: 'Stream not found' }, { status: 404 });
	}
	return json({ success: true });
};
