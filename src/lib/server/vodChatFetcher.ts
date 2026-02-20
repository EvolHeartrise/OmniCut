import { TWITCH_CLIENT_ID } from './twitchApi.js';
import type { ChatMessage } from './types.js';

export type ChatCallback = (streamId: string, msg: ChatMessage) => void;

const PAGE_DELAY_MS = 150;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

const VOD_COMMENTS_QUERY = `query($videoID: ID!, $cursor: Cursor) {
  video(id: $videoID) {
    comments(after: $cursor) {
      edges {
        cursor
        node {
          contentOffsetSeconds
          commenter { displayName }
          message { fragments { text } }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

/**
 * Extract a Twitch video ID from a URL like https://twitch.tv/videos/12345
 * or a bare numeric string.
 */
export function extractVideoId(sourceUrl: string): string | null {
	const match = sourceUrl.match(/(?:twitch\.tv\/videos\/|^)(\d+)$/);
	return match ? match[1] : null;
}

/**
 * Start fetching VOD chat comments from Twitch GQL API.
 * Paginates through all comments, calling onMessage for each one.
 * Returns a stop function for clean cancellation.
 */
export function startVodChatFetch(
	streamId: string,
	videoId: string,
	onMessage: ChatCallback
): () => void {
	let stopped = false;

	async function fetchAllPages() {
		let cursor: string | undefined;
		let totalMessages = 0;

		console.log(`[vod-chat:${videoId}] Starting VOD chat download`);

		try {
			while (!stopped) {
				let res: Response | undefined;
				let data: any;

				for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
					if (stopped) break;

					res = await fetch('https://gql.twitch.tv/gql', {
						method: 'POST',
						headers: {
							'Client-ID': TWITCH_CLIENT_ID,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							query: VOD_COMMENTS_QUERY,
							variables: { videoID: videoId, cursor: cursor ?? null }
						})
					});

					if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
						if (attempt === MAX_RETRIES) {
							console.error(`[vod-chat:${videoId}] HTTP ${res.status} after ${MAX_RETRIES} retries — aborting`);
							break;
						}
						const delay = INITIAL_BACKOFF_MS * 2 ** attempt;
						console.warn(`[vod-chat:${videoId}] HTTP ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
						await new Promise((r) => setTimeout(r, delay));
						continue;
					}

					break;
				}

				if (!res || stopped) break;

				if (!res.ok) {
					console.error(`[vod-chat:${videoId}] HTTP ${res.status} — aborting`);
					break;
				}

				data = await res.json();

				if (data.errors) {
					console.error(`[vod-chat:${videoId}] GQL errors:`, data.errors.map((e: any) => e.message).join('; '));
					break;
				}

				const comments = data?.data?.video?.comments;

				if (!comments) {
					// Video has no comments or doesn't exist
					break;
				}

				const edges: any[] = comments.edges ?? [];

				for (const edge of edges) {
					if (stopped) break;

					const node = edge.node;
					const username = node.commenter?.displayName ?? '[deleted]';
					const fragments: any[] = node.message?.fragments ?? [];
					const text = fragments.map((f: any) => f.text).join('');
					const timestamp: number = node.contentOffsetSeconds ?? 0;

					onMessage(streamId, { username, text, timestamp });
					totalMessages++;

					cursor = edge.cursor;
				}

				if (!comments.pageInfo?.hasNextPage) {
					break;
				}

				// Rate-limit delay between pages
				await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
			}
		} catch (err) {
			if (!stopped) {
				console.error(`[vod-chat:${videoId}] Error fetching chat:`, err);
			}
		}

		console.log(`[vod-chat:${videoId}] Finished — ${totalMessages} messages downloaded`);
	}

	// Fire and forget
	fetchAllPages();

	return () => {
		stopped = true;
		console.log(`[vod-chat:${videoId}] Chat fetch stopped`);
	};
}
