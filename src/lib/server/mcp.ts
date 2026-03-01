/**
 * OmniCut MCP Server
 *
 * Exposes OmniCut's read-heavy workflow to AI agents via MCP (Model Context Protocol).
 * Tools are intentionally limited to non-destructive operations — agents can observe
 * streams, search chat & transcriptions, look up channels, and create clips, but cannot
 * stop captures, delete streams, or remove data.
 *
 * Tool implementations are split into modules under ./mcpTools/.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerStreamTools } from './mcpTools/streams.js';
import { registerClipTools } from './mcpTools/clips.js';
import { registerSearchTools } from './mcpTools/search.js';
import { registerChannelTools } from './mcpTools/channels.js';
import { registerVideoTools } from './mcpTools/videos.js';
import { registerScreenshotTools } from './mcpTools/screenshot.js';

// ---------------------------------------------------------------------------
// Server factory — one McpServer instance per transport/session
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
	const mcpServer = new McpServer(
		{
			name: 'omnicut',
			version: '1.0.0'
		},
		{
			capabilities: {
				tools: {}
			},
			instructions:
				'OmniCut — live-stream capture and clipping tool. Observe streams, search chat/transcriptions, look up channels, create clips, and export video.'
		}
	);

	registerStreamTools(mcpServer);
	registerClipTools(mcpServer);
	registerSearchTools(mcpServer);
	registerChannelTools(mcpServer);
	registerVideoTools(mcpServer);
	registerScreenshotTools(mcpServer);

	return mcpServer;
}
