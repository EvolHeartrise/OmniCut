/**
 * Shared utility for serving static files from a base directory.
 * Used by overlay-audio and overlay-image API routes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MIME_TYPES: Record<string, string> = {
	// Audio
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.webm': 'audio/webm',
	// Image
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
};

/**
 * Serve a static file from a base directory. Returns a Response.
 * Validates against path traversal and returns appropriate error responses.
 */
export function serveStaticFile(baseDir: string, filename: string, notFoundLabel: string): Response {
	const filePath = path.resolve(path.join(baseDir, filename));

	if (!filePath.startsWith(path.resolve(baseDir))) {
		return new Response('Forbidden', { status: 403 });
	}

	if (!fs.existsSync(filePath)) {
		return new Response(`${notFoundLabel} not found`, { status: 404 });
	}

	const ext = path.extname(filename).toLowerCase();
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';

	const buffer = fs.readFileSync(filePath);
	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'public, max-age=3600',
		},
	});
}
