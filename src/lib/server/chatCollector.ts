import type { ChatMessage } from './types.js';

export type ChatCallback = (streamId: string, msg: ChatMessage) => void;

const TWITCH_IRC_WS = 'wss://irc-ws.chat.twitch.tv:443';
const RECONNECT_DELAY = 3000;

// Regex to parse PRIVMSG lines from Twitch IRC
// Format: :username!username@username.tmi.twitch.tv PRIVMSG #channel :message text
const PRIVMSG_RE = /^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/;

/**
 * Connect to a Twitch channel's IRC chat via anonymous WebSocket
 * and call onMessage for each chat message received.
 *
 * Uses the "justinfan" anonymous read-only connection method.
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
			// Anonymous read-only connection using justinfan nickname
			const nick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
			ws.send(`NICK ${nick}\r\n`);
			ws.send(`JOIN #${channel.toLowerCase()}\r\n`);
			console.log(`[chat:${channel}] Connected to Twitch IRC`);
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
					const username = match[1];
					const text = match[2];
					const timestamp = (Date.now() - startedAt) / 1000; // stream-local seconds

					onMessage(streamId, { username, text, timestamp });
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
			} catch { /* already closed */ }
			ws = null;
		}
		console.log(`[chat:${channel}] Chat collection stopped`);
	};
}
