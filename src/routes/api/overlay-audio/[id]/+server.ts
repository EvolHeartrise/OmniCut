import type { RequestHandler } from './$types.js';
import { serveStaticFile } from '$lib/server/serveStaticFile.js';
import { AUDIO_DIR } from '$lib/server/paths.js';

export const GET: RequestHandler = async ({ params }) => {
	return serveStaticFile(AUDIO_DIR, params.id, 'Audio');
};
