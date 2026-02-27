<script lang="ts">
	import Hls from 'hls.js';
	import { goto } from '$app/navigation';
	import {
		streams,
		syncOffsets,
		clipRegions,
		saveClipRegion,
		deleteClipRegion,
		type ClipRegion
	} from '$lib/stores/streams.js';
	import { formatDuration, formatEpochDate, getClipLocalBounds, setupHls } from '$lib/utils.js';
	import { exportSelectedClipsCmd, createVideoCmd, loadCameraBoundsForChannel } from '$lib/streams.remote';
	import type { CameraBoundsEntry } from '$lib/types.js';

	// --- Filter state ---
	let filterChannel = $state<string>('');
	let filterCreator = $state<'' | 'ai' | 'human'>('');
	let filterFavourite = $state(false);
	let filterAfter = $state('');
	let filterBefore = $state('');

	// --- Delete confirmation ---
	let deleteConfirmId = $state<string | null>(null);
	let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Selection ---
	let selectedIds = $state<Set<string>>(new Set());

	// --- Editing ---
	let editingId = $state<string | null>(null);
	let editTitle = $state('');
	let editNotes = $state('');

	// --- Preview ---
	let previewClipId = $state<string | null>(null);
	let previewClip = $derived($clipRegions.find((c) => c.id === previewClipId) ?? null);
	let previewVideoEl = $state<HTMLVideoElement | null>(null);
	let previewHls: Hls | null = null;
	let previewPlaying = $state(false);
	let previewProgress = $state(0); // 0-1 within clip bounds
	let previewCurrentTime = $state('0:00');
	let previewDuration = $state('0:00');
	let isSeeking = $state(false);

	// --- Stream lookup map (avoids O(n²) .find() in filters/deriveds) ---
	let streamMap = $derived(new Map($streams.map((s) => [s.id, s])));

	// --- Channel camera bounds (loaded per-channel for CAM badge + export warnings) ---
	let channelBoundsMap = $state<Record<string, CameraBoundsEntry[]>>({});

	/** Resolve camera bounds for a clip (find most recent entry at or before clip.startTime). */
	function resolveClipCamBounds(clip: ClipRegion): CameraBoundsEntry | null {
		const stream = streamMap.get(clip.streamId);
		if (!stream) return null;
		const entries = channelBoundsMap[stream.channel];
		if (!entries || entries.length === 0) return null;
		// entries are sorted by timestamp ascending — find last one <= clip.startTime
		let best: CameraBoundsEntry | null = null;
		for (const e of entries) {
			if (e.timestamp <= clip.startTime) best = e;
			else break;
		}
		return best;
	}

	// Load camera bounds for all relevant channels when clips change
	$effect(() => {
		const channels = new Set<string>();
		for (const clip of $clipRegions) {
			const stream = streamMap.get(clip.streamId);
			if (stream) channels.add(stream.channel);
		}
		for (const ch of channels) {
			if (!(ch in channelBoundsMap)) {
				loadCameraBoundsForChannel({ channel: ch })
					.then((result) => {
						channelBoundsMap = { ...channelBoundsMap, [ch]: result.bounds };
					})
					.catch(() => {});
			}
		}
	});

	// --- Video & Export creation ---
	let exportTitle = $state('');
	let exportFormat = $state<'standard' | 'mobile_short' | 'chat_overlay'>('standard');
	let exporting = $state(false);
	let creatingVideo = $state(false);
	let exportResult = $state<{ success: boolean; message: string } | null>(null);

	// Count selected clips missing cam regions (relevant for mobile_short)
	let missingCamCount = $derived.by(() => {
		if (exportFormat !== 'mobile_short') return 0;
		let count = 0;
		for (const clip of filteredClips) {
			if (selectedIds.has(clip.id) && !resolveClipCamBounds(clip)) count++;
		}
		return count;
	});

	// Unique channels for the filter dropdown
	let uniqueChannels = $derived.by(() => {
		const channels = new Set<string>();
		for (const clip of $clipRegions) {
			const stream = streamMap.get(clip.streamId);
			if (stream) channels.add(stream.channel);
		}
		return [...channels].sort();
	});

	// Filtered + sorted clips
	let filteredClips = $derived.by(() => {
		let clips = [...$clipRegions];

		// Filter by channel
		if (filterChannel) {
			clips = clips.filter((c) => streamMap.get(c.streamId)?.channel === filterChannel);
		}

		// Filter by creator
		if (filterCreator) {
			clips = clips.filter((c) => (c.createdBy ?? 'human') === filterCreator);
		}

		// Filter by favourite
		if (filterFavourite) {
			clips = clips.filter((c) => c.favourite);
		}

		// Filter by time (ISO date strings → epoch seconds)
		if (filterAfter) {
			const afterEpoch = new Date(filterAfter).getTime() / 1000;
			if (!isNaN(afterEpoch)) {
				clips = clips.filter((c) => c.endTime > afterEpoch);
			}
		}
		if (filterBefore) {
			const beforeEpoch = new Date(filterBefore).getTime() / 1000;
			if (!isNaN(beforeEpoch)) {
				clips = clips.filter((c) => c.startTime < beforeEpoch);
			}
		}

		clips.sort((a, b) => a.startTime - b.startTime);
		return clips;
	});

	let totalSelectedDuration = $derived.by(() => {
		let total = 0;
		for (const clip of filteredClips) {
			if (selectedIds.has(clip.id)) {
				total += clip.endTime - clip.startTime;
			}
		}
		return total;
	});

	// --- Selection helpers ---
	function toggleSelect(id: string) {
		selectedIds = new Set(selectedIds);
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
		} else {
			selectedIds.add(id);
		}
	}

	function selectAll() {
		selectedIds = new Set(filteredClips.map((c) => c.id));
	}

	function selectNone() {
		selectedIds = new Set();
	}

	let allSelected = $derived(filteredClips.length > 0 && filteredClips.every((c) => selectedIds.has(c.id)));

	// --- Editing ---
	function startEdit(clip: ClipRegion) {
		editingId = clip.id;
		editTitle = clip.title || '';
		editNotes = clip.notes || '';
	}

	function cancelEdit() {
		editingId = null;
	}

	function saveEdit() {
		if (!editingId) return;
		const clip = $clipRegions.find((c) => c.id === editingId);
		if (!clip) return;
		const updated = { ...clip, title: editTitle || undefined, notes: editNotes || undefined };
		clipRegions.update((regions) => regions.map((r) => (r.id === updated.id ? updated : r)));
		saveClipRegion(updated);
		editingId = null;
	}

	// --- Approve (AI → Human) ---
	function approveClip(clip: ClipRegion) {
		const updated = { ...clip, createdBy: 'human' as const };
		saveClipRegion(updated);
	}

	// --- Toggle favourite ---
	function toggleFavourite(clip: ClipRegion) {
		const updated = { ...clip, favourite: !clip.favourite };
		clipRegions.update((regions) => regions.map((r) => (r.id === updated.id ? updated : r)));
		saveClipRegion(updated);
	}

	// --- Delete (double-press) ---
	function handleDelete(id: string) {
		if (deleteConfirmId === id) {
			// Second press — actually delete
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmTimer = null;
			deleteConfirmId = null;
			if (previewClipId === id) closePreview();
			deleteClipRegion(id);
			selectedIds = new Set([...selectedIds].filter((s) => s !== id));
		} else {
			// First press — arm confirmation
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmId = id;
			deleteConfirmTimer = setTimeout(() => {
				deleteConfirmId = null;
				deleteConfirmTimer = null;
			}, 3000);
		}
	}

	// --- Copy clip ID ---
	function copyClipId(id: string) {
		navigator.clipboard.writeText(id);
	}

	// --- Preview ---
	function openPreview(clip: ClipRegion) {
		// Close existing preview if different
		if (previewClipId === clip.id) {
			closePreview();
			return;
		}
		previewClipId = clip.id;
		previewPlaying = false;
		previewProgress = 0;
		previewCurrentTime = '0:00';
		const clipDur = clip.endTime - clip.startTime;
		previewDuration = formatDuration(clipDur);

		// Wait for DOM to render the video element
		requestAnimationFrame(() => {
			setupPreviewPlayer(clip);
		});
	}

	function setupPreviewPlayer(clip: ClipRegion) {
		if (!previewVideoEl) return;
		const bounds = clipLocalBounds(clip);
		if (!bounds) return;

		if (previewHls) {
			previewHls.destroy();
			previewHls = null;
		}

		const url = `/hls/${clip.streamId}/playlist.m3u8`;

		previewHls = setupHls(Hls, previewVideoEl, url, bounds.localStart, () => {
			previewVideoEl!.play().then(() => { previewPlaying = true; }).catch(() => {});
		});
	}

	function closePreview() {
		if (previewHls) {
			previewHls.destroy();
			previewHls = null;
		}
		previewClipId = null;
		previewPlaying = false;
	}

	function togglePreviewPlay() {
		if (!previewVideoEl) return;
		if (previewPlaying) {
			previewVideoEl.pause();
		} else {
			previewVideoEl.play().catch(() => {});
		}
		previewPlaying = !previewPlaying;
	}

	function clipLocalBounds(clip: ClipRegion) {
		return getClipLocalBounds(clip, streamMap.get(clip.streamId), $syncOffsets[clip.streamId] || 0);
	}


	// Clamp preview playback to clip bounds + update progress
	function handlePreviewTimeUpdate() {
		if (!previewVideoEl || !previewClip) return;
		const bounds = clipLocalBounds(previewClip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;

		if (previewVideoEl.currentTime >= localEnd) {
			previewVideoEl.pause();
			previewPlaying = false;
			previewVideoEl.currentTime = localStart;
			previewProgress = 0;
			previewCurrentTime = '0:00';
		} else if (!isSeeking) {
			const elapsed = previewVideoEl.currentTime - localStart;
			previewProgress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			previewCurrentTime = formatDuration(elapsed);
		}
		previewDuration = formatDuration(clipDur);
	}

	function handleSeekInput(e: Event) {
		isSeeking = true;
		const value = +(e.target as HTMLInputElement).value;
		previewProgress = value;
		if (previewClip) {
			const bounds = clipLocalBounds(previewClip);
			if (bounds) {
				const elapsed = value * (bounds.localEnd - bounds.localStart);
				previewCurrentTime = formatDuration(elapsed);
			}
		}
	}

	function handleSeekCommit() {
		if (!previewVideoEl || !previewClip) {
			isSeeking = false;
			return;
		}
		const bounds = clipLocalBounds(previewClip);
		if (!bounds) {
			isSeeking = false;
			return;
		}
		const { localStart, localEnd } = bounds;
		previewVideoEl.currentTime = localStart + previewProgress * (localEnd - localStart);
		isSeeking = false;
	}

	// --- Create Video ---
	async function createVideo() {
		const selectedClipIds = filteredClips.filter((c) => selectedIds.has(c.id)).map((c) => c.id);
		if (selectedClipIds.length === 0) return;
		const title = exportTitle.trim() || `Video ${new Date().toISOString().slice(0, 16)}`;
		creatingVideo = true;
		exportResult = null;
		try {
			const video = await createVideoCmd({ clipIds: selectedClipIds, title, format: exportFormat });
			goto(`/videos/${video.id}`);
		} catch (err) {
			exportResult = { success: false, message: err instanceof Error ? err.message : 'Failed to create video' };
		} finally {
			creatingVideo = false;
		}
	}

	// --- Quick Export (legacy one-click path) ---
	async function createExport() {
		const selectedClipIds = filteredClips.filter((c) => selectedIds.has(c.id)).map((c) => c.id);
		if (selectedClipIds.length === 0) return;
		const title = exportTitle.trim() || `Export ${new Date().toISOString().slice(0, 16)}`;
		exporting = true;
		exportResult = null;
		try {
			const data = await exportSelectedClipsCmd({ clipIds: selectedClipIds, title, format: exportFormat });
			exportResult = { success: true, message: `Export "${title}" queued (ID: ${data.exportId})` };
			exportTitle = '';
		} catch (err) {
			exportResult = { success: false, message: err instanceof Error ? err.message : 'Failed' };
		} finally {
			exporting = false;
		}
	}

	// React to clip bounds changing while previewing (e.g. MCP upsert_clip via SSE)
	$effect(() => {
		const clip = previewClip;
		if (!clip || !previewVideoEl) return;
		const bounds = clipLocalBounds(clip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;
		previewDuration = formatDuration(clipDur);

		// If the video's current position is now outside the new bounds, re-clamp
		if (previewVideoEl.currentTime >= localEnd) {
			previewVideoEl.currentTime = localStart;
			previewProgress = 0;
			previewCurrentTime = '0:00';
			if (previewPlaying) {
				previewVideoEl.pause();
				previewPlaying = false;
			}
		} else if (previewVideoEl.currentTime < localStart) {
			previewVideoEl.currentTime = localStart;
			previewProgress = 0;
			previewCurrentTime = '0:00';
		} else {
			// Recalculate progress within new bounds
			const elapsed = previewVideoEl.currentTime - localStart;
			previewProgress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			previewCurrentTime = formatDuration(elapsed);
		}
	});

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (previewHls) {
				previewHls.destroy();
				previewHls = null;
			}
		};
	});


	function clipChannel(clip: ClipRegion): string {
		return streamMap.get(clip.streamId)?.channel || 'unknown';
	}
</script>

<div class="clips-panel">
	<!-- Filters bar -->
	<div class="filters-bar">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="filter-group">
			<span class="filter-label">Channel</span>
			<select class="filter-select" bind:value={filterChannel}>
				<option value="">All channels</option>
				{#each uniqueChannels as ch}
					<option value={ch}>{ch}</option>
				{/each}
			</select>
		</label>
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="filter-group">
			<span class="filter-label">Creator</span>
			<select class="filter-select" bind:value={filterCreator}>
				<option value="">All</option>
				<option value="ai">AI</option>
				<option value="human">Human</option>
			</select>
		</label>
		<button
			class="filter-fav-btn"
			class:active={filterFavourite}
			onclick={() => (filterFavourite = !filterFavourite)}
			title="Show favourites only"
		>&#9733;</button>
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="filter-group">
			<span class="filter-label">After</span>
			<input type="datetime-local" class="filter-input" bind:value={filterAfter} />
		</label>
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="filter-group">
			<span class="filter-label">Before</span>
			<input type="datetime-local" class="filter-input" bind:value={filterBefore} />
		</label>
		<div class="filter-spacer"></div>
		<span class="clip-count">{filteredClips.length} clip{filteredClips.length !== 1 ? 's' : ''}</span>
	</div>

	<div class="clips-body">
		<!-- Clip list -->
		<div class="clip-list">
			<!-- Selection toolbar -->
			<div class="selection-bar">
				<label class="select-all-label">
					<input type="checkbox" checked={allSelected} onchange={() => (allSelected ? selectNone() : selectAll())} />
					{#if selectedIds.size > 0}
						{selectedIds.size} selected ({formatDuration(totalSelectedDuration)})
					{:else}
						Select all
					{/if}
				</label>
				{#if selectedIds.size > 0}
					<div class="export-inline">
						<input
							type="text"
							class="export-title-input"
							bind:value={exportTitle}
							placeholder="Title..."
							onkeydown={(e) => {
								if (e.key === 'Enter') createVideo();
							}}
						/>
						<select class="format-select" bind:value={exportFormat}>
							<option value="standard">Standard (16:9)</option>
							<option value="mobile_short">Mobile Short (9:16)</option>
							<option value="chat_overlay">Chat Overlay (transparent)</option>
						</select>
						<button class="btn-create-video" onclick={createVideo} disabled={creatingVideo || selectedIds.size === 0}>
							{creatingVideo ? 'Creating...' : `Create Video`}
						</button>
						<button class="btn-quick-export" onclick={createExport} disabled={exporting || selectedIds.size === 0} title="Create video and immediately queue export">
							{exporting ? 'Queueing...' : `Quick Export`}
						</button>
					</div>
					{#if missingCamCount > 0}
						<span class="cam-warning">{missingCamCount} clip{missingCamCount !== 1 ? 's' : ''} missing camera region</span>
					{/if}
				{/if}
			</div>

			{#if exportResult}
				<div class="export-result" class:success={exportResult.success} class:error={!exportResult.success}>
					{exportResult.message}
				</div>
			{/if}

			{#if filteredClips.length === 0}
				<div class="empty-state">
					{#if $clipRegions.length === 0}
						<p>No clips yet</p>
						<p class="empty-hint">Use Clipping mode to mark regions with W</p>
					{:else}
						<p>No clips match your filters</p>
					{/if}
				</div>
			{:else}
				{#each filteredClips as clip (clip.id)}
					{@const dur = clip.endTime - clip.startTime}
					{@const isEditing = editingId === clip.id}
					{@const isPreviewing = previewClip?.id === clip.id}
					<div class="clip-item" class:selected={selectedIds.has(clip.id)} class:previewing={isPreviewing}>
						<div class="clip-item-main">
							<input type="checkbox" checked={selectedIds.has(clip.id)} onchange={() => toggleSelect(clip.id)} />
							<div class="clip-meta">
								{#if isEditing}
									<input
										type="text"
										class="edit-input edit-title"
										bind:value={editTitle}
										placeholder="Clip title..."
										onkeydown={(e) => {
											if (e.key === 'Enter') saveEdit();
											if (e.key === 'Escape') cancelEdit();
										}}
									/>
									<textarea
										class="edit-input edit-notes"
										bind:value={editNotes}
										placeholder="Notes..."
										rows="2"
										onkeydown={(e) => {
											if (e.key === 'Escape') cancelEdit();
										}}
									></textarea>
									<div class="edit-actions">
										<button class="btn-sm btn-save" onclick={saveEdit}>Save</button>
										<button class="btn-sm btn-cancel" onclick={cancelEdit}>Cancel</button>
									</div>
								{:else}
									<div class="clip-title-row">
										<span class="clip-channel">{clipChannel(clip)}</span>
										<span class="clip-title-text">{clip.title || 'Untitled'}</span>
										{#if clip.favourite}
											<span class="clip-fav-star">&#9733;</span>
										{/if}
										{#if clip.createdBy === 'ai'}
											<span class="clip-badge ai">AI</span>
										{/if}
										{#if resolveClipCamBounds(clip)}
											<span class="clip-badge cam">CAM</span>
										{/if}
									</div>
									{#if clip.notes}
										<div class="clip-notes">{clip.notes}</div>
									{/if}
									<div class="clip-details">
										<span class="clip-time">{formatEpochDate(clip.startTime)}</span>
										<span class="clip-dur">{formatDuration(dur)}</span>
									</div>
								{/if}
							</div>
							<div class="clip-actions">
								{#if !isEditing}
									<button
										class="btn-icon btn-fav"
										class:fav-active={clip.favourite}
										onclick={() => toggleFavourite(clip)}
										title={clip.favourite ? 'Remove favourite' : 'Mark as favourite'}
									>{clip.favourite ? '\u2605' : '\u2606'}</button>
									<button class="btn-icon" onclick={() => copyClipId(clip.id)} title="Copy clip ID"> ID </button>
									<button class="btn-icon" onclick={() => openPreview(clip)} title="Preview">
										{isPreviewing ? '✕' : '▶'}
									</button>
									<a class="btn-icon btn-review" href="/review?clip={clip.id}" title="Edit in Review">
										&#9881;
									</a>
									<button class="btn-icon" onclick={() => startEdit(clip)} title="Edit"> &#9998; </button>
									{#if clip.createdBy === 'ai'}
										<button
											class="btn-icon btn-approve"
											onclick={() => approveClip(clip)}
											title="Approve (mark as human)"
										>
											&#10003;
										</button>
									{/if}
									<span class="actions-gap"></span>
									<button
										class="btn-icon btn-delete"
										class:confirming={deleteConfirmId === clip.id}
										onclick={() => handleDelete(clip.id)}
										title={deleteConfirmId === clip.id ? 'Press again to confirm delete' : 'Delete clip'}
									>
										{deleteConfirmId === clip.id ? '!!' : 'Del'}
									</button>
								{/if}
							</div>
						</div>

						{#if isPreviewing}
							<div class="preview-container">
								<!-- svelte-ignore a11y_media_has_caption -->
								<video
									bind:this={previewVideoEl}
									ontimeupdate={handlePreviewTimeUpdate}
									playsinline
									class="preview-video"
								></video>
								<div class="preview-controls">
									<button class="btn-ctl" onclick={togglePreviewPlay}>
										{previewPlaying ? '⏸' : '▶'}
									</button>
									<span class="preview-time">{previewCurrentTime}</span>
									<input
										type="range"
										class="preview-seek"
										min="0"
										max="1"
										step="0.001"
										value={previewProgress}
										oninput={handleSeekInput}
										onchange={handleSeekCommit}
									/>
									<span class="preview-time">{previewDuration}</span>
									<button class="btn-ctl" onclick={closePreview}>Close</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.clips-panel {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.filters-bar {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 10px 20px;
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
	}

	.filter-group {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.filter-label {
		font-size: 0.7rem;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 600;
	}

	.filter-select,
	.filter-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 4px 8px;
		border-radius: 4px;
		outline: none;
	}

	.filter-select:focus,
	.filter-input:focus {
		border-color: #7c3aed;
	}

	.filter-spacer {
		flex: 1;
	}

	.clip-count {
		font-size: 0.75rem;
		color: #888;
	}

	.clips-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}

	.clip-list {
		flex: 1;
		overflow-y: auto;
		padding: 0;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.selection-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 20px;
		background: #0a0a1a;
		border-bottom: 1px solid #1a1a2e;
		position: sticky;
		top: 0;
		z-index: 2;
	}

	.select-all-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
		color: #aaa;
		cursor: pointer;
		white-space: nowrap;
	}

	.export-inline {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
	}

	.export-title-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 4px 10px;
		border-radius: 4px;
		outline: none;
		width: 200px;
	}

	.export-title-input:focus {
		border-color: #7c3aed;
	}

	.format-select {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 4px 8px;
		border-radius: 4px;
		outline: none;
	}

	.format-select:focus {
		border-color: #7c3aed;
	}

	.cam-warning {
		font-size: 0.65rem;
		color: #fbbf24;
		margin-left: auto;
		white-space: nowrap;
	}

	.btn-create-video {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 5px 14px;
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
	}

	.btn-create-video:hover {
		background: #6d28d9;
	}

	.btn-create-video:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-quick-export {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.7rem;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
	}

	.btn-quick-export:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.btn-quick-export:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.export-result {
		padding: 6px 20px;
		font-size: 0.75rem;
	}

	.export-result.success {
		color: #4ade80;
		background: rgba(22, 163, 74, 0.1);
	}

	.export-result.error {
		color: #f87171;
		background: rgba(220, 38, 38, 0.1);
	}

	.empty-state {
		padding: 48px 20px;
		text-align: center;
		color: #666;
	}

	.empty-hint {
		font-size: 0.85rem;
		color: #555;
	}

	.clip-item {
		border-bottom: 1px solid #1a1a2e;
		transition: background 0.1s;
	}

	.clip-item:hover {
		background: #0f0f23;
	}

	.clip-item.selected {
		background: rgba(124, 58, 237, 0.06);
	}

	.clip-item.previewing {
		background: #0f0f23;
	}

	.clip-item-main {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 20px;
	}

	.clip-item-main > input[type='checkbox'] {
		margin-top: 3px;
		flex-shrink: 0;
	}

	.clip-meta {
		flex: 1;
		min-width: 0;
	}

	.clip-title-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.clip-channel {
		font-size: 0.7rem;
		color: #7c3aed;
		font-weight: 600;
		text-transform: lowercase;
	}

	.clip-title-text {
		font-size: 0.8rem;
		color: #ddd;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.clip-badge {
		font-size: 0.55rem;
		font-weight: 600;
		padding: 1px 5px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		flex-shrink: 0;
	}

	.clip-badge.ai {
		background: #1e3a5f;
		color: #60a5fa;
	}

	.clip-badge.cam {
		background: rgba(168, 85, 247, 0.2);
		color: #a855f7;
	}

	.clip-notes {
		font-size: 0.7rem;
		color: #777;
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.clip-details {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 4px;
	}

	.clip-time {
		font-size: 0.65rem;
		color: #666;
	}

	.clip-dur {
		font-size: 0.65rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
	}

	.clip-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.btn-icon {
		background: none;
		border: 1px solid #2a2a4a;
		color: #aaa;
		width: 28px;
		height: 28px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.btn-icon:hover {
		background: #2a2a4a;
		color: #fff;
	}

	.actions-gap {
		width: 8px;
	}

	.btn-review {
		color: #60a5fa;
		border-color: #1e3a5f;
		text-decoration: none;
	}

	.btn-review:hover {
		background: #1e3a5f;
		color: #60a5fa;
	}

	.btn-approve {
		color: #4ade80;
		border-color: #1a3a2e;
	}

	.btn-approve:hover {
		background: #1a3a2e;
		color: #4ade80;
	}

	.btn-delete {
		color: #f87171;
		border-color: #5a2a2a;
	}

	.btn-delete:hover {
		background: #3a1a1a;
		color: #f87171;
		border-color: #5a2a2a;
	}

	.btn-delete.confirming {
		background: #5a1a1a;
		color: #f87171;
		border-color: #f87171;
		font-weight: 700;
		animation: pulse-delete 0.6s ease-in-out infinite alternate;
	}

	@keyframes pulse-delete {
		from {
			opacity: 0.7;
		}
		to {
			opacity: 1;
		}
	}

	/* Edit mode */
	.edit-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 4px 8px;
		border-radius: 4px;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.edit-input:focus {
		border-color: #7c3aed;
	}

	.edit-title {
		margin-bottom: 4px;
	}

	.edit-notes {
		resize: vertical;
		font-family: inherit;
		margin-bottom: 4px;
	}

	.edit-actions {
		display: flex;
		gap: 6px;
	}

	.btn-sm {
		font-size: 0.7rem;
		padding: 3px 10px;
		border-radius: 3px;
		border: none;
		cursor: pointer;
	}

	.btn-save {
		background: #7c3aed;
		color: #fff;
	}

	.btn-save:hover {
		background: #6d28d9;
	}

	.btn-cancel {
		background: #2a2a4a;
		color: #ccc;
	}

	.btn-cancel:hover {
		background: #3a3a5a;
	}

	/* Preview */
	.preview-container {
		padding: 0 20px 10px 48px;
	}

	.preview-video {
		width: 100%;
		max-height: 300px;
		background: #000;
		border-radius: 4px;
		display: block;
	}

	.preview-controls {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
	}

	.preview-time {
		font-size: 0.65rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		min-width: 3em;
		text-align: center;
	}

	.preview-seek {
		flex: 1;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: #2a2a4a;
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.preview-seek::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		cursor: pointer;
	}

	.preview-seek::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		border: none;
		cursor: pointer;
	}

	.preview-seek::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
	}

	.preview-seek::-moz-range-track {
		height: 4px;
		background: #2a2a4a;
		border-radius: 2px;
	}

	.btn-ctl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.75rem;
	}

	.btn-ctl:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.filter-fav-btn {
		background: none;
		border: 1px solid #2a2a4a;
		color: #555;
		font-size: 0.85rem;
		width: 28px;
		height: 28px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: color 0.15s, border-color 0.15s, background 0.15s;
	}

	.filter-fav-btn:hover {
		color: #fbbf24;
		border-color: #3a3a1a;
	}

	.filter-fav-btn.active {
		color: #fbbf24;
		border-color: #fbbf24;
		background: rgba(251, 191, 36, 0.1);
	}

	.clip-fav-star {
		color: #fbbf24;
		font-size: 0.75rem;
		flex-shrink: 0;
	}

	.btn-fav {
		color: #555;
		border-color: #2a2a4a;
	}

	.btn-fav:hover {
		color: #fbbf24;
		background: rgba(251, 191, 36, 0.1);
	}

	.btn-fav.fav-active {
		color: #fbbf24;
		border-color: #3a3a1a;
	}
</style>
