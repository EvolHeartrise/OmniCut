import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { exportSession, importSession } from '$lib/server/streamManager.js';
import type { SessionExport } from '$lib/server/types.js';

/**
 * GET /api/session — Export current session as JSON download
 */
export const GET: RequestHandler = async () => {
	const data = exportSession();
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="omnicut-session-${Date.now()}.json"`
		}
	});
};

/**
 * POST /api/session — Import session from JSON
 */
export const POST: RequestHandler = async ({ request }) => {
	let data: SessionExport;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (!data || typeof data !== 'object' || !('version' in data) || !Array.isArray(data.streams)) {
		return json({ error: 'Invalid session export format' }, { status: 400 });
	}

	const result = importSession(data);
	const total = data.streams.length;
	const status = result.errors.length === 0 ? 200 : result.imported > 0 ? 207 : 400;

	return json({ imported: result.imported, total, errors: result.errors }, { status });
};
