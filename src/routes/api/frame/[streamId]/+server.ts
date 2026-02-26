import type { RequestHandler } from './$types.js';
import { getStreamRecordingDir } from '$lib/server/streamManager.js';
import { extractFrame } from '$lib/server/hlsUtils.js';

/**
 * GET /api/frame/:streamId?t=<local_seconds>
 *
 * Extracts a single JPEG frame from an HLS recording at the given local timestamp.
 * Reuses extractFrame() from hlsUtils.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const streamId = params.streamId;
	const recordingDir = getStreamRecordingDir(streamId);
	if (!recordingDir) {
		return new Response('Stream not found', { status: 404 });
	}

	const t = parseFloat(url.searchParams.get('t') || '0');
	if (isNaN(t) || t < 0) {
		return new Response('Invalid timestamp', { status: 400 });
	}

	try {
		const jpegBuffer = await extractFrame(recordingDir, t);
		return new Response(new Uint8Array(jpegBuffer), {
			headers: {
				'Content-Type': 'image/jpeg',
				'Cache-Control': 'public, max-age=60'
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(message, { status: 500 });
	}
};
