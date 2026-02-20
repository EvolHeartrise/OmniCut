import { TWITCH_CLIENT_ID } from './twitchApi.js';
import type { ChatMessage } from './types.js';

export type ChatCallback = (streamId: string, msg: ChatMessage) => void;

const PAGE_DELAY_MS = 150;

const VOD_COMMENTS_QUERY = `query($videoID: ID!, $cursor: String) {
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
				const res = await fetch('https://gql.twitch.tv/gql', {
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

				if (!res.ok) {
					console.error(`[vod-chat:${videoId}] HTTP ${res.status} — aborting`);
					break;
				}

				const data = await res.json();
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
