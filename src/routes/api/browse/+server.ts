import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ChannelInfo } from '$lib/types.js';
import { TWITCH_CLIENT_ID } from '$lib/server/twitchApi.js';

const STREAMS_QUERY = `query($first: Int!, $after: Cursor, $opts: StreamOptions) {
	streams(first: $first, after: $after, options: $opts) {
		edges {
			cursor
			node {
				broadcaster {
					login
					displayName
					profileImageURL(width: 70)
				}
				viewersCount
				title
				game { name }
				createdAt
			}
		}
		pageInfo { hasNextPage }
	}
}`;

const GAME_STREAMS_QUERY = `query($id: ID!, $first: Int!, $after: Cursor, $opts: GameStreamOptions) {
	game(id: $id) {
		streams(first: $first, after: $after, options: $opts) {
			edges {
				cursor
				node {
					broadcaster {
						login
						displayName
						profileImageURL(width: 70)
					}
					viewersCount
					title
					game { name }
					createdAt
				}
			}
			pageInfo { hasNextPage }
		}
	}
}`;

interface StreamEdge {
	cursor: string;
	node: {
		broadcaster: { login: string; displayName: string; profileImageURL: string };
		viewersCount: number;
		title: string;
		game: { name: string } | null;
		createdAt: string;
	};
}

function mapEdges(edges: StreamEdge[]): { streams: ChannelInfo[]; cursor: string | null } {
	const cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
	const streams = edges.map((edge) => ({
		login: edge.node.broadcaster.login,
		displayName: edge.node.broadcaster.displayName ?? null,
		profileImageUrl: edge.node.broadcaster.profileImageURL ?? null,
		isLive: true,
		title: edge.node.title ?? null,
		gameName: edge.node.game?.name ?? null,
		viewerCount: edge.node.viewersCount ?? null,
		startedAt: edge.node.createdAt ?? null
	}));
	return { streams, cursor };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const gameId: string | undefined = body.gameId;
	const maxFirst = gameId ? 100 : 30;
	const first = Math.min(Math.max(body.first ?? maxFirst, 1), maxFirst);
	const after: string | undefined = body.after;

	try {
		const query = gameId ? GAME_STREAMS_QUERY : STREAMS_QUERY;
		const variables: Record<string, unknown> = { first, opts: { languages: ['EN'] } };
		if (after) variables.after = after;
		if (gameId) variables.id = gameId;

		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: {
				'Client-ID': TWITCH_CLIENT_ID,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ query, variables })
		});
		const data = await res.json();

		if (data.errors) {
			console.error('Twitch GQL errors:', data.errors);
			return json({ streams: [], cursor: null, hasNextPage: false }, { status: 502 });
		}

		const connection = gameId
			? data?.data?.game?.streams
			: data?.data?.streams;

		if (!connection) {
			return json({ streams: [], cursor: null, hasNextPage: false });
		}

		const edges: StreamEdge[] = connection.edges ?? [];
		const { streams, cursor: lastCursor } = mapEdges(edges);
		const hasNextPage = connection.pageInfo?.hasNextPage ?? false;

		return json({ streams, cursor: lastCursor, hasNextPage });
	} catch (err) {
		console.error('Browse API error:', err);
		return json({ streams: [], cursor: null, hasNextPage: false }, { status: 500 });
	}
};
