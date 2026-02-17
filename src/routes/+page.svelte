<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
	import StreamGrid from '$lib/components/StreamGrid.svelte';
	import { refreshStreams, connectSSE, streams, focusedStreamId } from '$lib/stores/streams.js';

	let cleanupSSE: (() => void) | null = null;

	onMount(async () => {
		await refreshStreams();
		cleanupSSE = connectSSE();
	});

	onDestroy(() => {
		cleanupSSE?.();
	});

	// Keyboard shortcuts
	function handleKeydown(e: KeyboardEvent) {
		// Don't handle if user is typing in an input
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		const activeStreams = $streams.filter((s) => s.status !== 'stopped');

		switch (e.key) {
			case '1':
			case '2':
			case '3':
			case '4':
			case '5':
			case '6': {
				const idx = parseInt(e.key) - 1;
				if (idx < activeStreams.length) {
					const stream = activeStreams[idx];
					focusedStreamId.update((current) =>
						current === stream.id ? null : stream.id
					);
				}
				break;
			}
			case 'Escape':
				focusedStreamId.set(null);
				break;
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="app">
	<header class="app-header">
		<div class="brand">
			<h1>OmniCut</h1>
			<span class="tagline">Multi-Stream Director</span>
		</div>
		<div class="header-info">
			<span class="stream-count">{$streams.filter((s) => s.status !== 'stopped').length} streams</span>
			<span class="shortcut-hint">1-6: Focus | Esc: Unfocus</span>
		</div>
	</header>

	<AddStreamBar />

	<main class="main-content">
		<StreamGrid />
	</main>
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.app-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 16px;
		background: #0a0a1a;
		border-bottom: 1px solid #1a1a2e;
	}

	.brand {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	h1 {
		font-size: 1.3rem;
		font-weight: 800;
		background: linear-gradient(135deg, #7c3aed, #a78bfa);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.tagline {
		font-size: 0.8rem;
		color: #555;
		font-weight: 400;
	}

	.header-info {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.stream-count {
		font-size: 0.8rem;
		color: #888;
	}

	.shortcut-hint {
		font-size: 0.7rem;
		color: #444;
		font-family: monospace;
	}

	.main-content {
		flex: 1;
		overflow-y: auto;
	}
</style>
