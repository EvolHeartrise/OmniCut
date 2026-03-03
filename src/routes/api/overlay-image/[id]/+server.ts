import type { RequestHandler } from './$types.js';
import { serveStaticFile } from '$lib/server/serveStaticFile.js';
import { OVERLAYS_DIR } from '$lib/server/paths.js';

export const GET: RequestHandler = async ({ params }) => {
	return serveStaticFile(OVERLAYS_DIR, params.id, 'Image');
};
