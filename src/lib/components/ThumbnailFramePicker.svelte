<script lang="ts">
	import { onMount } from 'svelte';
	import { streams, clipRegions, syncOffsets } from '$lib/stores/streams.js';
	import { listExportsCmd } from '$lib/streams.remote';

	interface ExportRecord {
		id: string;
		title: string;
		clipIds: string[];
		status: string;
	}

	interface Props {
		preselectedExportId?: string | null;
		onFrameSelected: (blobUrl: string, streamId: string, timestamp: number) => void;
		onExportSelected?: (exportId: string) => void;
	}

	let { preselectedExportId = null, onFrameSelected, onExportSelected }: Props = $props();

	let exports = $state<ExportRecord[]>([]);
	let selectedExportId = $state<string | null>(null);
	let selectedClipId = $state<string | null>(null);
	let scrubValue = $state(0);
	let previewUrl = $state<string | null>(null);
	let loading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Track current preview source for "Add as Layer" button
	let previewStreamId = $state<string | null>(null);
	let previewTimestamp = $state<number>(0);

	let readyExports = $derived(exports.filter((e) => e.status === 'ready'));

	let selectedExportClips = $derived.by(() => {
		if (!selectedExportId) return [];
		const exp = readyExports.find((e) => e.id === selectedExportId);
		if (!exp) return [];
		return exp.clipIds
			.map((id) => $clipRegions.find((c) => c.id === id))
			.filter((c): c is NonNullable<typeof c> => !!c);
	});

	let selectedClip = $derived(selectedExportClips.find((c) => c.id === selectedClipId) ?? null);

	let clipLocalBounds = $derived.by(() => {
		if (!selectedClip) return null;
		const stream = $streams.find((s) => s.id === selectedClip!.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[selectedClip!.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return {
			localStart: selectedClip!.startTime - anchor + offset,
			localEnd: selectedClip!.endTime - anchor + offset
		};
	});

	let currentLocalTimestamp = $derived.by(() => {
		if (!clipLocalBounds) return 0;
		const { localStart, localEnd } = clipLocalBounds;
		return localStart + scrubValue * (localEnd - localStart);
	});

	onMount(async () => {
		try {
			const data = await listExportsCmd();
			exports = data.exports;
			if (preselectedExportId && readyExports.some((e) => e.id === preselectedExportId)) {
				selectExport(preselectedExportId!);
			}
		} catch { /* ignore */ }
	});

	function selectExport(exportId: string) {
		selectedExportId = exportId;
		selectedClipId = null;
		scrubValue = 0;
		previewUrl = null;
		previewStreamId = null;
		onExportSelected?.(exportId);
		// Auto-select first clip
		const exp = readyExports.find((e) => e.id === exportId);
		if (exp && exp.clipIds.length > 0) {
			const firstClip = $clipRegions.find((c) => c.id === exp.clipIds[0]);
			if (firstClip) {
				selectedClipId = firstClip.id;
				fetchFrame();
			}
		}
	}

	function selectClip(clipId: string) {
		selectedClipId = clipId;
		scrubValue = 0;
		fetchFrame();
	}

	function handleScrub(e: Event) {
		scrubValue = +(e.target as HTMLInputElement).value;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(fetchFrame, 150);
	}

	async function fetchFrame() {
		if (!selectedClip || !clipLocalBounds || !selectedExportId) return;
		loading = true;
		const streamId = selectedClip.streamId;
		const t = currentLocalTimestamp;
		try {
			const res = await fetch(`/api/frame/${streamId}?t=${t.toFixed(3)}`);
			if (!res.ok) throw new Error('Failed to fetch frame');
			const blob = await res.blob();
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			previewUrl = URL.createObjectURL(blob);
			previewStreamId = streamId;
			previewTimestamp = t;
		} catch (err) {
			console.error('Frame fetch error:', err);
		} finally {
			loading = false;
		}
	}

	function handleAddAsLayer() {
		if (!previewUrl || !previewStreamId) return;
		onFrameSelected(previewUrl, previewStreamId, previewTimestamp);
		// Don't revoke — the builder now owns this URL
		previewUrl = null;
		previewStreamId = null;
	}

	function getClipLabel(clip: { id: string; streamId: string; startTime: number; endTime: number; title?: string }) {
		const stream = $streams.find((s) => s.id === clip.streamId);
		const channel = stream?.channel ?? clip.streamId;
		const dur = clip.endTime - clip.startTime;
		const label = clip.title || `${channel} (${dur.toFixed(1)}s)`;
		return label;
	}
</script>

<div class="frame-picker">
	<label class="picker-label">
		Export
		<select class="picker-select" value={selectedExportId ?? ''} onchange={(e) => selectExport((e.target as HTMLSelectElement).value)}>
			<option value="" disabled>Select export...</option>
			{#each readyExports as exp (exp.id)}
				<option value={exp.id}>{exp.title}</option>
			{/each}
		</select>
	</label>

	{#if selectedExportId && selectedExportClips.length > 0}
		<div class="clip-list">
			<span class="picker-sublabel">Clips</span>
			{#each selectedExportClips as clip (clip.id)}
				<button
					class="clip-btn"
					class:active={selectedClipId === clip.id}
					onclick={() => selectClip(clip.id)}
				>
					{getClipLabel(clip)}
				</button>
			{/each}
		</div>
	{/if}

	{#if selectedClip && clipLocalBounds}
		<div class="scrub-controls">
			<span class="picker-sublabel">Timestamp</span>
			<input
				type="range"
				class="scrub-slider"
				min="0"
				max="1"
				step="0.001"
				value={scrubValue}
				oninput={handleScrub}
			/>
			<span class="scrub-time">{currentLocalTimestamp.toFixed(1)}s</span>
		</div>
	{/if}

	{#if loading}
		<div class="loading-indicator">Loading frame...</div>
	{/if}

	{#if previewUrl}
		<div class="preview-section">
			<img src={previewUrl} alt="Frame preview" class="preview-img" />
			<button class="btn-add-layer" onclick={handleAddAsLayer}>+ Add as Layer</button>
		</div>
	{/if}
</div>

<style>
	.frame-picker {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.picker-label, .picker-sublabel {
		font-size: 0.7rem;
		color: #888;
		font-weight: 500;
	}

	.picker-label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.picker-select {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		color: #e0e0ff;
		font-size: 0.8rem;
		padding: 6px 8px;
		font-family: inherit;
	}

	.picker-select:focus {
		outline: none;
		border-color: #7c3aed;
	}

	.clip-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.clip-btn {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		color: #ccc;
		font-size: 0.7rem;
		padding: 6px 10px;
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s;
	}

	.clip-btn:hover {
		border-color: #3a3a5a;
		color: #e0e0ff;
	}

	.clip-btn.active {
		border-color: #7c3aed;
		background: rgba(124, 58, 237, 0.1);
		color: #e0e0ff;
	}

	.scrub-controls {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.scrub-slider {
		width: 100%;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: #2a2a4a;
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.scrub-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		cursor: pointer;
	}

	.scrub-slider::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		border: none;
		cursor: pointer;
	}

	.scrub-time {
		font-size: 0.65rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
	}

	.loading-indicator {
		font-size: 0.7rem;
		color: #fbbf24;
	}

	.preview-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.preview-img {
		width: 100%;
		border-radius: 4px;
		border: 1px solid #2a2a4a;
	}

	.btn-add-layer {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
	}

	.btn-add-layer:hover {
		background: #6d28d9;
	}
</style>
