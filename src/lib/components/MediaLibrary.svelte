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

	// --- Filters ---
	let filterChannel = $state('');
	let filterStatus = $state<'' | 'capturing' | 'stopped' | 'error'>('');
	// --- Sorting ---
	type SortKey = 'channel' | 'status' | 'date' | 'size' | 'chat' | 'transcripts' | 'clips';
	let sortKey = $state<SortKey>('date');
	let sortAsc = $state(false);

	let uniqueChannels = $derived(
		[...new Set($streams.map((s) => s.channel))].sort()
	);

	let filtered = $derived.by(() => {
		let list = [...$streams];
		if (filterChannel) list = list.filter((s) => s.channel === filterChannel);
		if (filterStatus) list = list.filter((s) => s.status === filterStatus);

		list.sort((a, b) => {
			let cmp = 0;
			switch (sortKey) {
				case 'channel':
					cmp = a.channel.localeCompare(b.channel);
					break;
				case 'status':
					cmp = a.status.localeCompare(b.status);
					break;
				case 'date':
					cmp = a.startedAt - b.startedAt;
					break;
				case 'size':
					cmp = a.diskUsageBytes - b.diskUsageBytes;
					break;
				case 'chat':
					cmp = a.chatMessageCount - b.chatMessageCount;
					break;
				case 'transcripts':
					cmp = a.transcriptionCount - b.transcriptionCount;
					break;
				case 'clips':
					cmp = (clipCounts[a.id] || 0) - (clipCounts[b.id] || 0);
					break;
			}
			return sortAsc ? cmp : -cmp;
		});
		return list;
	});

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			sortAsc = !sortAsc;
		} else {
			sortKey = key;
			sortAsc = key === 'channel';
		}
	}

	function sortIndicator(key: SortKey): string {
		if (sortKey !== key) return '';
		return sortAsc ? ' \u25B2' : ' \u25BC';
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'capturing':
				return '#22c55e';
			case 'starting':
				return '#eab308';
			case 'remuxing':
				return '#d97706';
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
	<div class="filters-bar">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="filter-group">
			<span class="filter-label">Channel</span>
			<select class="filter-select" bind:value={filterChannel}>
				<option value="">All</option>
				{#each uniqueChannels as ch}
					<option value={ch}>{ch}</option>
				{/each}
			</select>
		</label>
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="filter-group">
			<span class="filter-label">Status</span>
			<select class="filter-select" bind:value={filterStatus}>
				<option value="">All</option>
				<option value="capturing">Capturing</option>
				<option value="stopped">Stopped</option>
				<option value="error">Error</option>
			</select>
		</label>
		<div class="filter-spacer"></div>
		<span class="row-count">{filtered.length} of {$streams.length}</span>
	</div>

	{#if $streams.length === 0}
		<p class="empty">No media recorded yet</p>
	{:else}
		<div class="table-wrap">
			<table class="media-table">
				<thead>
					<tr>
						<th class="th-status"></th>
						<th class="th-sortable" onclick={() => toggleSort('channel')}>Channel{sortIndicator('channel')}</th>
						<th class="th-title">Title</th>
						<th class="th-sortable th-right" onclick={() => toggleSort('size')}>Size{sortIndicator('size')}</th>
						<th class="th-sortable th-right" onclick={() => toggleSort('chat')}>Chat{sortIndicator('chat')}</th>
						<th class="th-sortable th-right" onclick={() => toggleSort('transcripts')}>Trans.{sortIndicator('transcripts')}</th>
						<th class="th-sortable th-right" onclick={() => toggleSort('clips')}>Clips{sortIndicator('clips')}</th>
						<th class="th-sortable" onclick={() => toggleSort('date')}>Date{sortIndicator('date')}</th>
						<th class="th-actions">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as stream (stream.id)}
						<tr class="media-row">
							<td>
								<span class="status-dot" style="background:{statusColor(stream.status)}" title={stream.status}></span>
							</td>
							<td class="cell-channel">
								{stream.channel}
							</td>
							<td class="cell-title" title={stream.streamTitle || ''}>
								{stream.streamTitle || ''}
							</td>
							<td class="cell-right">{formatBytes(stream.diskUsageBytes)}</td>
							<td class="cell-right cell-chat">{stream.chatMessageCount > 0 ? stream.chatMessageCount.toLocaleString() : ''}</td>
							<td class="cell-right cell-transcript">{stream.transcriptionCount > 0 ? stream.transcriptionCount.toLocaleString() : ''}</td>
							<td class="cell-right cell-clips">{clipCounts[stream.id] || ''}</td>
							<td class="cell-date">{formatDate(stream.startedAt)}</td>
							<td class="cell-actions">
								{#if stream.status === 'capturing'}
									<button class="btn-action btn-stop" onclick={() => stopStream(stream.id)} title="Stop downloading">Stop</button>
								{/if}
								{#if stream.status === 'remuxing'}
									<span class="status-text">Remuxing...</span>
								{/if}
								{#if stream.status === 'stopped'}
									{#if stream.platform === 'twitch'}
										<button class="btn-action btn-resume" onclick={() => resumeVodStream(stream.id)} title="Resume VOD download">Resume</button>
									{/if}
									{#if stream.platform === 'twitch'}
										<button class="btn-action btn-refetch" onclick={() => refetchVodChat(stream.id)} title={stream.chatComplete ? 'Re-download chat (merges with existing)' : 'Download chat from Twitch'}>{stream.chatComplete ? 'Re-dl Chat' : 'Dl Chat'}</button>
									{/if}
									<button class="btn-action btn-retranscribe" onclick={() => retranscribeStream(stream.id)} title="Re-transcribe entire recording">Transcribe</button>
								{/if}
								<button
									class="btn-delete"
									class:confirming={confirmingId === stream.id}
									onclick={() => handleDelete(stream.id)}
								>
									{confirmingId === stream.id ? 'Confirm?' : 'Del'}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.media-library {
		background: #0f0f23;
		border: 1px solid #1a1a2e;
		border-radius: 8px;
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.filters-bar {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 10px 16px;
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

	.filter-select {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 4px 8px;
		border-radius: 4px;
		outline: none;
	}

	.filter-select:focus {
		border-color: #7c3aed;
	}

	.filter-spacer {
		flex: 1;
	}

	.row-count {
		font-size: 0.7rem;
		color: #666;
	}

	.empty {
		color: #555;
		font-size: 0.8rem;
		text-align: center;
		padding: 24px 0;
	}

	.table-wrap {
		flex: 1;
		min-height: 0;
		overflow: auto;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.media-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.75rem;
	}

	thead {
		position: sticky;
		top: 0;
		z-index: 1;
	}

	th {
		background: #13132a;
		color: #666;
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		padding: 6px 8px;
		text-align: left;
		white-space: nowrap;
		border-bottom: 1px solid #2a2a4a;
		user-select: none;
	}

	.th-sortable {
		cursor: pointer;
	}

	.th-sortable:hover {
		color: #aaa;
	}

	.th-right {
		text-align: right;
	}

	.th-status {
		width: 20px;
	}

	.th-title {
		width: 100%;
	}

	.th-actions {
		text-align: right;
	}

	.media-row {
		transition: background 0.1s;
	}

	.media-row:hover {
		background: #1a1a2e;
	}

	.media-row td {
		padding: 5px 8px;
		border-bottom: 1px solid #141428;
		vertical-align: middle;
		white-space: nowrap;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}

	.cell-channel {
		font-weight: 700;
		color: #e0e0ff;
	}

	.cell-title {
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 300px;
	}

	.cell-right {
		text-align: right;
		color: #666;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		font-size: 0.7rem;
	}

	.cell-chat {
		color: #7c3aed;
	}

	.cell-transcript {
		color: #0891b2;
	}

	.cell-clips {
		color: #e67e22;
	}

	.cell-date {
		color: #555;
		font-size: 0.7rem;
	}

	.cell-actions {
		text-align: right;
		white-space: nowrap;
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
		margin-left: 3px;
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

	.status-text {
		font-size: 0.65rem;
		color: #d97706;
		font-weight: 600;
	}

	.btn-delete {
		font-size: 0.6rem;
		font-weight: 700;
		padding: 2px 6px;
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
		margin-left: 3px;
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
