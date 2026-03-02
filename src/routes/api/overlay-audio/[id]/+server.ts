import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RequestHandler } from './$types.js';

const AUDIO_DIR = path.resolve(process.cwd(), 'data', 'audio');

const MIME_TYPES: Record<string, string> = {
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.webm': 'audio/webm',
};

/**
 * GET /api/overlay-audio/:id
 *
 * Serves a stored overlay audio file by its ID (filename including extension).
 */
export const GET: RequestHandler = async ({ params }) => {
	const filePath = path.join(AUDIO_DIR, params.id);

	// Prevent path traversal
	if (!filePath.startsWith(AUDIO_DIR)) {
		return new Response('Forbidden', { status: 403 });
	}

	if (!fs.existsSync(filePath)) {
		return new Response('Audio not found', { status: 404 });
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
