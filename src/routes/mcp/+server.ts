/**
 * OmniCut MCP HTTP Transport Endpoint
 *
 * Exposes the MCP server over Streamable HTTP (Web Standard).
 * Handles GET (SSE stream for server-initiated messages), POST (JSON-RPC requests),
 * and DELETE (session teardown).
 *
 * Usage:
 *   POST http://localhost:5173/mcp   — Send JSON-RPC requests
 *   GET  http://localhost:5173/mcp   — Open SSE stream for notifications
 *   DELETE http://localhost:5173/mcp — Close session
 */

import type { RequestHandler } from '@sveltejs/kit';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '$lib/server/mcp.js';

/**
 * Session management: we keep one transport per session so that stateful
 * MCP interactions (like SSE notification streams) work correctly.
 */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

function getOrCreateTransport(sessionId?: string): WebStandardStreamableHTTPServerTransport {
	if (sessionId && sessions.has(sessionId)) {
		return sessions.get(sessionId)!;
	}

	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => crypto.randomUUID(),
		onsessioninitialized: (sid) => {
			sessions.set(sid, transport);
		},
		onsessionclosed: (sid) => {
			sessions.delete(sid);
		}
	});

	// Each session gets its own McpServer instance (the SDK only allows
	// one transport per Protocol instance).
	const server = createMcpServer();
	server.connect(transport);

	return transport;
}

function getSessionId(request: Request): string | undefined {
	return request.headers.get('mcp-session-id') ?? undefined;
}

/**
 * POST /mcp — JSON-RPC requests from MCP clients
 */
export const POST: RequestHandler = async ({ request }) => {
	const sessionId = getSessionId(request);
	const transport = getOrCreateTransport(sessionId);
	return transport.handleRequest(request);
};

/**
 * GET /mcp — SSE stream for server-initiated notifications
 */
export const GET: RequestHandler = async ({ request }) => {
	const sessionId = getSessionId(request);
	const transport = getOrCreateTransport(sessionId);
	return transport.handleRequest(request);
};

/**
 * DELETE /mcp — Session teardown
 */
export const DELETE: RequestHandler = async ({ request }) => {
	const sessionId = getSessionId(request);
	const transport = getOrCreateTransport(sessionId);
	return transport.handleRequest(request);
};
