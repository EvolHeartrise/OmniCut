import * as path from 'node:path';
import type { RequestHandler } from './$types.js';
import { serveStaticFile } from '$lib/server/serveStaticFile.js';

const AUDIO_DIR = path.resolve(process.cwd(), 'data', 'audio');

export const GET: RequestHandler = async ({ params }) => {
	return serveStaticFile(AUDIO_DIR, params.id, 'Audio');
};
