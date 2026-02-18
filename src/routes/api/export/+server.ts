import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { exportVideo } from '$lib/server/streamManager.js';

/**
 * POST /api/export — Stitch all clip regions into a single video file
 * Body: { filename: string }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { filename } = body;

	if (!filename || typeof filename !== 'string' || filename.trim().length === 0) {
		return json({ error: 'Filename is required' }, { status: 400 });
	}

	try {
		const result = await exportVideo(filename.trim());
		return json({ success: true, outputPath: result.outputPath });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Export failed';
		return json({ error: message }, { status: 500 });
	}
};
