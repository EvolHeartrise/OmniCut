import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { VodInfo } from '$lib/types.js';
import { TWITCH_CLIENT_ID } from '$lib/server/twitchApi.js';

const VIDEOS_QUERY = `query($login: String!, $first: Int, $after: Cursor, $type: BroadcastType) {
	user(login: $login) {
		videos(first: $first, after: $after, type: $type, sort: TIME) {
			edges {
				cursor
				node {
					id
					title
					createdAt
					lengthSeconds
					previewThumbnailURL(width: 320, height: 180)
					viewCount
				}
			}
			pageInfo { hasNextPage }
		}
	}
}`;

interface VideoEdge {
	cursor: string;
	node: {
		id: string;
		title: string | null;
		createdAt: string | null;
		lengthSeconds: number | null;
		previewThumbnailURL: string | null;
		viewCount: number | null;
	};
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const login: string = body.login;
	const first = Math.min(Math.max(body.first ?? 20, 1), 100);
	const after: string | undefined = body.after;

	if (!login) {
		return json({ vods: [], cursor: null, hasNextPage: false }, { status: 400 });
	}

	try {
		const variables: Record<string, unknown> = { login, first, type: 'ARCHIVE' };
		if (after) variables.after = after;

		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: {
				'Client-ID': TWITCH_CLIENT_ID,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ query: VIDEOS_QUERY, variables })
		});
		const data = await res.json();

		if (data.errors) {
			console.error('Twitch GQL errors (vods):', data.errors);
			return json({ vods: [], cursor: null, hasNextPage: false }, { status: 502 });
		}

		const connection = data?.data?.user?.videos;
		if (!connection) {
			// User not found or no videos
			return json({ vods: [], cursor: null, hasNextPage: false });
		}

		const edges: VideoEdge[] = connection.edges ?? [];
		const lastCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
		const hasNextPage = connection.pageInfo?.hasNextPage ?? false;

		const vods: VodInfo[] = edges.map((edge) => ({
			id: edge.node.id,
			title: edge.node.title ?? null,
			createdAt: edge.node.createdAt ?? null,
			durationSeconds: edge.node.lengthSeconds ?? null,
			thumbnailUrl: edge.node.previewThumbnailURL ?? null,
			viewCount: edge.node.viewCount ?? null
		}));

		return json({ vods, cursor: lastCursor, hasNextPage });
	} catch (err) {
		console.error('Vods API error:', err);
		return json({ vods: [], cursor: null, hasNextPage: false }, { status: 500 });
	}
};
