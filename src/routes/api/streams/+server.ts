import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { addStream, listStreams } from '$lib/server/streamManager.js';

/**
 * GET /api/streams — List all active streams
 */
export const GET: RequestHandler = async () => {
	const streams = listStreams();
	return json({ streams });
};

/**
 * POST /api/streams — Start capturing a new Twitch channel
 * Body: { channel: string }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { channel } = body;

	if (!channel || typeof channel !== 'string') {
		return json({ error: 'Missing or invalid "channel" field' }, { status: 400 });
	}

	// Clean the channel name (remove URL parts if pasted as a full URL)
	const cleanChannel = channel
		.replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
		.replace(/\/.*$/, '')
		.trim()
		.toLowerCase();

	if (!cleanChannel) {
		return json({ error: 'Invalid channel name' }, { status: 400 });
	}

	try {
		const streamInfo = addStream(cleanChannel);
		return json({ stream: streamInfo }, { status: 201 });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message }, { status: 409 });
	}
};
