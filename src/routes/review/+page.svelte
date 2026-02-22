<script lang="ts">
	import Hls from 'hls.js';
	import {
		streams,
		syncOffsets,
		clipRegions,
		saveClipRegion,
		deleteClipRegion,
		clipEncodeStatuses,
		type ClipRegion
	} from '$lib/stores/streams.js';
	import { formatDuration, createHlsConfig } from '$lib/utils.js';
	import { getClipEncodeStatuses } from '$lib/streams.remote';

	// --- Current clip under review (oldest AI clip) ---
	let aiClips = $derived(
		[...$clipRegions]
			.filter((c) => c.createdBy === 'ai')
			.sort((a, b) => a.startTime - b.startTime)
	);
	let currentClip = $derived<ClipRegion | null>(aiClips[0] ?? null);

	// --- Delete confirmation ---
	let deleteConfirmId = $state<string | null>(null);
	let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Editing ---
	let editingId = $state<string | null>(null);
	let editTitle = $state('');
	let editNotes = $state('');

	// --- Preview player ---
	let videoEl = $state<HTMLVideoElement | null>(null);
	let hls: Hls | null = null;
	let playing = $state(false);
	let progress = $state(0);
	let currentTime = $state('0:00');
	let durationText = $state('0:00');
	let isSeeking = $state(false);
	let loadedClipId = $state<string | null>(null);
	let playbackRate = $state(1);

	// --- Helpers ---
	function clipChannel(clip: ClipRegion): string {
		return $streams.find((s) => s.id === clip.streamId)?.channel || 'unknown';
	}

	function clipDate(epoch: number): string {
		return new Date(epoch * 1000).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}

	function fmtTime(seconds: number): string {
		const s = Math.max(0, Math.floor(seconds));
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}

	function getClipLocalBounds(clip: ClipRegion): { localStart: number; localEnd: number } | null {
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return { localStart: clip.startTime - anchor + offset, localEnd: clip.endTime - anchor + offset };
	}

	function encodeStatusInfo(status: string | undefined): { label: string; cls: string } {
		switch (status) {
			case 'ready': return { label: 'Encoded', cls: 'badge-ready' };
			case 'encoding': return { label: 'Encoding...', cls: 'badge-encoding' };
			case 'pending': return { label: 'Pending', cls: 'badge-pending' };
			case 'error': return { label: 'Error', cls: 'badge-error' };
			default: return { label: 'Unknown', cls: 'badge-unknown' };
		}
	}

	// --- Player setup ---
	function setupPlayer(clip: ClipRegion) {
		if (!videoEl) return;
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return;

		if (hls) { hls.destroy(); hls = null; }

		const url = `/hls/${clip.streamId}/playlist.m3u8`;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		const localStart = clip.startTime - anchor + offset;

		const autoPlay = () => {
			videoEl!.playbackRate = playbackRate;
			videoEl!.play().then(() => { playing = true; }).catch(() => {});
		};

		if (Hls.isSupported()) {
			const h = new Hls(createHlsConfig(false));
			hls = h;
			h.loadSource(url);
			h.attachMedia(videoEl);
			h.on(Hls.Events.MANIFEST_PARSED, () => {
				videoEl!.currentTime = localStart;
				autoPlay();
			});
			h.on(Hls.Events.ERROR, (_event, data) => {
				if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					h.recoverMediaError();
				}
			});
		} else {
			videoEl.src = url;
			videoEl.currentTime = localStart;
			autoPlay();
		}

		loadedClipId = clip.id;
	}

	// Auto-load player when currentClip changes
	$effect(() => {
		const clip = currentClip;
		if (!clip) {
			if (hls) { hls.destroy(); hls = null; }
			loadedClipId = null;
			playing = false;
			return;
		}
		if (clip.id === loadedClipId) return;
		// Reset state for new clip
		playing = false;
		progress = 0;
		currentTime = '0:00';
		durationText = fmtTime(clip.endTime - clip.startTime);
		editingId = null;
		deleteConfirmId = null;
		// Wait for DOM
		requestAnimationFrame(() => setupPlayer(clip));
	});

	// Fetch encode statuses
	$effect(() => {
		const clip = currentClip;
		if (!clip) return;
		getClipEncodeStatuses({ clipIds: [clip.id] })
			.then((statuses) => clipEncodeStatuses.update((c) => ({ ...c, ...statuses })))
			.catch(() => {});
	});

	// Clamp playback to clip bounds
	function handleTimeUpdate() {
		if (!videoEl || !currentClip) return;
		const bounds = getClipLocalBounds(currentClip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;

		if (videoEl.currentTime >= localEnd) {
			videoEl.pause();
			playing = false;
			videoEl.currentTime = localStart;
			progress = 0;
			currentTime = '0:00';
		} else if (!isSeeking) {
			const elapsed = videoEl.currentTime - localStart;
			progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			currentTime = fmtTime(elapsed);
		}
		durationText = fmtTime(clipDur);
	}

	function handleSeekInput(e: Event) {
		isSeeking = true;
		const value = +(e.target as HTMLInputElement).value;
		progress = value;
		if (currentClip) {
			const bounds = getClipLocalBounds(currentClip);
			if (bounds) currentTime = fmtTime(value * (bounds.localEnd - bounds.localStart));
		}
	}

	function handleSeekCommit() {
		if (!videoEl || !currentClip) { isSeeking = false; return; }
		const bounds = getClipLocalBounds(currentClip);
		if (!bounds) { isSeeking = false; return; }
		videoEl.currentTime = bounds.localStart + progress * (bounds.localEnd - bounds.localStart);
		isSeeking = false;
	}

	function togglePlay() {
		if (!videoEl) return;
		if (playing) videoEl.pause(); else videoEl.play().catch(() => {});
		playing = !playing;
	}

	// --- Actions ---
	function approveClip(clip: ClipRegion) {
		saveClipRegion({ ...clip, createdBy: 'human' as const });
	}

	function handleDelete(id: string) {
		if (deleteConfirmId === id) {
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmTimer = null;
			deleteConfirmId = null;
			if (hls) { hls.destroy(); hls = null; }
			loadedClipId = null;
			playing = false;
			deleteClipRegion(id);
		} else {
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmId = id;
			deleteConfirmTimer = setTimeout(() => {
				deleteConfirmId = null;
				deleteConfirmTimer = null;
			}, 3000);
		}
	}

	function copyClipId(id: string) {
		navigator.clipboard.writeText(id);
	}

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

	// --- Playback rate sync ---
	function setRate(rate: number) {
		playbackRate = Math.max(0.25, Math.min(4, rate));
		if (videoEl) videoEl.playbackRate = playbackRate;
	}

	// --- Clip boundary adjustment ---
	function updateClipBounds(clip: ClipRegion, newStart: number, newEnd: number) {
		if (newEnd <= newStart) return;
		const updated = { ...clip, startTime: newStart, endTime: newEnd };
		clipRegions.update((regions) => regions.map((r) => (r.id === updated.id ? updated : r)));
		saveClipRegion(updated);
	}

	function getMasterTimeAtPlayhead(): number | null {
		if (!videoEl || !currentClip) return null;
		const stream = $streams.find((s) => s.id === currentClip!.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[currentClip!.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return videoEl.currentTime + anchor - offset;
	}

	// --- Keyboard shortcuts ---
	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (!currentClip || editingId) return;

		switch (e.key) {
			case ' ':
				e.preventDefault();
				togglePlay();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				if (videoEl) videoEl.currentTime -= 3;
				break;
			case 'ArrowRight':
				e.preventDefault();
				if (videoEl) videoEl.currentTime += 3;
				break;
			case 'ArrowUp':
				e.preventDefault();
				setRate(playbackRate + 0.25);
				break;
			case 'ArrowDown':
				e.preventDefault();
				setRate(playbackRate - 0.25);
				break;
			case 'a': {
				// a: extend start by 1s
				const clip = currentClip;
				updateClipBounds(clip, clip.startTime - 1, clip.endTime);
				break;
			}
			case 'A': {
				// Shift+A: move start to playhead, then seek to new start
				const mt = getMasterTimeAtPlayhead();
				if (mt != null && mt < currentClip.endTime) {
					updateClipBounds(currentClip, mt, currentClip.endTime);
					if (videoEl) videoEl.currentTime = videoEl.currentTime; // trigger timeupdate
					// Seek to the new clip start
					const stream = $streams.find((s) => s.id === currentClip.streamId);
					if (stream && videoEl) {
						const offset = $syncOffsets[currentClip.streamId] || 0;
						const anchor = stream.startedAt / 1000;
						videoEl.currentTime = mt - anchor + offset;
					}
				}
				break;
			}
			case 'd': {
				// d: extend end by 1s
				const clip = currentClip;
				updateClipBounds(clip, clip.startTime, clip.endTime + 1);
				break;
			}
			case 'D': {
				// Shift+D: move end to playhead
				const mt = getMasterTimeAtPlayhead();
				if (mt != null && mt > currentClip.startTime) {
					updateClipBounds(currentClip, currentClip.startTime, mt);
				}
				break;
			}
		}
	}

	// Cleanup
	$effect(() => {
		return () => { if (hls) { hls.destroy(); hls = null; } };
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="review-page">
	{#if !currentClip}
		<div class="empty-state">
			<div class="empty-icon">&#10003;</div>
			<p>No AI clips to review</p>
			<p class="empty-hint">AI-created clips will appear here for your review</p>
		</div>
	{:else}
		{@const clip = currentClip}
		{@const dur = clip.endTime - clip.startTime}
		{@const encStatus = $clipEncodeStatuses[clip.id]}
		{@const badge = encodeStatusInfo(encStatus)}
		{@const isEditing = editingId === clip.id}

		<div class="review-counter">{aiClips.length} clip{aiClips.length !== 1 ? 's' : ''} to review</div>

		<div class="review-card">
			<!-- Video preview -->
			<div class="video-container">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					bind:this={videoEl}
					ontimeupdate={handleTimeUpdate}
					playsinline
					class="review-video"
				></video>
				<div class="video-controls">
					<button class="btn-ctl" onclick={togglePlay}>
						{playing ? '⏸' : '▶'}
					</button>
					<span class="vid-time">{currentTime}</span>
					<input
						type="range"
						class="vid-seek"
						min="0"
						max="1"
						step="0.001"
						value={progress}
						oninput={handleSeekInput}
						onchange={handleSeekCommit}
					/>
					<span class="vid-time">{durationText}</span>
					<span class="vid-speed">{playbackRate}x</span>
				</div>
			</div>

			<!-- Clip info -->
			<div class="clip-info">
				{#if isEditing}
					<input
						type="text"
						class="edit-input edit-title"
						bind:value={editTitle}
						placeholder="Clip title..."
						onkeydown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
					/>
					<textarea
						class="edit-input edit-notes"
						bind:value={editNotes}
						placeholder="Notes..."
						rows="3"
						onkeydown={(e) => { if (e.key === 'Escape') cancelEdit(); }}
					></textarea>
					<div class="edit-actions">
						<button class="btn-sm btn-save" onclick={saveEdit}>Save</button>
						<button class="btn-sm btn-cancel" onclick={cancelEdit}>Cancel</button>
					</div>
				{:else}
					<div class="clip-header">
						<span class="clip-channel">{clipChannel(clip)}</span>
						<span class="clip-badge ai">AI</span>
						<span class="encode-badge {badge.cls}">{badge.label}</span>
					</div>
					<div class="clip-title">{clip.title || 'Untitled'}</div>
					{#if clip.notes}
						<div class="clip-notes">{clip.notes}</div>
					{/if}
					<div class="clip-details">
						<span>{clipDate(clip.startTime)}</span>
						<span class="clip-dur">{formatDuration(dur)}</span>
					</div>
				{/if}
			</div>

			<!-- Action buttons -->
			{#if !isEditing}
				<div class="review-actions">
					<button class="btn-action btn-approve" onclick={() => approveClip(clip)}>
						<span class="action-icon">&#10003;</span> Approve
					</button>
					<button
						class="btn-action btn-delete"
						class:confirming={deleteConfirmId === clip.id}
						onclick={() => handleDelete(clip.id)}
					>
						{#if deleteConfirmId === clip.id}
							Press again to delete
						{:else}
							<span class="action-icon">&#10005;</span> Delete
						{/if}
					</button>
					<button class="btn-action btn-edit" onclick={() => startEdit(clip)}>
						<span class="action-icon">&#9998;</span> Edit
					</button>
					<button class="btn-action btn-copy" onclick={() => copyClipId(clip.id)}>
						ID
					</button>
				</div>
			{/if}
		</div>
	{/if}
</main>

<style>
	.review-page {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 32px 24px;
		gap: 16px;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		flex: 1;
		gap: 8px;
		color: #666;
	}

	.empty-icon {
		font-size: 3rem;
		color: #4ade80;
		margin-bottom: 8px;
	}

	.empty-hint {
		font-size: 0.85rem;
		color: #555;
	}

	.review-counter {
		font-size: 0.8rem;
		color: #888;
		align-self: flex-start;
		max-width: 900px;
		width: 100%;
		margin: 0 auto;
	}

	.review-card {
		width: 100%;
		max-width: 900px;
		background: #0f0f23;
		border: 1px solid #1a1a2e;
		border-radius: 8px;
		overflow: hidden;
	}

	/* Video */
	.video-container {
		background: #000;
	}

	.review-video {
		width: 100%;
		max-height: 500px;
		display: block;
	}

	.video-controls {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		background: #0a0a1a;
	}

	.vid-time {
		font-size: 0.7rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		min-width: 3em;
		text-align: center;
	}

	.vid-seek {
		flex: 1;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: #2a2a4a;
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.vid-seek::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #7c3aed;
		cursor: pointer;
	}

	.vid-seek::-moz-range-thumb {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #7c3aed;
		border: none;
		cursor: pointer;
	}

	.vid-seek::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
	}

	.vid-seek::-moz-range-track {
		height: 4px;
		background: #2a2a4a;
		border-radius: 2px;
	}

	.vid-speed {
		font-size: 0.7rem;
		color: #7c3aed;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		min-width: 3em;
		text-align: center;
	}

	.btn-ctl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.btn-ctl:hover {
		background: #3a3a5a;
		color: #fff;
	}

	/* Clip info */
	.clip-info {
		padding: 16px 20px;
	}

	.clip-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.clip-channel {
		font-size: 0.8rem;
		color: #7c3aed;
		font-weight: 600;
		text-transform: lowercase;
	}

	.clip-badge {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.clip-badge.ai {
		background: #1e3a5f;
		color: #60a5fa;
	}

	.clip-title {
		font-size: 1rem;
		color: #e0e0ff;
		margin-bottom: 4px;
	}

	.clip-notes {
		font-size: 0.8rem;
		color: #888;
		margin-bottom: 6px;
		line-height: 1.4;
	}

	.clip-details {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 0.75rem;
		color: #666;
	}

	.clip-dur {
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		color: #888;
	}

	.encode-badge {
		font-size: 0.6rem;
		padding: 1px 6px;
		border-radius: 3px;
		font-weight: 500;
	}

	.badge-ready { background: rgba(22, 163, 74, 0.15); color: #4ade80; }
	.badge-encoding { background: rgba(234, 179, 8, 0.15); color: #fbbf24; }
	.badge-pending { background: rgba(100, 100, 100, 0.15); color: #999; }
	.badge-error { background: rgba(220, 38, 38, 0.15); color: #f87171; }
	.badge-unknown { background: rgba(80, 80, 80, 0.15); color: #666; }

	/* Actions */
	.review-actions {
		display: flex;
		gap: 8px;
		padding: 12px 20px 16px;
		border-top: 1px solid #1a1a2e;
	}

	.btn-action {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 18px;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		background: none;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}

	.action-icon {
		font-size: 0.9rem;
	}

	.btn-approve {
		color: #4ade80;
		border-color: #1a3a2e;
	}
	.btn-approve:hover {
		background: #1a3a2e;
	}

	.btn-delete {
		color: #f87171;
		border-color: #3a1a1a;
	}
	.btn-delete:hover {
		background: #3a1a1a;
	}
	.btn-delete.confirming {
		background: #5a1a1a;
		border-color: #f87171;
		font-weight: 700;
		animation: pulse-delete 0.6s ease-in-out infinite alternate;
	}

	@keyframes pulse-delete {
		from { opacity: 0.7; }
		to { opacity: 1; }
	}

	.btn-edit {
		color: #aaa;
	}
	.btn-edit:hover {
		background: #2a2a4a;
		color: #fff;
	}

	.btn-copy {
		color: #aaa;
		margin-left: auto;
	}
	.btn-copy:hover {
		background: #2a2a4a;
		color: #fff;
	}

	/* Edit mode */
	.edit-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.8rem;
		padding: 6px 10px;
		border-radius: 4px;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.edit-input:focus {
		border-color: #7c3aed;
	}

	.edit-title {
		margin-bottom: 6px;
	}

	.edit-notes {
		resize: vertical;
		font-family: inherit;
		margin-bottom: 6px;
	}

	.edit-actions {
		display: flex;
		gap: 6px;
	}

	.btn-sm {
		font-size: 0.75rem;
		padding: 4px 14px;
		border-radius: 4px;
		border: none;
		cursor: pointer;
	}

	.btn-save { background: #7c3aed; color: #fff; }
	.btn-save:hover { background: #6d28d9; }
	.btn-cancel { background: #2a2a4a; color: #ccc; }
	.btn-cancel:hover { background: #3a3a5a; }
</style>
