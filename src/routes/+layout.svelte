<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { refreshStreams, connectSSE } from '$lib/stores/streams.js';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		refreshStreams();
		const cleanup = connectSSE();
		return () => cleanup();
	});

	let pathname = $derived(page.url.pathname);

	const tabs = [
		{ href: '/watchlist', label: 'Watchlist' },
		{ href: '/library', label: 'Library' },
		{ href: '/clipping', label: 'Clipping' },
		{ href: '/clips', label: 'Clips' },
		{ href: '/review', label: 'Review' },
		{ href: '/videos', label: 'Videos' },
		{ href: '/exports', label: 'Exports' },
		{ href: '/upload', label: 'Upload' }
	];
</script>

<svelte:head>
	<title>OmniCut - Twitch Multi-Stream Director</title>
</svelte:head>

<div class="app">
	<header class="app-header">
		<nav class="mode-tabs">
			{#each tabs as tab}
				<a class="mode-tab" class:active={pathname === tab.href || pathname.startsWith(tab.href + '/')} href={tab.href}>{tab.label}</a>
			{/each}
		</nav>
	</header>

	{@render children()}
</div>

<style>
	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(html, body) {
		height: 100%;
		background: #0a0a1a;
		color: #e0e0ff;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	:global(button) {
		font-family: inherit;
	}

	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.app-header {
		display: flex;
		align-items: center;
		padding: 6px 16px;
		background: #0a0a1a;
		border-bottom: 1px solid #1a1a2e;
		gap: 8px;
	}

	.mode-tabs {
		display: flex;
		gap: 2px;
		background: #1a1a2e;
		border-radius: 6px;
		padding: 2px;
	}

	.mode-tab {
		background: none;
		border: none;
		color: #666;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 4px 12px;
		border-radius: 4px;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition:
			background 0.15s,
			color 0.15s;
		text-decoration: none;
	}

	.mode-tab:hover {
		color: #aaa;
	}

	.mode-tab.active {
		background: #7c3aed;
		color: #fff;
	}

	:global(.main-content) {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		display: flex;
	}
</style>
