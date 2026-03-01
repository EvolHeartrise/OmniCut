import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RequestHandler } from './$types.js';

const OVERLAYS_DIR = path.resolve(process.cwd(), 'data', 'overlays');

const MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
};

/**
 * GET /api/overlay-image/:id
 *
 * Serves a stored overlay image by its ID (filename including extension).
 */
export const GET: RequestHandler = async ({ params }) => {
	const filePath = path.join(OVERLAYS_DIR, params.id);

	// Prevent path traversal
	if (!filePath.startsWith(OVERLAYS_DIR)) {
		return new Response('Forbidden', { status: 403 });
	}

	if (!fs.existsSync(filePath)) {
		return new Response('Image not found', { status: 404 });
	}

	const ext = path.extname(params.id).toLowerCase();
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';

	const buffer = fs.readFileSync(filePath);
	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'public, max-age=3600',
		},
	});
};
