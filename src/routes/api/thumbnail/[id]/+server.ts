import * as fs from 'node:fs';
import type { RequestHandler } from './$types.js';
import { loadThumbnail } from '$lib/server/db/index.js';

/**
 * GET /api/thumbnail/:id
 *
 * Serves a saved PNG thumbnail by its database ID.
 */
export const GET: RequestHandler = async ({ params }) => {
	const record = loadThumbnail(params.id);
	if (!record) {
		return new Response('Thumbnail not found', { status: 404 });
	}

	if (!fs.existsSync(record.filePath)) {
		return new Response('Thumbnail file missing', { status: 404 });
	}

	const buffer = fs.readFileSync(record.filePath);
	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=300'
		}
	});
};
