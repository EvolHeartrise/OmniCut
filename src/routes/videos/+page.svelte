<script lang="ts">
	import { onMount } from 'svelte';
	import { videos, clipRegions, streams, syncOffsets } from '$lib/stores/streams.js';
	import { deleteVideoCmd, exportVideoFromVideoCmd, createVideoCmd } from '$lib/streams.remote';
	import { formatDuration, formatEpochDate } from '$lib/utils.js';
	import type { VideoRecord } from '$lib/types.js';
	import type { ClipRegion } from '$lib/stores/streams.js';

	// Sort: newest first
	let sortedVideos = $derived([...$videos].sort((a, b) => b.createdAt - a.createdAt));

	// --- Delete confirmation ---
	let deleteConfirmId = $state<string | null>(null);
	let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Export state ---
	let exportingId = $state<string | null>(null);
	let exportResult = $state<{ videoId: string; success: boolean; message: string } | null>(null);

	function resolveClips(video: VideoRecord): ClipRegion[] {
		const clips: ClipRegion[] = [];
		for (const entry of video.clipEntries) {
			const clip = $clipRegions.find((c) => c.id === entry.clipId);
			if (clip) clips.push(clip);
		}
		return clips;
	}

	function totalDuration(video: VideoRecord): number {
		let total = 0;
		for (const entry of video.clipEntries) {
			const clip = $clipRegions.find((c) => c.id === entry.clipId);
			if (!clip) continue;
			let dur = clip.endTime - clip.startTime;
			if (entry.trimStart) dur -= entry.trimStart;
			if (entry.trimEnd) dur -= entry.trimEnd;
			if (entry.speed && entry.speed > 0) dur /= entry.speed;
			total += Math.max(0, dur);
		}
		return total;
	}

	function formatLabel(format: string): string {
		switch (format) {
			case 'mobile_short': return '9:16';
			case 'chat_overlay': return 'Chat';
			default: return '16:9';
		}
	}

	function handleDelete(id: string) {
		if (deleteConfirmId === id) {
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmTimer = null;
			deleteConfirmId = null;
			deleteVideoCmd({ id });
			videos.update((v) => v.filter((x) => x.id !== id));
		} else {
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmId = id;
			deleteConfirmTimer = setTimeout(() => {
				deleteConfirmId = null;
				deleteConfirmTimer = null;
			}, 3000);
		}
	}

	async function handleExport(video: VideoRecord) {
		exportingId = video.id;
		exportResult = null;
		try {
			const result = await exportVideoFromVideoCmd({ videoId: video.id });
			exportResult = { videoId: video.id, success: true, message: `Export queued (ID: ${result.exportId})` };
		} catch (err) {
			exportResult = { videoId: video.id, success: false, message: err instanceof Error ? err.message : 'Failed' };
		} finally {
			exportingId = null;
		}
	}

	function uniqueChannels(video: VideoRecord): string[] {
		const channels = new Set<string>();
		for (const entry of video.clipEntries) {
			const clip = $clipRegions.find((c) => c.id === entry.clipId);
			if (clip) {
				const stream = $streams.find((s) => s.id === clip.streamId);
				if (stream) channels.add(stream.channel);
			}
		}
		return [...channels];
	}
</script>

<div class="videos-page main-content">
	<div class="videos-card">
		<div class="videos-header">
			<h2 class="videos-title">Videos</h2>
			<span class="video-count">{sortedVideos.length} video{sortedVideos.length !== 1 ? 's' : ''}</span>
		</div>

		{#if sortedVideos.length === 0}
			<div class="empty-state">
				<p>No videos yet</p>
				<p class="empty-hint">Select clips in the Clips tab to create a video composition</p>
			</div>
		{:else}
			<div class="videos-list">
				{#each sortedVideos as video (video.id)}
					{@const clips = resolveClips(video)}
					{@const dur = totalDuration(video)}
					{@const channels = uniqueChannels(video)}
					<div class="video-item">
						<div class="video-item-header">
							<a class="video-item-title" href="/videos/{video.id}">{video.title}</a>
							<span class="format-badge">{formatLabel(video.format)}</span>
							<div class="video-item-actions">
								<a class="btn-edit" href="/videos/{video.id}">Edit</a>
								<button
									class="btn-export"
									onclick={() => handleExport(video)}
									disabled={exportingId === video.id}
								>
									{exportingId === video.id ? 'Queueing...' : 'Export'}
								</button>
								<a class="btn-thumbnail" href="/thumbnail?video={video.id}">Thumbnail</a>
								<button
									class="btn-delete"
									class:confirming={deleteConfirmId === video.id}
									onclick={() => handleDelete(video.id)}
									title={deleteConfirmId === video.id ? 'Press again to confirm delete' : 'Delete video'}
								>
									{deleteConfirmId === video.id ? 'Confirm?' : 'Delete'}
								</button>
							</div>
						</div>
						{#if video.description}
							<div class="video-description">{video.description}</div>
						{/if}
						<div class="video-details">
							<span class="video-clips">{video.clipEntries.length} clip{video.clipEntries.length !== 1 ? 's' : ''}</span>
							<span class="video-dur">{formatDuration(dur)}</span>
							{#if channels.length > 0}
								<span class="video-channels">{channels.join(', ')}</span>
							{/if}
							<span class="video-date">Created {formatEpochDate(video.createdAt)}</span>
							{#if video.updatedAt !== video.createdAt}
								<span class="video-date">Updated {formatEpochDate(video.updatedAt)}</span>
							{/if}
						</div>
						{#if exportResult && exportResult.videoId === video.id}
							<div class="export-result" class:success={exportResult.success} class:error={!exportResult.success}>
								{exportResult.message}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.videos-page {
		flex: 1;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 32px 24px;
		overflow: auto;
	}

	.videos-card {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 8px;
		padding: 24px;
		width: 100%;
		max-width: 960px;
	}

	.videos-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.videos-title {
		font-size: 1rem;
		font-weight: 700;
		color: #e0e0ff;
		margin: 0;
	}

	.video-count {
		font-size: 0.75rem;
		color: #888;
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

	.videos-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.video-item {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 14px 16px;
	}

	.video-item:hover {
		border-color: #3a3a5a;
	}

	.video-item-header {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.video-item-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: #e0e0ff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
		flex: 1;
		min-width: 0;
	}

	.video-item-title:hover {
		color: #a78bfa;
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

	.video-item-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.btn-edit {
		background: rgba(124, 58, 237, 0.15);
		border: 1px solid rgba(124, 58, 237, 0.3);
		color: #a78bfa;
		font-size: 0.65rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		text-decoration: none;
	}

	.btn-edit:hover {
		background: rgba(124, 58, 237, 0.25);
		color: #c4b5fd;
	}

	.btn-export {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.65rem;
		font-weight: 600;
		padding: 3px 10px;
		border-radius: 3px;
		cursor: pointer;
	}

	.btn-export:hover {
		background: #6d28d9;
	}

	.btn-export:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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

	.btn-delete.confirming {
		background: #5a1a1a;
		color: #f87171;
		border-color: #f87171;
		font-weight: 700;
		animation: pulse-delete 0.6s ease-in-out infinite alternate;
	}

	@keyframes pulse-delete {
		from { opacity: 0.7; }
		to { opacity: 1; }
	}

	.video-description {
		font-size: 0.75rem;
		color: #888;
		margin-top: 6px;
	}

	.video-details {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 8px;
		font-size: 0.65rem;
		color: #666;
	}

	.video-dur {
		font-variant-numeric: tabular-nums;
		font-family: monospace;
	}

	.video-channels {
		color: #7c3aed;
	}

	.export-result {
		margin-top: 8px;
		padding: 6px 10px;
		font-size: 0.7rem;
		border-radius: 4px;
	}

	.export-result.success {
		color: #4ade80;
		background: rgba(22, 163, 74, 0.08);
	}

	.export-result.error {
		color: #f87171;
		background: rgba(220, 38, 38, 0.08);
	}
</style>
