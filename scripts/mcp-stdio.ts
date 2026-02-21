#!/usr/bin/env bun
/**
 * OmniCut MCP Stdio Proxy
 *
 * Bridges stdio MCP transport to OmniCut's HTTP MCP endpoint.
 * Reads JSON-RPC messages from stdin, forwards them to the running
 * OmniCut server, and writes responses to stdout.
 *
 * Usage:
 *   bun run scripts/mcp-stdio.ts
 *
 * Environment:
 *   OMNICUT_URL — Base URL of the OmniCut server (default: http://localhost:5173)
 *
 * Claude Code MCP config (~/.claude/settings.json):
 *   {
 *     "mcpServers": {
 *       "omnicut": {
 *         "command": "bun",
 *         "args": ["run", "/path/to/OmniCut/scripts/mcp-stdio.ts"],
 *         "env": { "OMNICUT_URL": "http://localhost:5173" }
 *       }
 *     }
 *   }
 */

const OMNICUT_URL = process.env.OMNICUT_URL || 'http://localhost:5173';
const MCP_ENDPOINT = `${OMNICUT_URL}/mcp`;

let sessionId: string | undefined;

/**
 * Forward a JSON-RPC message to the OmniCut MCP HTTP endpoint.
 */
async function forwardToServer(message: unknown): Promise<void> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream'
	};
	if (sessionId) {
		headers['mcp-session-id'] = sessionId;
	}

	try {
		const response = await fetch(MCP_ENDPOINT, {
			method: 'POST',
			headers,
			body: JSON.stringify(message)
		});

		// Capture session ID from response
		const newSessionId = response.headers.get('mcp-session-id');
		if (newSessionId) {
			sessionId = newSessionId;
		}

		const contentType = response.headers.get('content-type') ?? '';

		if (contentType.includes('text/event-stream')) {
			// SSE response — parse events and write JSON-RPC messages to stdout
			const reader = response.body?.getReader();
			if (!reader) return;

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6).trim();
						if (data) {
							process.stdout.write(data + '\n');
						}
					}
				}
			}
		} else if (contentType.includes('application/json')) {
			const text = await response.text();
			if (text.trim()) {
				process.stdout.write(text + '\n');
			}
		} else if (!response.ok) {
			const errorText = await response.text();
			process.stderr.write(
				`[mcp-stdio] HTTP ${response.status}: ${errorText}\n`
			);
		}
	} catch (err) {
		process.stderr.write(
			`[mcp-stdio] Connection error: ${err instanceof Error ? err.message : String(err)}\n`
		);
		process.stderr.write(
			`[mcp-stdio] Is OmniCut running at ${OMNICUT_URL}?\n`
		);
	}
}

/**
 * Read newline-delimited JSON-RPC messages from stdin and forward them.
 */
async function main(): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = '';

	for await (const chunk of Bun.stdin.stream()) {
		buffer += decoder.decode(chunk, { stream: true });

		let newlineIdx: number;
		while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newlineIdx).trim();
			buffer = buffer.slice(newlineIdx + 1);

			if (!line) continue;

			try {
				const message = JSON.parse(line);
				await forwardToServer(message);
			} catch {
				process.stderr.write(`[mcp-stdio] Invalid JSON: ${line}\n`);
			}
		}
	}
}

main().catch((err) => {
	process.stderr.write(`[mcp-stdio] Fatal: ${err}\n`);
	process.exit(1);
});
