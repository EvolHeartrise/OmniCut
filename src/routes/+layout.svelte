<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { refreshStreams, connectSSE, streams, transcriptPanelOpen, chatPanelOpen } from '$lib/stores/streams.js';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		refreshStreams();
		const cleanup = connectSSE();
		return () => cleanup();
	});

	let pathname = $derived(page.url.pathname);
	let isClipping = $derived(pathname === '/clipping');

	const tabs = [
		{ href: '/browse', label: 'Browse' },
		{ href: '/library', label: 'Library' },
		{ href: '/clipping', label: 'Clipping' },
		{ href: '/clips', label: 'Clips' },
		{ href: '/review', label: 'Review' },
		{ href: '/exports', label: 'Exports' }
	];
</script>

<svelte:head>
	<title>OmniCut - Twitch Multi-Stream Director</title>
</svelte:head>

<div class="app">
	<header class="app-header">
		<nav class="mode-tabs">
			{#each tabs as tab}
				<a class="mode-tab" class:active={pathname === tab.href} href={tab.href}>{tab.label}</a>
			{/each}
		</nav>
		<div class="header-info">
			<span class="stream-count">{$streams.length} streams</span>
			{#if isClipping}
				<button
					class="btn-tool"
					class:btn-tool-active={$transcriptPanelOpen}
					onclick={() => ($transcriptPanelOpen = !$transcriptPanelOpen)}>Transcript</button
				>
				<button
					class="btn-tool"
					class:btn-tool-active={$chatPanelOpen}
					onclick={() => ($chatPanelOpen = !$chatPanelOpen)}>Chat</button
				>
			{/if}
			<span class="shortcut-hint">1-6: Focus | Esc: Unfocus | T (hold): Clip transcript | P: Transcript | C: Chat</span>
		</div>
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

	.header-info {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-shrink: 0;
		margin-left: auto;
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

	.stream-count {
		font-size: 0.8rem;
		color: #888;
	}

	.btn-tool {
		background: #1a1a2e;
		border: 1px solid #2a2a3e;
		color: #aaa;
		font-size: 0.7rem;
		padding: 3px 10px;
		border-radius: 4px;
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.btn-tool:hover {
		background: #2a2a4e;
		color: #ddd;
	}

	.btn-tool-active {
		background: #7c3aed;
		color: #fff;
		border-color: #7c3aed;
	}

	.btn-tool-active:hover {
		background: #6d28d9;
		color: #fff;
	}

	.shortcut-hint {
		font-size: 0.7rem;
		color: #444;
		font-family: monospace;
	}

	:global(.main-content) {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}
</style>
