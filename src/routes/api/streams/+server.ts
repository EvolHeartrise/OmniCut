import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { addStream, addVodStream, addVodByUrl, listStreams, getTranscriptions, getAllClipRegions } from '$lib/server/streamManager.js';

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
	const clipRegions = getAllClipRegions();
	return json({ streams, transcriptions, clipRegions });
};

/**
 * POST /api/streams — Start capturing a new Twitch channel
 * Body: { channel: string }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { channel, language, vod, vodUrl, platform } = body;

	// Direct VOD URL mode — no channel needed
	if (vodUrl && typeof vodUrl === 'string') {
		try {
			const streamInfo = await addVodByUrl(vodUrl.trim(), language ?? null);
			return json({ stream: streamInfo }, { status: 201 });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return json({ error: message }, { status: 409 });
		}
	}

	if (!channel || typeof channel !== 'string') {
		return json({ error: 'Missing or invalid "channel" field' }, { status: 400 });
	}

	// Clean the channel name (remove URL parts if pasted as a full URL)
	const cleanChannel = channel
		.replace(/^https?:\/\/(www\.)?(twitch\.tv|douyu\.com)\//, '')
		.replace(/\/.*$/, '')
		.trim()
		.toLowerCase();

	if (!cleanChannel) {
		return json({ error: 'Invalid channel name' }, { status: 400 });
	}

	try {
		const streamInfo = vod
			? await addVodStream(cleanChannel, language ?? null)
			: await addStream(cleanChannel, language ?? null, platform || 'twitch');
		return json({ stream: streamInfo }, { status: 201 });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message }, { status: 409 });
	}
};
