import type { RequestHandler } from './$types.js';
import { addSSEClient } from '$lib/server/streamManager.js';

/**
 * GET /api/events — Server-Sent Events endpoint for real-time stream updates
 *
 * Clients connect here and receive JSON events whenever a stream's
 * status changes (new segments, capture started/stopped, errors).
 */
export const GET: RequestHandler = async () => {
	let cleanup: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			// Send initial keepalive
			controller.enqueue(encoder.encode(': connected\n\n'));

			const send = (data: string) => {
				try {
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				} catch {
					// Stream might be closed
					cleanup?.();
					if (keepalive) clearInterval(keepalive);
				}
			};

			cleanup = addSSEClient(send);

			// Send a keepalive ping every 15 seconds
			keepalive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					if (keepalive) clearInterval(keepalive);
					cleanup?.();
				}
			}, 15000);
		},
		cancel() {
			cleanup?.();
			if (keepalive) clearInterval(keepalive);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
