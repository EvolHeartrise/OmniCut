import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { addStream, listStreams, getTranscriptions, getAllClipRegions, getChatMessages } from '$lib/server/streamManager.js';

/**
 * GET /api/streams — List all active streams (includes stored transcriptions)
 */
export const GET: RequestHandler = async () => {
	const streams = listStreams();
	const transcriptions: Record<string, Array<{ text: string; startTime: number; endTime: number }>> = {};
	for (const s of streams) {
		const entries = getTranscriptions(s.id);
		if (entries.length > 0) {
			transcriptions[s.id] = entries;
		}
	}
	const chatMessages: Record<string, Array<{ username: string; text: string; timestamp: number }>> = {};
	for (const s of streams) {
		const msgs = getChatMessages(s.id);
		if (msgs.length > 0) {
			chatMessages[s.id] = msgs;
		}
	}
	const clipRegions = getAllClipRegions();
	return json({ streams, transcriptions, clipRegions, chatMessages });
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
		const streamInfo = await addStream(cleanChannel);
		return json({ stream: streamInfo }, { status: 201 });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message }, { status: 409 });
	}
};
