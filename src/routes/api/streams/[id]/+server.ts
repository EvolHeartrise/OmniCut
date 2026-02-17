import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getStream, removeStream } from '$lib/server/streamManager.js';

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
 * DELETE /api/streams/:id — Stop capturing a stream
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const success = removeStream(params.id);
	if (!success) {
		return json({ error: 'Stream not found' }, { status: 404 });
	}
	return json({ success: true });
};
