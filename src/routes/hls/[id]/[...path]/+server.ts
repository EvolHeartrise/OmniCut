import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RequestHandler } from './$types.js';
import { getStreamRecordingDir } from '$lib/server/streamManager.js';

/** Wrap a Node.js ReadStream as a Web ReadableStream. */
function nodeStreamToWeb(nodeStream: fs.ReadStream): ReadableStream {
	return new ReadableStream({
		start(controller) {
			nodeStream.on('data', (chunk) => {
				try { controller.enqueue(chunk); } catch { nodeStream.destroy(); }
			});
			nodeStream.on('end', () => {
				try { controller.close(); } catch { /* already closed */ }
			});
			nodeStream.on('error', (err) => {
				try { controller.error(err); } catch { /* already closed */ }
			});
		},
		cancel() { nodeStream.destroy(); }
	});
}

/**
 * GET /hls/:id/* — Serve HLS playlist and segment files
 *
 * This serves the .m3u8 playlist and .ts segment files from the
 * stream's recording directory. Supports Range requests for
 * efficient seeking.
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

	// Check file exists
	if (!fs.existsSync(resolved)) {
		return new Response('File not found', { status: 404 });
	}

	const stat = fs.statSync(resolved);
	const ext = path.extname(resolved).toLowerCase();

	// Content types for HLS
	const contentTypes: Record<string, string> = {
		'.m3u8': 'application/vnd.apple.mpegurl',
		'.ts': 'video/mp2t',
		'.mp4': 'video/mp4'
	};
	const contentType = contentTypes[ext] || 'application/octet-stream';

	// For .m3u8 files, always return the full file (it's small and changes frequently)
	// Disable caching so the player always gets the latest playlist
	if (ext === '.m3u8') {
		const content = fs.readFileSync(resolved, 'utf-8');
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
			const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
			const chunkSize = end - start + 1;

			const readable = nodeStreamToWeb(fs.createReadStream(resolved, { start, end }));

			return new Response(readable, {
				status: 206,
				headers: {
					'Content-Type': contentType,
					'Content-Range': `bytes ${start}-${end}/${stat.size}`,
					'Content-Length': chunkSize.toString(),
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'public, max-age=31536000, immutable'
				}
			});
		}
	}

	// Full file response
	const readable = nodeStreamToWeb(fs.createReadStream(resolved));

	return new Response(readable, {
		headers: {
			'Content-Type': contentType,
			'Content-Length': stat.size.toString(),
			'Accept-Ranges': 'bytes',
			// Segments are immutable once written; cache aggressively
			'Cache-Control': ext === '.ts' ? 'public, max-age=31536000, immutable' : 'no-cache'
		}
	});
};
