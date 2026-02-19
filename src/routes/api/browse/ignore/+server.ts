import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addIgnoredChannel, removeIgnoredChannel, loadIgnoredChannels } from '$lib/server/persistence.js';

export const GET: RequestHandler = async () => {
	return json({ channels: loadIgnoredChannels() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const login: string | undefined = body.login;
	if (!login?.trim()) {
		return json({ error: 'login required' }, { status: 400 });
	}
	addIgnoredChannel(login.trim());
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const login: string | undefined = body.login;
	if (!login?.trim()) {
		return json({ error: 'login required' }, { status: 400 });
	}
	removeIgnoredChannel(login.trim());
	return json({ ok: true });
};
