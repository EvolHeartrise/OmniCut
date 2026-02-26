import type { RequestHandler } from './$types';
import { handleAuthCallback } from '$lib/server/youtubeClient.js';

export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');

	if (error) {
		return new Response(errorPage(`Authorization denied: ${error}`), {
			headers: { 'Content-Type': 'text/html' }
		});
	}

	if (!code) {
		return new Response(errorPage('No authorization code received'), {
			status: 400,
			headers: { 'Content-Type': 'text/html' }
		});
	}

	try {
		await handleAuthCallback(code);
		return new Response(successPage(), {
			headers: { 'Content-Type': 'text/html' }
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[youtube-callback] Auth callback failed:', message);
		return new Response(errorPage(message), {
			status: 500,
			headers: { 'Content-Type': 'text/html' }
		});
	}
};

function successPage(): string {
	return `<!DOCTYPE html>
<html>
<head><title>YouTube Connected</title></head>
<body style="background:#0a0a1a;color:#e0e0ff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h2>YouTube account connected!</h2>
<p style="color:#888">This window will close automatically.</p>
</div>
<script>
if (window.opener) {
	window.opener.postMessage({ type: 'youtube-auth-success' }, '*');
}
setTimeout(() => window.close(), 1500);
</script>
</body>
</html>`;
}

function errorPage(message: string): string {
	const escaped = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<!DOCTYPE html>
<html>
<head><title>YouTube Auth Error</title></head>
<body style="background:#0a0a1a;color:#e0e0ff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h2 style="color:#f87171">Authentication Failed</h2>
<p style="color:#888">${escaped}</p>
<p style="color:#666;font-size:0.85rem">You can close this window.</p>
</div>
</body>
</html>`;
}
