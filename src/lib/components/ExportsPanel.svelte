<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Hls from 'hls.js';
	import { exportStatusEvents, exportLog, streams, syncOffsets, clipRegions, videos } from '$lib/stores/streams.js';
	import { listExports, reexportCmd, deleteExportCmd } from '$lib/streams.remote';
	import { formatDuration, formatEpochDate, getClipLocalBounds, setupHls } from '$lib/utils.js';
	import type { ClipRegion } from '$lib/stores/streams.js';

	interface ExportRecord {
		id: string;
		title: string;
		description?: string;
		clipIds: string[];
		videoId?: string;
		status: 'pending' | 'exporting' | 'ready' | 'error';
		outputPath?: string;
		error?: string;
		createdAt: number;
		completedAt?: number;
		format?: 'standard' | 'mobile_short';
	}

	let exports = $state<ExportRecord[]>([]);
	let loading = $state(true);

	// --- Preview state ---
	let previewExportId = $state<string | null>(null);
	let previewVideoEl = $state<HTMLVideoElement | null>(null);
	let previewHls: Hls | null = null;
	let previewPlaying = $state(false);
	let previewProgress = $state(0);
	let previewCurrentTime = $state('0:00');
	let previewTotalDuration = $state('0:00');
	let isSeeking = $state(false);
	let currentClipIndex = $state(0);

	// Resolve the previewing export's clip IDs to actual ClipRegion objects
	let previewClips = $derived.by(() => {
		if (!previewExportId) return [];
		const exp = exports.find((e) => e.id === previewExportId);
		if (!exp) return [];
		const clips: ClipRegion[] = [];
		for (const id of exp.clipIds) {
			const clip = $clipRegions.find((c) => c.id === id);
			if (clip) clips.push(clip);
		}
		return clips;
	});

	onMount(() => {
		fetchExports();
	});

	async function fetchExports() {
		loading = true;
		try {
			const data = await listExports();
			exports = data.exports;
		} catch {
			// Ignore
		} finally {
			loading = false;
		}
	}

	// React to SSE export-status events by updating the local list
	let lastProcessedCount = 0;
	$effect(() => {
		const events = $exportStatusEvents;
		if (events.length === 0 || events.length === lastProcessedCount) return;
		const latest = events[events.length - 1];
		lastProcessedCount = events.length;
		// Use untrack to avoid re-triggering when we write to `exports`
		exports = untrack(() => exports).map((e) => {
			if (e.id !== latest.exportId) return e;
			return {
				...e,
				status: latest.status as ExportRecord['status'],
				...(latest.outputPath && { outputPath: latest.outputPath }),
				...(latest.error && { error: latest.error }),
				...(latest.status === 'ready' || latest.status === 'error'
					? { completedAt: Math.floor(Date.now() / 1000) }
					: {})
			};
		});
	});

	function statusInfo(status: string): { label: string; cls: string } {
		switch (status) {
			case 'ready':
				return { label: 'Ready', cls: 'status-ready' };
			case 'exporting':
				return { label: 'Exporting...', cls: 'status-exporting' };
			case 'pending':
				return { label: 'Pending', cls: 'status-pending' };
			case 'error':
				return { label: 'Error', cls: 'status-error' };
			default:
				return { label: status, cls: 'status-pending' };
		}
	}


	async function handleReexport(id: string) {
		try {
			await reexportCmd({ id });
			await fetchExports();
		} catch (err) {
			console.error('Re-export failed:', err);
		}
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this export? The output file will also be removed.')) return;
		try {
			await deleteExportCmd({ id });
			if (previewExportId === id) closePreview();
			exports = exports.filter((e) => e.id !== id);
		} catch (err) {
			console.error('Delete export failed:', err);
		}
	}

	// Active export progress from SSE
	let activeProgress = $derived.by(() => {
		if ($exportLog.length === 0) return null;
		const latest = $exportLog[$exportLog.length - 1];
		return latest;
	});

	// --- Preview helpers ---

	function clipBounds(clip: ClipRegion) {
		const stream = $streams.find((s) => s.id === clip.streamId);
		return getClipLocalBounds(clip, stream, $syncOffsets[clip.streamId] || 0);
	}


	function getClipDuration(clip: ClipRegion): number {
		return clip.endTime - clip.startTime;
	}

	function getTotalDuration(clips: ClipRegion[]): number {
		let total = 0;
		for (const c of clips) total += getClipDuration(c);
		return total;
	}

	function getPriorDuration(clips: ClipRegion[], upToIndex: number): number {
		let total = 0;
		for (let i = 0; i < upToIndex; i++) total += getClipDuration(clips[i]);
		return total;
	}

	// --- Core multi-clip playback ---

	function openPreview(exp: ExportRecord) {
		if (previewExportId === exp.id) {
			closePreview();
			return;
		}
		closePreview();
		previewExportId = exp.id;
		previewPlaying = false;
		previewProgress = 0;
		previewCurrentTime = '0:00';
		currentClipIndex = 0;

		// Compute total duration from resolved clips (need to read store now)
		const clips: ClipRegion[] = [];
		for (const id of exp.clipIds) {
			const clip = $clipRegions.find((c) => c.id === id);
			if (clip) clips.push(clip);
		}
		previewTotalDuration = formatDuration(getTotalDuration(clips));

		requestAnimationFrame(() => {
			if (clips.length > 0) loadClipAtIndex(0, clips);
		});
	}

	function loadClipAtIndex(index: number, clips?: ClipRegion[]) {
		const resolvedClips = clips ?? previewClips;
		if (index < 0 || index >= resolvedClips.length) return;
		currentClipIndex = index;

		const clip = resolvedClips[index];
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream || !previewVideoEl) return;

		if (previewHls) {
			previewHls.destroy();
			previewHls = null;
		}

		const url = `/hls/${clip.streamId}/playlist.m3u8`;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		const localStart = clip.startTime - anchor + offset;

		previewHls = setupHls(Hls, previewVideoEl, url, localStart, () => {
			previewVideoEl!.play().then(() => { previewPlaying = true; }).catch(() => {});
		});
	}

	function handlePreviewTimeUpdate() {
		if (!previewVideoEl || previewClips.length === 0) return;
		const clip = previewClips[currentClipIndex];
		if (!clip) return;
		const bounds = clipBounds(clip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;
		const totalDur = getTotalDuration(previewClips);

		if (previewVideoEl.currentTime >= localEnd) {
			// Clip ended — advance or stop
			if (currentClipIndex < previewClips.length - 1) {
				loadClipAtIndex(currentClipIndex + 1);
			} else {
				// Last clip — pause and reset
				previewVideoEl.pause();
				previewPlaying = false;
				previewProgress = 1;
				previewCurrentTime = formatDuration(totalDur);
			}
		} else if (!isSeeking) {
			const elapsed = previewVideoEl.currentTime - localStart;
			const globalElapsed = getPriorDuration(previewClips, currentClipIndex) + elapsed;
			previewProgress = totalDur > 0 ? Math.max(0, Math.min(1, globalElapsed / totalDur)) : 0;
			previewCurrentTime = formatDuration(globalElapsed);
		}
	}

	function handleSeekInput(e: Event) {
		isSeeking = true;
		const value = +(e.target as HTMLInputElement).value;
		previewProgress = value;
		const totalDur = getTotalDuration(previewClips);
		previewCurrentTime = formatDuration(value * totalDur);
	}

	function handleSeekCommit() {
		if (!previewVideoEl || previewClips.length === 0) {
			isSeeking = false;
			return;
		}
		const totalDur = getTotalDuration(previewClips);
		const targetTime = previewProgress * totalDur;

		// Find which clip this falls into
		let accumulated = 0;
		let targetIndex = 0;
		let offsetInClip = 0;
		for (let i = 0; i < previewClips.length; i++) {
			const dur = getClipDuration(previewClips[i]);
			if (accumulated + dur > targetTime) {
				targetIndex = i;
				offsetInClip = targetTime - accumulated;
				break;
			}
			accumulated += dur;
			if (i === previewClips.length - 1) {
				targetIndex = i;
				offsetInClip = dur;
			}
		}

		if (targetIndex !== currentClipIndex) {
			// Need to load a different clip, then seek within it
			currentClipIndex = targetIndex;
			const clip = previewClips[targetIndex];
			const stream = $streams.find((s) => s.id === clip.streamId);
			if (!stream) {
				isSeeking = false;
				return;
			}

			if (previewHls) {
				previewHls.destroy();
				previewHls = null;
			}

			const url = `/hls/${clip.streamId}/playlist.m3u8`;
			const offset = $syncOffsets[clip.streamId] || 0;
			const anchor = stream.startedAt / 1000;
			const localStart = clip.startTime - anchor + offset;
			const seekTo = localStart + offsetInClip;

			previewHls = setupHls(Hls, previewVideoEl, url, seekTo, () => {
				isSeeking = false;
				if (previewPlaying) {
					previewVideoEl!.play().catch(() => {});
				}
			});
		} else {
			// Same clip — just seek
			const bounds = clipBounds(previewClips[targetIndex]);
			if (bounds) {
				previewVideoEl.currentTime = bounds.localStart + offsetInClip;
			}
			isSeeking = false;
		}
	}

	function togglePreviewPlay() {
		if (!previewVideoEl) return;
		if (previewPlaying) {
			previewVideoEl.pause();
		} else {
			// If at the end, restart from beginning
			if (previewProgress >= 1 && previewClips.length > 0) {
				previewProgress = 0;
				previewCurrentTime = '0:00';
				loadClipAtIndex(0);
				return;
			}
			previewVideoEl.play().catch(() => {});
		}
		previewPlaying = !previewPlaying;
	}

	function closePreview() {
		if (previewHls) {
			previewHls.destroy();
			previewHls = null;
		}
		previewExportId = null;
		previewPlaying = false;
		previewProgress = 0;
		currentClipIndex = 0;
	}

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (previewHls) {
				previewHls.destroy();
				previewHls = null;
			}
		};
	});
</script>

<div class="exports-panel">
	<div class="exports-card">
		<div class="exports-header">
			<h2 class="exports-title">Exports</h2>
			<button class="btn-refresh" onclick={fetchExports}>Refresh</button>
		</div>

		{#if loading}
			<p class="loading-text">Loading exports...</p>
		{:else if exports.length === 0}
			<div class="empty-state">
				<p>No exports yet</p>
				<p class="empty-hint">Select clips in the Clips tab and export them</p>
			</div>
		{:else}
			<div class="exports-list">
				{#each exports as exp (exp.id)}
					{@const info = statusInfo(exp.status)}
					{@const isPreviewing = previewExportId === exp.id}
					<div class="export-item">
						<div class="export-item-header">
							<span class="export-item-title">{exp.title}</span>
							{#if exp.videoId}
								{@const linkedVideo = $videos.find((v) => v.id === exp.videoId)}
								<a class="btn-video-link" href="/videos/{exp.videoId}" title={linkedVideo?.title ?? 'Video'}>{linkedVideo?.title ?? 'Video'}</a>
							{/if}
							<span class="format-badge">{exp.format === 'mobile_short' ? '9:16' : '16:9'}</span>
							<div class="export-item-actions">
								{#if exp.clipIds.length > 0}
									<button
										class="btn-preview"
										onclick={() => openPreview(exp)}
										title={isPreviewing ? 'Close preview' : 'Preview clips'}
									>
										{isPreviewing ? '\u2715' : '\u25B6'}
									</button>
								{/if}
								<a class="btn-thumbnail" href="/thumbnail?export={exp.id}">Thumbnail</a>
								{#if exp.status === 'ready'}
									<a class="btn-upload" href="/upload?export={exp.id}">Upload</a>
								{/if}
								{#if exp.status === 'ready' || exp.status === 'error'}
									<button class="btn-reexport" onclick={() => handleReexport(exp.id)}>Re-export</button>
									<button class="btn-delete" onclick={() => handleDelete(exp.id)}>Delete</button>
								{/if}
								<span class="export-status {info.cls}">{info.label}</span>
							</div>
						</div>
						{#if exp.description}
							<div class="export-description">{exp.description}</div>
						{/if}
						<div class="export-details">
							<span class="export-clips">{exp.clipIds.length} clip{exp.clipIds.length !== 1 ? 's' : ''}</span>
							<span class="export-date">{formatEpochDate(exp.createdAt)}</span>
							{#if exp.completedAt}
								<span class="export-completed">Completed {formatEpochDate(exp.completedAt)}</span>
							{/if}
						</div>
						{#if exp.status === 'exporting' && activeProgress}
							<div class="export-progress">
								<div class="progress-bar">
									<div
										class="progress-fill"
										style="width: {activeProgress.totalSteps > 0
											? (activeProgress.step / activeProgress.totalSteps) * 100
											: 0}%"
									></div>
								</div>
								<span class="progress-text">{activeProgress.message}</span>
							</div>
						{/if}
						{#if exp.status === 'ready' && exp.outputPath}
							<div class="export-output">
								<span class="output-path">{exp.outputPath}</span>
							</div>
						{/if}
						{#if exp.status === 'error' && exp.error}
							<div class="export-error">{exp.error}</div>
						{/if}

						{#if isPreviewing}
							<div class="preview-container">
								{#if previewClips.length > 0}
									<div class="preview-clip-info">
										<div class="preview-clip-header">
											<span class="preview-clip-index">Clip {currentClipIndex + 1}/{previewClips.length}</span>
											<span class="preview-clip-title">{previewClips[currentClipIndex]?.title || 'Untitled'}</span>
										</div>
										{#if previewClips[currentClipIndex]?.notes}
											<span class="preview-clip-notes">{previewClips[currentClipIndex].notes}</span>
										{/if}
									</div>
								{/if}
								<!-- svelte-ignore a11y_media_has_caption -->
								<video
									bind:this={previewVideoEl}
									ontimeupdate={handlePreviewTimeUpdate}
									playsinline
									class="preview-video"
								></video>
								<div class="preview-controls">
									<button class="btn-ctl" onclick={togglePreviewPlay}>
										{previewPlaying ? '\u23F8' : '\u25B6'}
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
									<span class="preview-time">{previewTotalDuration}</span>
									<button class="btn-ctl" onclick={closePreview}>Close</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.exports-panel {
		flex: 1;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 32px 24px;
		overflow: auto;
	}

	.exports-card {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 8px;
		padding: 24px;
		width: 100%;
		max-width: 960px;
	}

	.exports-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.exports-title {
		font-size: 1rem;
		font-weight: 700;
		color: #e0e0ff;
		margin: 0;
	}

	.btn-refresh {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.7rem;
		padding: 4px 12px;
		border-radius: 4px;
		cursor: pointer;
	}

	.btn-refresh:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.export-item-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.btn-preview {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.65rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
	}

	.btn-preview:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.btn-thumbnail {
		background: rgba(59, 130, 246, 0.15);
		border: 1px solid rgba(59, 130, 246, 0.3);
		color: #93c5fd;
		font-size: 0.65rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		text-decoration: none;
	}

	.btn-thumbnail:hover {
		background: rgba(59, 130, 246, 0.25);
		color: #bfdbfe;
	}

	.btn-upload {
		background: rgba(124, 58, 237, 0.15);
		border: 1px solid rgba(124, 58, 237, 0.3);
		color: #a78bfa;
		font-size: 0.65rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		text-decoration: none;
	}

	.btn-upload:hover {
		background: rgba(124, 58, 237, 0.25);
		color: #c4b5fd;
	}

	.btn-reexport {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.65rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
	}

	.btn-reexport:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.btn-delete {
		background: #3a1a1a;
		border: 1px solid #5a2a2a;
		color: #c88;
		font-size: 0.65rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
	}

	.btn-delete:hover {
		background: #5a2a2a;
		color: #faa;
	}

	.loading-text {
		color: #888;
		font-size: 0.85rem;
	}

	.empty-state {
		text-align: center;
		padding: 32px 0;
		color: #666;
	}

	.empty-hint {
		font-size: 0.85rem;
		color: #555;
	}

	.exports-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.export-item {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 14px 16px;
	}

	.export-item-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.export-item-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: #e0e0ff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.btn-video-link {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(59, 130, 246, 0.12);
		color: #93c5fd;
		flex-shrink: 0;
		text-decoration: none;
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.btn-video-link:hover {
		background: rgba(59, 130, 246, 0.25);
		color: #bfdbfe;
	}

	.format-badge {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(168, 85, 247, 0.15);
		color: #a855f7;
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}

	.export-status {
		font-size: 0.65rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		flex-shrink: 0;
	}

	.status-ready {
		background: rgba(22, 163, 74, 0.15);
		color: #4ade80;
	}

	.status-exporting {
		background: rgba(234, 179, 8, 0.15);
		color: #fbbf24;
	}

	.status-pending {
		background: rgba(100, 100, 100, 0.15);
		color: #999;
	}

	.status-error {
		background: rgba(220, 38, 38, 0.15);
		color: #f87171;
	}

	.export-description {
		font-size: 0.75rem;
		color: #888;
		margin-top: 6px;
	}

	.export-details {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 8px;
		font-size: 0.65rem;
		color: #666;
	}

	.export-progress {
		margin-top: 8px;
	}

	.progress-bar {
		height: 4px;
		background: #1a1a2e;
		border-radius: 2px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: #7c3aed;
		transition: width 0.3s ease;
	}

	.progress-text {
		font-size: 0.65rem;
		color: #888;
		margin-top: 4px;
		display: block;
	}

	.export-output {
		margin-top: 8px;
		padding: 6px 10px;
		background: rgba(22, 163, 74, 0.08);
		border-radius: 4px;
	}

	.output-path {
		font-size: 0.7rem;
		color: #4ade80;
		font-family: monospace;
		word-break: break-all;
	}

	.export-error {
		margin-top: 8px;
		font-size: 0.7rem;
		color: #f87171;
		padding: 6px 10px;
		background: rgba(220, 38, 38, 0.08);
		border-radius: 4px;
	}

	/* Preview */
	.preview-container {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid #2a2a4a;
	}

	.preview-clip-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 8px;
		font-size: 0.7rem;
	}

	.preview-clip-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.preview-clip-index {
		color: #7c3aed;
		font-weight: 600;
		flex-shrink: 0;
	}

	.preview-clip-title {
		color: #ccc;
	}

	.preview-clip-notes {
		color: #666;
		white-space: pre-wrap;
	}

	.preview-video {
		width: 100%;
		max-height: 540px;
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
</style>
