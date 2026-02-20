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
          commenter { displayName chatColor }
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

// --- Chat fetch queue (one at a time to avoid Twitch GQL rate limits) ---

interface QueueEntry {
	streamId: string;
	videoId: string;
	onMessage: ChatCallback;
	onComplete?: (success: boolean) => void;
	stopped: boolean;
}

const chatQueue: QueueEntry[] = [];
let activeEntry: QueueEntry | null = null;

async function fetchAllPages(entry: QueueEntry) {
	let cursor: string | undefined;
	let totalMessages = 0;
	let success = false;

	console.log(`[vod-chat:${entry.videoId}] Starting VOD chat download`);

	try {
		while (!entry.stopped) {
			let res: Response | undefined;
			let data: any;

			let retryable = false;
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (entry.stopped) break;
				retryable = false;

				res = await fetch('https://gql.twitch.tv/gql', {
					method: 'POST',
					headers: {
						'Client-ID': TWITCH_CLIENT_ID,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						query: VOD_COMMENTS_QUERY,
						variables: { videoID: entry.videoId, cursor: cursor ?? null }
					})
				});

				if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
					retryable = true;
				} else if (res.ok) {
					data = await res.json();
					// Treat GQL service timeouts as retryable
					if (data.errors?.some((e: any) => /timeout/i.test(e.message))) {
						retryable = true;
					}
				}

				if (retryable) {
					if (attempt === MAX_RETRIES) {
						console.error(`[vod-chat:${entry.videoId}] Failed after ${MAX_RETRIES} retries — aborting`);
						break;
					}
					const delay = INITIAL_BACKOFF_MS * 2 ** attempt;
					console.warn(`[vod-chat:${entry.videoId}] Retryable error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}

				break;
			}

			if (!res || entry.stopped || retryable) break;

			if (!res.ok) {
				console.error(`[vod-chat:${entry.videoId}] HTTP ${res.status} — aborting`);
				break;
			}

			if (!data) data = await res.json();

			if (data.errors) {
				console.error(`[vod-chat:${entry.videoId}] GQL errors:`, data.errors.map((e: any) => e.message).join('; '));
				break;
			}

			const comments = data?.data?.video?.comments;

			if (!comments) {
				// No comments or video doesn't exist — still a clean finish
				success = true;
				break;
			}

			const edges: any[] = comments.edges ?? [];

			for (const edge of edges) {
				if (entry.stopped) break;

				const node = edge.node;
				const username = node.commenter?.displayName ?? '[deleted]';
				const fragments: any[] = node.message?.fragments ?? [];
				const text = fragments.map((f: any) => f.text).join('');
				const timestamp: number = node.contentOffsetSeconds ?? 0;
				const color: string | null = node.commenter?.chatColor ?? null;

				entry.onMessage(entry.streamId, { username, text, timestamp, color });
				totalMessages++;

				cursor = edge.cursor;
			}

			if (!comments.pageInfo?.hasNextPage) {
				success = true;
				break;
			}

			await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
		}
	} catch (err) {
		if (!entry.stopped) {
			console.error(`[vod-chat:${entry.videoId}] Error fetching chat:`, err);
		}
	}

	console.log(`[vod-chat:${entry.videoId}] Finished — ${totalMessages} messages downloaded (success=${success})`);
	entry.onComplete?.(success);
}

function processQueue() {
	if (activeEntry) return;
	const next = chatQueue.shift();
	if (!next) return;

	// Skip entries that were cancelled while waiting
	if (next.stopped) {
		processQueue();
		return;
	}

	activeEntry = next;
	const pending = chatQueue.filter(e => !e.stopped).length;
	if (pending > 0) {
		console.log(`[vod-chat] ${pending} more in queue`);
	}

	fetchAllPages(next).finally(() => {
		activeEntry = null;
		processQueue();
	});
}

/**
 * Queue a VOD chat fetch. Only one runs at a time to avoid Twitch GQL rate limits.
 * Returns a stop function for clean cancellation.
 */
export function startVodChatFetch(
	streamId: string,
	videoId: string,
	onMessage: ChatCallback,
	onComplete?: (success: boolean) => void
): () => void {
	const entry: QueueEntry = { streamId, videoId, onMessage, onComplete, stopped: false };
	chatQueue.push(entry);
	processQueue();

	return () => {
		entry.stopped = true;
		if (activeEntry === entry) {
			console.log(`[vod-chat:${videoId}] Chat fetch stopped`);
		} else {
			// Remove from queue if not yet started
			const idx = chatQueue.indexOf(entry);
			if (idx !== -1) chatQueue.splice(idx, 1);
			console.log(`[vod-chat:${videoId}] Chat fetch cancelled (was queued)`);
		}
	};
}
