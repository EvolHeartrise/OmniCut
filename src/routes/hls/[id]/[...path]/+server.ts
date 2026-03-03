import * as path from 'node:path';
import type { RequestHandler } from './$types.js';
import { getStreamRecordingDir, getStream } from '$lib/server/streamManager.js';

/**
 * GET /hls/:id/* — Serve HLS playlist and segment files
 *
 * This serves the .m3u8 playlist and .ts segment files from the
 * stream's recording directory. Uses Bun.file() for efficient
 * zero-copy file serving. Supports Range requests for efficient seeking.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const streamId = params.id;
	const filePath = params.path;

	const recordingDir = getStreamRecordingDir(streamId);
	if (!recordingDir) {
		return new Response('Stream not found', { status: 404 });
	}

	const fullPath = path.join(recordingDir, filePath);

	// Security: ensure we're not escaping the recording directory
	const resolved = path.resolve(fullPath);
	if (!resolved.startsWith(path.resolve(recordingDir))) {
		return new Response('Forbidden', { status: 403 });
	}

	// Use Bun.file() for efficient file access
	const file = Bun.file(resolved);
	const exists = await file.exists();
	if (!exists) {
		return new Response('File not found', { status: 404 });
	}

	const ext = path.extname(resolved).toLowerCase();

	// Content types for HLS
	const contentTypes: Record<string, string> = {
		'.m3u8': 'application/vnd.apple.mpegurl',
		'.ts': 'video/mp2t',
		'.mp4': 'video/mp4'
	};
	const contentType = contentTypes[ext] || 'application/octet-stream';

	// For .m3u8 files, serve with appropriate caching based on stream status
	if (ext === '.m3u8') {
		let content = await file.text();
		const streamInfo = getStream(streamId);
		const isStopped = !streamInfo || streamInfo.status === 'stopped' || streamInfo.status === 'error';

		if (isStopped) {
			// Stream is finished — playlist won't change, mark as VOD and cache forever
			if (!content.includes('#EXT-X-ENDLIST')) {
				content = content.trimEnd() + '\n#EXT-X-ENDLIST\n';
			}
			return new Response(content, {
				headers: {
					'Content-Type': contentType,
					'Cache-Control': 'public, max-age=31536000, immutable'
				}
			});
		}

		// Stream is still capturing — playlist is growing, don't cache
		return new Response(content, {
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'no-cache, no-store, must-revalidate'
			}
		});
	}

	// For .ts segment files, support Range requests for efficient seeking
	const rangeHeader = request.headers.get('range');

	if (rangeHeader) {
		const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
		if (match) {
			const start = parseInt(match[1], 10);
			const end = match[2] ? parseInt(match[2], 10) : file.size - 1;
			const chunkSize = end - start + 1;

			const slice = file.slice(start, end + 1);

			return new Response(slice, {
				status: 206,
				headers: {
					'Content-Type': contentType,
					'Content-Range': `bytes ${start}-${end}/${file.size}`,
					'Content-Length': chunkSize.toString(),
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'public, max-age=31536000, immutable'
				}
			});
		}
	}

	// Full file response — Bun.file() supports zero-copy sendfile
	return new Response(file, {
		headers: {
			'Content-Type': contentType,
			'Content-Length': file.size.toString(),
			'Accept-Ranges': 'bytes',
			// Segments and mp4 are immutable once written; cache aggressively
			'Cache-Control': ext === '.ts' || ext === '.mp4' ? 'public, max-age=31536000, immutable' : 'no-cache'
		}
	});
};
