<script lang="ts">
	import { onDestroy } from 'svelte';
	import StreamGrid from '$lib/components/StreamGrid.svelte';
	import NLETimeline from '$lib/components/NLETimeline.svelte';
	import TranscriptPanel from '$lib/components/TranscriptPanel.svelte';
	import ChatPanel from '$lib/components/ChatPanel.svelte';
	import {
		streams,
		focusedStreamId,
		soloStreamId,
		transcriptPanelOpen,
		chatPanelOpen,
		transcriptions,
		syncOffsets,
		streamPlaybackStates,
		masterTime,
		clipRegions,
		saveClipRegion,
		type ClipRegion,
		type TranscriptionEntry
	} from '$lib/stores/streams.js';
	import { getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { trackKeyFor } from '$lib/utils.js';

	const CAPTION_WINDOW = 60;
	const CAPTION_REFETCH_THRESHOLD = 10;

	// --- Windowed caption fetch (feeds StreamTile subtitles via transcriptions store) ---
	let captionCenter = $state($masterTime);
	let captionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if ($transcriptPanelOpen) return;
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
		!$transcriptPanelOpen
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
		captionRanges.length > 0 ? await getMultiStreamTranscriptions({ ranges: captionRanges }) : []
	);

	$effect(() => {
		const data = captionResults;
		if (!data || $transcriptPanelOpen) return;
		const grouped: Record<string, TranscriptionEntry[]> = {};
		for (const r of data) {
			if (!grouped[r.streamId]) grouped[r.streamId] = [];
			grouped[r.streamId].push({ id: r.id, text: r.text, startTime: r.startTime, endTime: r.endTime });
		}
		transcriptions.set(grouped);
	});

	// T-key hold state for transcription-based clip region creation
	let tHeld = $state(false);
	let tClipId = $state<string | null>(null);
	let tClipStreamId = $state<string | null>(null);

	// Save in-progress clip if user navigates away mid-hold
	onDestroy(() => {
		if (tHeld && tClipId) {
			const regions = $clipRegions;
			const region = regions.find((r) => r.id === tClipId);
			if (region) saveClipRegion(region);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
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

					const focusedSrc = $focusedStreamId ? activeStreams.find((s) => s.id === $focusedStreamId) : null;
					const soloSrc = $soloStreamId ? activeStreams.find((s) => s.id === $soloStreamId) : null;
					const focusedKey = focusedSrc ? trackKeyFor(focusedSrc) : null;
					const soloKey = soloSrc ? trackKeyFor(soloSrc) : null;

					if (soloKey === trackKey) {
						soloStreamId.set(null);
						focusedStreamId.set(null);
					} else if (focusedKey === trackKey) {
						soloStreamId.set(target.id);
					} else {
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
				const focused = $focusedStreamId || $soloStreamId;
				if (focused) {
					const stream = $streams.find((s) => s.id === focused);
					const entries = $transcriptions[focused];
					if (stream && entries && entries.length > 0) {
						const now = $masterTime;
						const anchor = stream.startedAt / 1000;
						const offset = $syncOffsets[focused] || 0;
						let entry = entries.find((ent) => {
							const ms = ent.startTime + anchor - offset;
							const me = ent.endTime + anchor - offset;
							return now >= ms && now < me;
						});
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
			if (tClipId) {
				const regions = $clipRegions;
				const region = regions.find((r) => r.id === tClipId);
				if (region) saveClipRegion(region);
			}
			tClipId = null;
			tClipStreamId = null;
		}
	}

	// While T is held, extend the in-progress clip region
	$effect(() => {
		if (!tHeld || !tClipId || !tClipStreamId) return;
		const now = $masterTime;
		const stream = $streams.find((s) => s.id === tClipStreamId);
		const entries = $transcriptions[tClipStreamId!];
		if (!stream || !entries) return;
		const anchor = stream.startedAt / 1000;
		const offset = $syncOffsets[tClipStreamId!] || 0;

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
