import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getChatMessagesInRange } from '$lib/server/streamManager.js';

/**
 * GET /api/streams/:id/chat?from=<localSec>&to=<localSec>
 * Returns chat messages within a stream-local time range.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const from = parseFloat(url.searchParams.get('from') || '0');
	const to = parseFloat(url.searchParams.get('to') || '0');
	if (to <= from) {
		return json({ messages: [] });
	}
	const messages = getChatMessagesInRange(params.id, from, to);
	return json({ messages });
};
