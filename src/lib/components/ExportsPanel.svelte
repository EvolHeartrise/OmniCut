<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { exportStatusEvents, exportLog } from '$lib/stores/streams.js';
	import { listExportsCmd } from '$lib/streams.remote';
	import { formatDuration } from '$lib/utils.js';

	interface ExportRecord {
		id: string;
		title: string;
		description?: string;
		clipIds: string[];
		status: 'pending' | 'exporting' | 'ready' | 'error';
		outputPath?: string;
		error?: string;
		createdAt: number;
		completedAt?: number;
	}

	let exports = $state<ExportRecord[]>([]);
	let loading = $state(true);

	onMount(() => {
		fetchExports();
	});

	async function fetchExports() {
		loading = true;
		try {
			const data = await listExportsCmd();
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

	function formatDate(epoch: number): string {
		return new Date(epoch * 1000).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Active export progress from SSE
	let activeProgress = $derived.by(() => {
		if ($exportLog.length === 0) return null;
		const latest = $exportLog[$exportLog.length - 1];
		return latest;
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
					<div class="export-item">
						<div class="export-item-header">
							<span class="export-item-title">{exp.title}</span>
							<span class="export-status {info.cls}">{info.label}</span>
						</div>
						{#if exp.description}
							<div class="export-description">{exp.description}</div>
						{/if}
						<div class="export-details">
							<span class="export-clips">{exp.clipIds.length} clip{exp.clipIds.length !== 1 ? 's' : ''}</span>
							<span class="export-date">{formatDate(exp.createdAt)}</span>
							{#if exp.completedAt}
								<span class="export-completed">Completed {formatDate(exp.completedAt)}</span>
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
		max-width: 640px;
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
</style>
