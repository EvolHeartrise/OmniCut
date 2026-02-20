<script lang="ts">
	import { onMount } from 'svelte';
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
	import DiscoveryBrowser from '$lib/components/DiscoveryBrowser.svelte';
	import MediaLibrary from '$lib/components/MediaLibrary.svelte';
	import StreamGrid from '$lib/components/StreamGrid.svelte';
	import NLETimeline from '$lib/components/NLETimeline.svelte';
	import CleaningTimeline from '$lib/components/CleaningTimeline.svelte';
	import ExportPanel from '$lib/components/ExportPanel.svelte';
	import TranscriptPanel from '$lib/components/TranscriptPanel.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import { refreshStreams, connectSSE, streams, focusedStreamId, soloStreamId, appMode, transcriptPanelOpen, chatPanelOpen, transcriptions, syncOffsets, streamPlaybackStates, masterTime, clipRegions, saveClipRegion, type ClipRegion, type TranscriptionEntry } from '$lib/stores/streams.js';
	import { getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { trackKeyFor } from '$lib/utils.js';

	const CAPTION_WINDOW = 60; // ±60 seconds around playhead for StreamTile captions
	const CAPTION_REFETCH_THRESHOLD = 10; // re-fetch when playhead drifts 10s

	onMount(() => {
		refreshStreams();
		const cleanup = connectSSE();
		return () => cleanup();
	});

	let mode = $derived($appMode);

	// --- Windowed caption fetch (feeds StreamTile subtitles via transcriptions store) ---

	let captionCenter = $state($masterTime);
	let captionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if ($appMode !== 'clipping') return;
		const now = $masterTime;
		if (Math.abs(now - captionCenter) >= CAPTION_REFETCH_THRESHOLD && !captionDebounceTimer) {
			const snap = now;
			captionDebounceTimer = setTimeout(() => {
				captionDebounceTimer = null;
				captionCenter = snap;
			}, 300);
		}
		return () => {
			if (captionDebounceTimer) {
				clearTimeout(captionDebounceTimer);
				captionDebounceTimer = null;
			}
		};
	});

	let captionRanges = $derived(
		$appMode === 'clipping'
			? $streams.map((s) => {
					const anchor = s.startedAt / 1000;
					const offset = $syncOffsets[s.id] || 0;
					const localCenter = captionCenter - anchor + offset;
					return {
						streamId: s.id,
						from: Math.max(0, localCenter - CAPTION_WINDOW),
						to: localCenter + CAPTION_WINDOW
					};
				})
			: []
	);

	const captionResults = $derived(
		captionRanges.length > 0
			? await getMultiStreamTranscriptions({ ranges: captionRanges })
			: []
	);

	// Push windowed caption data into the transcriptions store for StreamTile
	$effect(() => {
		const data = captionResults;
		if (!data) return;
		const grouped: Record<string, TranscriptionEntry[]> = {};
		for (const r of data) {
			if (!grouped[r.streamId]) grouped[r.streamId] = [];
			grouped[r.streamId].push({ text: r.text, startTime: r.startTime, endTime: r.endTime });
		}
		transcriptions.set(grouped);
	});
	let sourcesTab = $state<'library' | 'browse'>('browse');

	// T-key hold state for transcription-based clip region creation
	let tHeld = $state(false);
	let tClipId = $state<string | null>(null);
	let tClipStreamId = $state<string | null>(null);

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
				// Build ordered unique track keys (same grouping as NLETimeline/StreamGrid)
				const seen = new Set<string>();
				const tKeys: string[] = [];
				const tMembers = new Map<string, typeof activeStreams>();
				for (const s of activeStreams) {
					const key = trackKeyFor(s);
					if (!seen.has(key)) {
						seen.add(key);
						tKeys.push(key);
						tMembers.set(key, []);
					}
					tMembers.get(key)!.push(s);
				}

				if (idx < tKeys.length) {
					const trackKey = tKeys[idx];
					const members = tMembers.get(trackKey)!;

					// Pick the best stream: the one whose time range contains the playhead
					let target = members[0];
					for (const s of members) {
						const pb = $streamPlaybackStates[s.id];
						if (pb && pb.duration > 0) {
							const offset = $syncOffsets[s.id] || 0;
							const anchor = s.startedAt / 1000;
							if ($masterTime >= anchor - offset && $masterTime <= anchor + pb.duration - offset) {
								target = s;
								break;
							}
						}
					}

					// Check if this track is already focused/solo'd
					const focusedSrc = $focusedStreamId ? activeStreams.find((s) => s.id === $focusedStreamId) : null;
					const soloSrc = $soloStreamId ? activeStreams.find((s) => s.id === $soloStreamId) : null;
					const focusedKey = focusedSrc ? trackKeyFor(focusedSrc) : null;
					const soloKey = soloSrc ? trackKeyFor(soloSrc) : null;

					if (soloKey === trackKey) {
						// solo → unfocused
						soloStreamId.set(null);
						focusedStreamId.set(null);
					} else if (focusedKey === trackKey) {
						// focused → solo
						soloStreamId.set(target.id);
					} else {
						// unfocused → focused
						soloStreamId.set(null);
						focusedStreamId.set(target.id);
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
			<div class="sources-tabs">
				<button class="sources-tab" class:active={sourcesTab === 'library'} onclick={() => sourcesTab = 'library'}>Library</button>
				<button class="sources-tab" class:active={sourcesTab === 'browse'} onclick={() => sourcesTab = 'browse'}>Browse</button>
			</div>
			{#if sourcesTab === 'library'}
				<MediaLibrary />
			{:else}
				<AddStreamBar />
				<DiscoveryBrowser />
			{/if}
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
		overflow: hidden;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.sources-tabs {
		display: flex;
		gap: 2px;
		background: #1a1a2e;
		border-radius: 6px;
		padding: 2px;
		align-self: flex-start;
		flex-shrink: 0;
	}

	.sources-tab {
		background: none;
		border: none;
		color: #666;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 4px 14px;
		border-radius: 4px;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition: background 0.15s, color 0.15s;
	}

	.sources-tab:hover {
		color: #aaa;
	}

	.sources-tab.active {
		background: #7c3aed;
		color: #fff;
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

	.main-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}
</style>
