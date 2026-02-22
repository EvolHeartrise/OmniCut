<script lang="ts">
	import { clipRegions, streams, syncOffsets, exportLog } from '$lib/stores/streams.js';
	import { formatDuration } from '$lib/utils.js';
	import { exportVideoCmd } from '$lib/streams.remote.js';

	let filename = $state('export');
	let exporting = $state(false);
	let result = $state<{ success: boolean; message: string } | null>(null);
	let logEl = $state<HTMLDivElement | null>(null);

	let sortedClips = $derived([...$clipRegions].sort((a, b) => a.startTime - b.startTime));

	let clipSummary = $derived(
		sortedClips.map((clip) => {
			const stream = $streams.find((s) => s.id === clip.streamId);
			const dur = clip.endTime - clip.startTime;
			return {
				channel: stream?.channel || 'unknown',
				duration: dur,
				title: clip.title || 'Untitled'
			};
		})
	);

	let totalDuration = $derived(clipSummary.reduce((sum, c) => sum + c.duration, 0));

	let chaptersText = $derived.by(() => {
		let offset = 0;
		return clipSummary
			.map((clip) => {
				const mins = Math.floor(offset / 60);
				const secs = Math.floor(offset % 60);
				const ts = `${mins}:${secs.toString().padStart(2, '0')}`;
				const line = `${ts} ${clip.title}`;
				offset += clip.duration;
				return line;
			})
			.join('\n');
	});

	let chaptersCopied = $state(false);

	function copyChapters() {
		navigator.clipboard.writeText(chaptersText).then(() => {
			chaptersCopied = true;
			setTimeout(() => (chaptersCopied = false), 2000);
		});
	}

	// Auto-scroll log when new entries arrive
	$effect(() => {
		if ($exportLog.length > 0 && logEl) {
			logEl.scrollTop = logEl.scrollHeight;
		}
	});

	async function handleExport() {
		if (!filename.trim() || exporting) return;
		exporting = true;
		result = null;
		exportLog.set([]);
		try {
			const data = await exportVideoCmd({ filename: filename.trim() });
			result = { success: true, message: `Export queued (ID: ${data.exportId}). Encoding in background.` };
		} catch (err) {
			result = { success: false, message: err instanceof Error ? err.message : 'Export failed' };
		} finally {
			exporting = false;
		}
	}
</script>

<div class="export-panel">
	<div class="export-card">
		<h2 class="export-title">Export Video</h2>

		{#if sortedClips.length === 0}
			<p class="empty-message">No clip regions to export. Mark clips in Clipping mode first.</p>
		{:else}
			<div class="clip-list">
				<div class="clip-list-header">
					{sortedClips.length} clips — {formatDuration(totalDuration)} total
				</div>
				{#each clipSummary as clip, i}
					<div class="clip-row">
						<span class="clip-index">{i + 1}</span>
						<span class="clip-title">{clip.title}</span>
						<span class="clip-duration">{formatDuration(clip.duration)}</span>
					</div>
				{/each}
			</div>

			<div class="chapters-section">
				<div class="chapters-header">
					<span class="chapters-label">YouTube Chapters</span>
					<button class="btn-copy" onclick={copyChapters}>
						{chaptersCopied ? 'Copied!' : 'Copy'}
					</button>
				</div>
				<textarea class="chapters-text" readonly rows="6">{chaptersText}</textarea>
			</div>

			<div class="export-form">
				<div class="filename-row">
					<input
						type="text"
						class="filename-input"
						bind:value={filename}
						placeholder="filename"
						disabled={exporting}
						onkeydown={(e) => {
							if (e.key === 'Enter') handleExport();
						}}
					/>
					<span class="filename-ext">.mp4</span>
				</div>
				<button class="btn-export" onclick={handleExport} disabled={exporting || !filename.trim()}>
					{exporting ? 'Exporting...' : 'Export'}
				</button>
			</div>

			{#if $exportLog.length > 0}
				{@const latest = $exportLog[$exportLog.length - 1]}
				{@const progress = latest.totalSteps > 0 ? (latest.step / latest.totalSteps) * 100 : 0}
				<div class="export-log">
					<div class="progress-bar">
						<div class="progress-fill" style="width: {progress}%"></div>
					</div>
					<div class="log-entries" bind:this={logEl}>
						{#each $exportLog as entry}
							<div class="log-entry">{entry.message}</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if result}
				<div class="result" class:success={result.success} class:error={!result.success}>
					{result.message}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.export-panel {
		flex: 1;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 32px 24px;
		overflow: auto;
	}

	.export-card {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 8px;
		padding: 24px;
		width: 100%;
		max-width: 480px;
	}

	.export-title {
		font-size: 1rem;
		font-weight: 700;
		color: #e0e0ff;
		margin: 0 0 16px;
	}

	.empty-message {
		color: #666;
		font-size: 0.85rem;
	}

	.clip-list {
		margin-bottom: 20px;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		overflow: hidden;
	}

	.clip-list-header {
		font-size: 0.75rem;
		color: #aaa;
		padding: 6px 10px;
		background: #0f0f23;
		border-bottom: 1px solid #2a2a4a;
	}

	.clip-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		font-size: 0.75rem;
		border-bottom: 1px solid #111;
	}

	.clip-row:last-child {
		border-bottom: none;
	}

	.clip-index {
		color: #555;
		width: 20px;
		text-align: right;
		flex-shrink: 0;
	}

	.clip-title {
		color: #ccc;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.clip-duration {
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		flex-shrink: 0;
	}

	.chapters-section {
		margin-bottom: 20px;
	}

	.chapters-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}

	.chapters-label {
		font-size: 0.75rem;
		color: #aaa;
		font-weight: 600;
	}

	.btn-copy {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.7rem;
		padding: 3px 10px;
		border-radius: 4px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.btn-copy:hover {
		background: #3a3a5a;
	}

	.chapters-text {
		width: 100%;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		color: #e0e0ff;
		font-size: 0.72rem;
		font-family: monospace;
		padding: 8px 10px;
		resize: vertical;
		outline: none;
		line-height: 1.5;
		box-sizing: border-box;
	}

	.chapters-text:focus {
		border-color: #7c3aed;
	}

	.export-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.filename-row {
		display: flex;
		align-items: center;
		gap: 0;
	}

	.filename-input {
		flex: 1;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-right: none;
		border-radius: 6px 0 0 6px;
		color: #e0e0ff;
		font-size: 0.85rem;
		padding: 8px 12px;
		outline: none;
	}

	.filename-input:focus {
		border-color: #7c3aed;
	}

	.filename-input:disabled {
		opacity: 0.5;
	}

	.filename-ext {
		background: #2a2a4a;
		color: #888;
		font-size: 0.8rem;
		padding: 8px 10px;
		border-radius: 0 6px 6px 0;
		border: 1px solid #2a2a4a;
		line-height: 1.35;
	}

	.btn-export {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.85rem;
		font-weight: 600;
		padding: 10px 20px;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.btn-export:hover {
		background: #6d28d9;
	}

	.btn-export:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.export-log {
		margin-top: 16px;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		overflow: hidden;
	}

	.progress-bar {
		height: 4px;
		background: #0f0f23;
	}

	.progress-fill {
		height: 100%;
		background: #7c3aed;
		transition: width 0.3s ease;
	}

	.log-entries {
		max-height: 140px;
		overflow-y: auto;
		padding: 8px 10px;
		background: #0a0a1a;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.log-entry {
		font-size: 0.7rem;
		font-family: monospace;
		color: #888;
		padding: 2px 0;
	}

	.log-entry:last-child {
		color: #ccc;
	}

	.result {
		margin-top: 12px;
		font-size: 0.8rem;
		padding: 8px 12px;
		border-radius: 6px;
		word-break: break-all;
	}

	.result.success {
		background: rgba(22, 163, 74, 0.15);
		color: #4ade80;
		border: 1px solid rgba(22, 163, 74, 0.3);
	}

	.result.error {
		background: rgba(220, 38, 38, 0.15);
		color: #f87171;
		border: 1px solid rgba(220, 38, 38, 0.3);
	}
</style>
