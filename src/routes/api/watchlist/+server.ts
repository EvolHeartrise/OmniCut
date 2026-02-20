import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { loadWatchlist, addToWatchlist, removeFromWatchlist } from '$lib/server/persistence.js';

export const GET: RequestHandler = async () => {
	const watchlist = loadWatchlist();
	return json({ watchlist });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { login, platform } = body;

	if (!login || typeof login !== 'string') {
		return json({ error: 'Missing or invalid "login" field' }, { status: 400 });
	}

	addToWatchlist(login.toLowerCase().trim(), platform || 'twitch');
	return json({ ok: true }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { login, platform } = body;

	if (!login || typeof login !== 'string') {
		return json({ error: 'Missing or invalid "login" field' }, { status: 400 });
	}

	removeFromWatchlist(login.toLowerCase().trim(), platform || 'twitch');
	return json({ ok: true });
};
