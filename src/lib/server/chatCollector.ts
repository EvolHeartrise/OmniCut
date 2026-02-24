import type { ChatMessage, ChatCallback } from './types.js';

const TWITCH_IRC_WS = 'wss://irc-ws.chat.twitch.tv:443';
const RECONNECT_DELAY = 3000;

// Regex to parse PRIVMSG lines (with optional @tags prefix)
// Tagged format: @badge-info=...;color=#FF0000;display-name=User;... :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
// Untagged format: :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
const PRIVMSG_RE = /^(?:@(\S+) )?:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/;

function extractTag(tags: string, key: string): string | null {
	const prefix = key + '=';
	const start = tags.indexOf(prefix);
	if (start === -1) return null;
	const valueStart = start + prefix.length;
	const end = tags.indexOf(';', valueStart);
	const value = end === -1 ? tags.slice(valueStart) : tags.slice(valueStart, end);
	return value || null;
}

/**
 * Connect to a Twitch channel's IRC chat via anonymous WebSocket
 * and call onMessage for each chat message received.
 *
 * Uses the "justinfan" anonymous read-only connection method.
 * Requests twitch.tv/tags capability to get user chat colors.
 * Returns a cleanup function that closes the WebSocket.
 */
export function startChatCollection(
	streamId: string,
	channel: string,
	startedAt: number, // epoch ms — for computing stream-local timestamps
	onMessage: ChatCallback
): () => void {
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	function connect() {
		if (stopped) return;

		try {
			ws = new WebSocket(TWITCH_IRC_WS);
		} catch (err) {
			console.error(`[chat:${channel}] Failed to create WebSocket:`, err);
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			if (!ws || stopped) return;
			// Request tags capability for user colors and display names
			ws.send('CAP REQ :twitch.tv/tags\r\n');
			// Anonymous read-only connection using justinfan nickname
			const nick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
			ws.send(`NICK ${nick}\r\n`);
			ws.send(`JOIN #${channel.toLowerCase()}\r\n`);
			console.log(`[chat:${channel}] Connected to Twitch IRC (with tags)`);
		};

		ws.onmessage = (event) => {
			if (stopped) return;
			const raw = typeof event.data === 'string' ? event.data : '';
			const lines = raw.split('\r\n');

			for (const line of lines) {
				if (!line) continue;

				// Respond to PING to stay alive
				if (line.startsWith('PING')) {
					ws?.send('PONG :tmi.twitch.tv\r\n');
					continue;
				}

				// Parse PRIVMSG (chat messages)
				const match = line.match(PRIVMSG_RE);
				if (match) {
					const tags = match[1] || '';
					const fallbackUsername = match[2];
					const text = match[3];
					const timestamp = (Date.now() - startedAt) / 1000; // stream-local seconds

					// Prefer display-name from tags (proper casing), fall back to IRC nick
					const username = extractTag(tags, 'display-name') || fallbackUsername;
					const color = extractTag(tags, 'color');
					const badgesRaw = extractTag(tags, 'badges');
					const badges = badgesRaw
						? badgesRaw.split(',').map((b) => b.split('/')[0]).join(',')
						: null;
					const twitchId = extractTag(tags, 'id');
					if (!twitchId) continue; // skip messages without a Twitch ID

					onMessage(streamId, { username, text, timestamp, color, badges, twitchId });
				}
			}
		};

		ws.onclose = () => {
			if (!stopped) {
				console.log(`[chat:${channel}] WebSocket closed, will reconnect...`);
				scheduleReconnect();
			}
		};

		ws.onerror = (err) => {
			console.error(`[chat:${channel}] WebSocket error:`, err);
			// onclose will fire after this, which handles reconnect
		};
	}

	function scheduleReconnect() {
		if (stopped || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, RECONNECT_DELAY);
	}

	// Start the initial connection
	connect();

	// Return cleanup function
	return () => {
		stopped = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (ws) {
			try {
				ws.close();
			} catch {
				/* already closed */
			}
			ws = null;
		}
		console.log(`[chat:${channel}] Chat collection stopped`);
	};
}
