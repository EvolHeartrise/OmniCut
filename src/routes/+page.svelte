<script lang="ts">
	import { onMount } from 'svelte';
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
	import StreamGrid from '$lib/components/StreamGrid.svelte';
	import NLETimeline from '$lib/components/NLETimeline.svelte';
	import { refreshStreams, connectSSE, streams, focusedStreamId, soloStreamId, appMode, exportSessionFile, importSessionFile } from '$lib/stores/streams.js';

	onMount(() => {
		refreshStreams();
		const cleanup = connectSSE();
		return () => cleanup();
	});

	let mode = $derived($appMode);
	let importing = $state(false);
	let importError = $state<string | null>(null);
	let fileInput: HTMLInputElement;

	async function handleExport() {
		await exportSessionFile();
	}

	async function handleImportClick() {
		fileInput.click();
	}

	async function handleFileSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		input.value = '';
		importing = true;
		importError = null;
		try {
			const result = await importSessionFile(file);
			if (result.errors.length > 0) {
				importError = `Imported ${result.imported}/${result.total}: ${result.errors.join('; ')}`;
			}
		} catch (err) {
			importError = err instanceof Error ? err.message : 'Import failed';
		} finally {
			importing = false;
		}
	}

	// Keyboard shortcuts
	function handleKeydown(e: KeyboardEvent) {
		// TAB toggles mode — always, even in inputs
		if (e.key === 'Tab') {
			e.preventDefault();
			$appMode = $appMode === 'sources' ? 'clipping' : 'sources';
			return;
		}

		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		const activeStreams = $streams;

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
					if ($soloStreamId === stream.id) {
						// solo → unfocused
						soloStreamId.set(null);
						focusedStreamId.set(null);
					} else if ($focusedStreamId === stream.id) {
						// focused → solo
						soloStreamId.set(stream.id);
					} else {
						// unfocused → focused
						soloStreamId.set(null);
						focusedStreamId.set(stream.id);
					}
				}
				break;
			}
			case 'Escape':
				soloStreamId.set(null);
				focusedStreamId.set(null);
				break;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app">
	<header class="app-header">
		<div class="mode-tabs">
			<button
				class="mode-tab"
				class:active={mode === 'sources'}
				onclick={() => $appMode = 'sources'}
			>Sources</button>
			<button
				class="mode-tab"
				class:active={mode === 'clipping'}
				onclick={() => $appMode = 'clipping'}
			>Clipping</button>
		</div>
		<div class="header-info">
			<span class="stream-count">{$streams.length} streams</span>
			<button class="btn-tool" onclick={handleExport}>Export</button>
			<button class="btn-tool" onclick={handleImportClick} disabled={importing}>
				{importing ? 'Importing...' : 'Import'}
			</button>
			<input
				type="file"
				accept=".json"
				style="display:none"
				bind:this={fileInput}
				onchange={handleFileSelected}
			/>
			{#if importError}
				<span class="import-error">{importError}</span>
			{/if}
			<span class="shortcut-hint">Tab: Switch mode | 1-6: Focus | Esc: Unfocus</span>
		</div>
	</header>

	{#if mode === 'sources'}
		<main class="sources-content">
			<AddStreamBar />
		</main>
	{:else}
		<main class="main-content">
			<StreamGrid />
		</main>
		<NLETimeline />
	{/if}
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

	.sources-content {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 24px;
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
		transition: background 0.15s, color 0.15s;
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
		transition: background 0.15s, color 0.15s;
	}

	.btn-tool:hover {
		background: #2a2a4e;
		color: #ddd;
	}

	.btn-tool:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.import-error {
		font-size: 0.65rem;
		color: #f87171;
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.shortcut-hint {
		font-size: 0.7rem;
		color: #444;
		font-family: monospace;
	}

	.main-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}
</style>
