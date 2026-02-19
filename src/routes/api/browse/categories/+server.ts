import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { TWITCH_CLIENT_ID } from '$lib/server/twitchApi.js';

const SEARCH_CATEGORIES_QUERY = `query($query: String!) {
	searchCategories(query: $query, first: 10) {
		edges {
			node {
				id
				name
			}
		}
	}
}`;

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const query: string = body.query ?? '';

	if (!query.trim()) {
		return json({ categories: [] });
	}

	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: {
				'Client-ID': TWITCH_CLIENT_ID,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				query: SEARCH_CATEGORIES_QUERY,
				variables: { query }
			})
		});
		const data = await res.json();
		const edges = data?.data?.searchCategories?.edges ?? [];
		const categories = edges.map((e: { node: { id: string; name: string } }) => ({
			id: e.node.id,
			name: e.node.name
		}));
		return json({ categories });
	} catch (err) {
		console.error('Category search error:', err);
		return json({ categories: [] }, { status: 500 });
	}
};
