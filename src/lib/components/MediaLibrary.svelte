<script lang="ts">
	import {
		streams,
		clipRegions,
		removeStream,
		retranscribeStream,
		resumeVodStream,
		refetchVodChat,
		stopStream
	} from '$lib/stores/streams.js';
	import { formatBytes } from '$lib/utils.js';

	let clipCounts = $derived(
		$clipRegions.reduce<Record<string, number>>((acc, clip) => {
			acc[clip.streamId] = (acc[clip.streamId] || 0) + 1;
			return acc;
		}, {})
	);

	let confirmingId = $state<string | null>(null);
	let confirmTimer: ReturnType<typeof setTimeout> | null = null;

	let sorted = $derived([...$streams].sort((a, b) => b.startedAt - a.startedAt));

	function statusColor(status: string): string {
		switch (status) {
			case 'capturing':
				return '#22c55e';
			case 'starting':
				return '#eab308';
			case 'stopped':
				return '#666';
			case 'error':
				return '#dc2626';
			default:
				return '#666';
		}
	}

	function formatDate(epochMs: number): string {
		return new Date(epochMs).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function handleDelete(id: string) {
		if (confirmingId === id) {
			if (confirmTimer) clearTimeout(confirmTimer);
			confirmTimer = null;
			confirmingId = null;
			removeStream(id);
		} else {
			if (confirmTimer) clearTimeout(confirmTimer);
			confirmingId = id;
			confirmTimer = setTimeout(() => {
				confirmingId = null;
				confirmTimer = null;
			}, 3000);
		}
	}
</script>

<div class="media-library">
	{#if sorted.length === 0}
		<p class="empty">No media recorded yet</p>
	{:else}
		<div class="media-list">
			{#each sorted as stream (stream.id)}
				<div class="media-row">
					<span class="status-dot" style="background:{statusColor(stream.status)}" title={stream.status}></span>

					<span class="channel">
						{stream.channel}
						{#if stream.platform === 'douyu'}<span class="platform-badge">DY</span>{/if}
					</span>

					<span class="type-badge" class:vod={stream.sourceType === 'vod'}>
						{stream.sourceType === 'vod' ? 'VOD' : 'Live'}
					</span>

					<span class="title" title={stream.streamTitle || ''}>
						{stream.streamTitle || ''}
					</span>

					<span class="meta">{formatBytes(stream.diskUsageBytes)}</span>

					{#if stream.chatMessageCount > 0}
						<span class="meta chat">{stream.chatMessageCount.toLocaleString()} msgs</span>
					{/if}

					{#if stream.transcriptionCount > 0}
						<span class="meta transcript">{stream.transcriptionCount.toLocaleString()} transcripts</span>
					{/if}

					{#if clipCounts[stream.id]}
						<span class="meta clips">{clipCounts[stream.id]} clip{clipCounts[stream.id] !== 1 ? 's' : ''}</span>
					{/if}

					<span class="meta date">{formatDate(stream.startedAt)}</span>

					<span class="actions">
						{#if stream.status === 'capturing' && stream.sourceType === 'vod'}
							<button class="btn-action btn-stop" onclick={() => stopStream(stream.id)} title="Stop downloading"
								>Stop</button
							>
						{/if}
						{#if stream.status === 'stopped'}
							{#if stream.sourceType === 'vod' && stream.platform === 'twitch'}
								<button
									class="btn-action btn-resume"
									onclick={() => resumeVodStream(stream.id)}
									title="Resume VOD download">Resume</button
								>
							{/if}
							{#if stream.platform === 'twitch' && !stream.chatComplete}
								<button
									class="btn-action btn-refetch"
									onclick={() => refetchVodChat(stream.id)}
									title="Refetch VOD chat from Twitch">Chat</button
								>
							{/if}
							<button
								class="btn-action btn-retranscribe"
								onclick={() => retranscribeStream(stream.id)}
								title="Re-transcribe entire recording">Transcribe</button
							>
						{/if}
					</span>

					<button
						class="btn-delete"
						class:confirming={confirmingId === stream.id}
						onclick={() => handleDelete(stream.id)}
					>
						{confirmingId === stream.id ? 'Confirm?' : 'Delete'}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.media-library {
		background: #0f0f23;
		border: 1px solid #1a1a2e;
		border-radius: 8px;
		padding: 16px;
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.empty {
		color: #555;
		font-size: 0.8rem;
		text-align: center;
		padding: 24px 0;
	}

	.media-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.media-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-radius: 4px;
		background: #1a1a2e;
		transition: background 0.15s;
	}

	.media-row:hover {
		background: #222244;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.channel {
		font-weight: 700;
		font-size: 0.8rem;
		color: #e0e0ff;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.platform-badge {
		font-size: 0.6rem;
		font-weight: 700;
		color: #f59e0b;
		margin-left: 3px;
		vertical-align: super;
	}

	.type-badge {
		font-size: 0.6rem;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 3px;
		background: #22c55e22;
		color: #22c55e;
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.type-badge.vod {
		background: #d9770622;
		color: #d97706;
	}

	.title {
		font-size: 0.75rem;
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.meta {
		font-size: 0.7rem;
		color: #666;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.meta.chat {
		color: #7c3aed;
	}

	.meta.transcript {
		color: #0891b2;
	}

	.meta.clips {
		color: #e67e22;
	}

	.meta.date {
		color: #555;
	}

	.actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.btn-action {
		font-size: 0.6rem;
		font-weight: 700;
		padding: 2px 6px;
		border-radius: 4px;
		border: 1px solid;
		background: transparent;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition:
			background 0.15s,
			color 0.15s;
		flex-shrink: 0;
	}

	.btn-stop {
		border-color: #d97706;
		color: #d97706;
	}

	.btn-stop:hover {
		background: #d97706;
		color: #000;
	}

	.btn-resume {
		border-color: #22c55e;
		color: #22c55e;
	}

	.btn-resume:hover {
		background: #22c55e;
		color: #000;
	}

	.btn-refetch {
		border-color: #3b82f6;
		color: #3b82f6;
	}

	.btn-refetch:hover {
		background: #3b82f6;
		color: #fff;
	}

	.btn-retranscribe {
		border-color: #7c3aed;
		color: #7c3aed;
	}

	.btn-retranscribe:hover {
		background: #7c3aed;
		color: #fff;
	}

	.btn-delete {
		font-size: 0.6rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 4px;
		border: 1px solid #444;
		background: transparent;
		color: #888;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
		flex-shrink: 0;
	}

	.btn-delete:hover {
		border-color: #dc2626;
		color: #dc2626;
	}

	.btn-delete.confirming {
		background: #dc2626;
		border-color: #dc2626;
		color: #fff;
	}
</style>
