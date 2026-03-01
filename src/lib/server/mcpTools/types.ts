/**
 * Shared types and helpers for MCP tool handlers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** The type for registering tools — the McpServer instance itself. */
export type ToolRegistrar = McpServer;

/** Shorthand for an MCP text content block. */
export function textResult(text: string, isError?: boolean) {
	return {
		...(isError && { isError: true }),
		content: [{ type: 'text' as const, text }]
	};
}

/** JSON text result shorthand. */
export function jsonResult(data: unknown) {
	return textResult(JSON.stringify(data));
}
