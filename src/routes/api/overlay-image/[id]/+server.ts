import * as path from 'node:path';
import type { RequestHandler } from './$types.js';
import { serveStaticFile } from '$lib/server/serveStaticFile.js';

const OVERLAYS_DIR = path.resolve(process.cwd(), 'data', 'overlays');

export const GET: RequestHandler = async ({ params }) => {
	return serveStaticFile(OVERLAYS_DIR, params.id, 'Image');
};
