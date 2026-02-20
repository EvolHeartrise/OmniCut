<script lang="ts">
	import { onMount } from 'svelte';
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
	import DiscoveryBrowser from '$lib/components/DiscoveryBrowser.svelte';
	import StreamGrid from '$lib/components/StreamGrid.svelte';
	import NLETimeline from '$lib/components/NLETimeline.svelte';
	import CleaningTimeline from '$lib/components/CleaningTimeline.svelte';
	import ExportPanel from '$lib/components/ExportPanel.svelte';
	import TranscriptPanel from '$lib/components/TranscriptPanel.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import { refreshStreams, connectSSE, streams, focusedStreamId, soloStreamId, appMode, transcriptPanelOpen, chatPanelOpen, exportSessionFile, importSessionFile, clearSession, transcriptions, syncOffsets, masterTime, clipRegions, saveClipRegion, type ClipRegion } from '$lib/stores/streams.js';

	onMount(() => {
		refreshStreams();
		const cleanup = connectSSE();
		return () => cleanup();
	});

	let mode = $derived($appMode);
	let importing = $state(false);
	let importError = $state<string | null>(null);
	let fileInput: HTMLInputElement;
	let clearConfirm = $state(false);
	let clearConfirmTimer: ReturnType<typeof setTimeout> | undefined;

	// T-key hold state for transcription-based clip region creation
	let tHeld = $state(false);
	let tClipId = $state<string | null>(null);
	let tClipStreamId = $state<string | null>(null);

	async function handleExport() {
		await exportSessionFile();
	}

	async function handleClearSession() {
		if (!clearConfirm) {
			clearConfirm = true;
			clearConfirmTimer = setTimeout(() => { clearConfirm = false; }, 3000);
			return;
		}
		clearTimeout(clearConfirmTimer);
		clearConfirm = false;
		await clearSession();
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
			const modes: Array<typeof $appMode> = ['sources', 'clipping', 'cleaning', 'export'];
			const idx = modes.indexOf($appMode);
			$appMode = modes[(idx + 1) % modes.length];
			return;
		}

		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if ($appMode !== 'clipping') return;

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
			case 't':
			case 'T': {
				if (e.repeat || tHeld) break;
				// Start a held clip region from the current or recent transcription
				const focused = $focusedStreamId || $soloStreamId;
				if (focused) {
					const stream = $streams.find((s) => s.id === focused);
					const entries = $transcriptions[focused];
					if (stream && entries && entries.length > 0) {
						const now = $masterTime;
						const anchor = stream.startedAt / 1000;
						const offset = $syncOffsets[focused] || 0;
						// Find active transcription at playhead
						let entry = entries.find((ent) => {
							const ms = ent.startTime + anchor - offset;
							const me = ent.endTime + anchor - offset;
							return now >= ms && now < me;
						});
						// Fallback: most recent past transcription within 5 seconds
						if (!entry) {
							for (let i = entries.length - 1; i >= 0; i--) {
								const me = entries[i].endTime + anchor - offset;
								if (me <= now && now - me <= 5) {
									entry = entries[i];
									break;
								}
							}
						}
						if (entry) {
							const region: ClipRegion = {
								id: crypto.randomUUID(),
								streamId: focused,
								startTime: entry.startTime + anchor - offset,
								endTime: entry.endTime + anchor - offset
							};
							clipRegions.update((regions) => [...regions, region]);
							tHeld = true;
							tClipId = region.id;
							tClipStreamId = focused;
						}
					}
				}
				break;
			}
			case 'p':
			case 'P':
				transcriptPanelOpen.update((v) => !v);
				break;
			case 'c':
			case 'C':
				chatPanelOpen.update((v) => !v);
				break;
		}
	}

	function handleKeyup(e: KeyboardEvent) {
		if ((e.key === 't' || e.key === 'T') && tHeld) {
			tHeld = false;
			// Persist the finalized clip region to the server
			if (tClipId) {
				const regions = $clipRegions;
				const region = regions.find((r) => r.id === tClipId);
				if (region) saveClipRegion(region);
			}
			tClipId = null;
			tClipStreamId = null;
		}
	}

	// While T is held, extend the in-progress clip region as the playhead crosses new transcriptions
	$effect(() => {
		if (!tHeld || !tClipId || !tClipStreamId) return;
		const now = $masterTime;
		const stream = $streams.find((s) => s.id === tClipStreamId);
		const entries = $transcriptions[tClipStreamId!];
		if (!stream || !entries) return;
		const anchor = stream.startedAt / 1000;
		const offset = $syncOffsets[tClipStreamId!] || 0;

		// Find the latest transcription whose start the playhead has passed
		let latestEnd = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			const ms = entries[i].startTime + anchor - offset;
			const me = entries[i].endTime + anchor - offset;
			if (now >= ms) {
				latestEnd = me;
				break;
			}
		}
		if (latestEnd < 0) return;

		const clipId = tClipId;
		clipRegions.update((regions) => {
			const idx = regions.findIndex((r) => r.id === clipId);
			if (idx === -1) return regions;
			const existing = regions[idx];
			if (latestEnd <= existing.endTime) return regions;
			const updated = [...regions];
			updated[idx] = { ...existing, endTime: latestEnd };
			return updated;
		});
	});
</script>

<svelte:window onkeydown={handleKeydown} onkeyup={handleKeyup} />

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
			<button
				class="mode-tab"
				class:active={mode === 'cleaning'}
				onclick={() => $appMode = 'cleaning'}
			>Cleaning</button>
			<button
				class="mode-tab"
				class:active={mode === 'export'}
				onclick={() => $appMode = 'export'}
			>Export</button>
		</div>
		<div class="header-info">
			<span class="stream-count">{$streams.length} streams</span>
			<button class="btn-tool" onclick={handleExport}>Save Session</button>
			<button class="btn-tool" onclick={handleImportClick} disabled={importing}>
				{importing ? 'Loading...' : 'Load Session'}
			</button>
			<button
				class="btn-tool btn-danger"
				onclick={handleClearSession}
			>{clearConfirm ? 'Are you sure?' : 'Clear Session'}</button>
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
			{#if mode === 'clipping'}
				<button
					class="btn-tool"
					class:btn-tool-active={$transcriptPanelOpen}
					onclick={() => $transcriptPanelOpen = !$transcriptPanelOpen}
				>Transcript</button>
				<button
					class="btn-tool"
					class:btn-tool-active={$chatPanelOpen}
					onclick={() => $chatPanelOpen = !$chatPanelOpen}
				>Chat</button>
			{/if}
			<span class="shortcut-hint">Tab: Switch mode | 1-6: Focus | Esc: Unfocus | T (hold): Clip transcript | P: Transcript | C: Chat</span>
		</div>
	</header>

	{#if mode === 'sources'}
		<main class="sources-content">
			<AddStreamBar />
			<DiscoveryBrowser />
		</main>
	{:else if mode === 'clipping'}
		<main class="main-content">
			<StreamGrid />
			{#if $transcriptPanelOpen}
				<TranscriptPanel />
			{/if}
			{#if $chatPanelOpen}
				<ChatPanel />
			{/if}
		</main>
		<NLETimeline />
	{:else if mode === 'cleaning'}
		<main class="main-content">
			<CleaningTimeline />
		</main>
	{:else if mode === 'export'}
		<main class="main-content">
			<ExportPanel />
		</main>
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
		display: flex;
		gap: 24px;
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

	.btn-danger:hover {
		background: #7f1d1d;
		border-color: #991b1b;
		color: #fca5a5;
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
