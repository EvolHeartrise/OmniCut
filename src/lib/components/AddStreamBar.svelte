<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { addStream, streams, appMode } from '$lib/stores/streams.js';
	import type { ChannelInfo } from '$lib/types.js';

	const STORAGE_KEY = 'omni-channel-history';
	const POLL_INTERVAL = 30_000;

	let channelInput = $state('');
	let watchlist = $state<string[]>([]);
	let channelData = $state<ChannelInfo[]>([]);
	let loading = $state(false);
	let error = $state('');
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let now = $state(Date.now());
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	// Set of channel logins currently being captured
	let capturingLogins = $derived(
		new Set($streams.filter(s => s.sourceType === 'live' && s.status !== 'stopped').map(s => s.channel.toLowerCase()))
	);

	// Sorted channel list: live+capturing first, then live+available, then offline
	let sortedChannels = $derived.by(() => {
		const live: ChannelInfo[] = [];
		const offline: ChannelInfo[] = [];
		for (const ch of channelData) {
			if (ch.isLive) live.push(ch);
			else offline.push(ch);
		}
		// Within live, put capturing ones first
		live.sort((a, b) => {
			const aCap = capturingLogins.has(a.login.toLowerCase()) ? 0 : 1;
			const bCap = capturingLogins.has(b.login.toLowerCase()) ? 0 : 1;
			return aCap - bCap;
		});
		return [...live, ...offline];
	});

	function saveWatchlist() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
	}

	function addToWatchlist(channel: string) {
		const lower = channel.toLowerCase().trim();
		if (!lower) return;
		if (watchlist.includes(lower)) return;
		watchlist = [...watchlist, lower];
		saveWatchlist();
		fetchChannelData();
	}

	function removeFromWatchlist(login: string) {
		watchlist = watchlist.filter(w => w !== login);
		channelData = channelData.filter(c => c.login !== login);
		saveWatchlist();
	}

	async function fetchChannelData() {
		if (watchlist.length === 0) {
			channelData = [];
			return;
		}
		try {
			const res = await fetch('/api/channels/lookup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channels: watchlist })
			});
			const data = await res.json();
			channelData = data.channels;
		} catch (err) {
			console.error('Failed to fetch channel data:', err);
		}
	}

	async function handleCapture(channel: ChannelInfo) {
		if (!channel.isLive || capturingLogins.has(channel.login.toLowerCase())) return;
		loading = true;
		error = '';
		try {
			await addStream(channel.login);
			$appMode = 'clipping';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start capture';
		} finally {
			loading = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			const name = channelInput.trim();
			if (name) {
				addToWatchlist(name);
				channelInput = '';
			}
		}
	}

	function formatUptime(startedAt: string): string {
		const elapsed = now - new Date(startedAt).getTime();
		const hours = Math.floor(elapsed / 3_600_000);
		const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}

	function formatViewers(count: number): string {
		if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
		return String(count);
	}

	onMount(() => {
		try {
			watchlist = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
		} catch { watchlist = []; }
		fetchChannelData();
		pollTimer = setInterval(fetchChannelData, POLL_INTERVAL);
		tickTimer = setInterval(() => { now = Date.now(); }, 10_000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (tickTimer) clearInterval(tickTimer);
	});
</script>

<div class="add-stream-bar">
	<div class="input-group">
		<span class="input-prefix">twitch.tv/</span>
		<input
			type="text"
			bind:value={channelInput}
			onkeydown={handleKeydown}
			placeholder="channel name"
			class="channel-input"
		/>
		<button
			onclick={() => { addToWatchlist(channelInput); channelInput = ''; }}
			disabled={!channelInput.trim()}
			class="add-btn"
		>
			+ Add
		</button>
	</div>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	{#if sortedChannels.length > 0}
		<div class="channel-list">
			{#each sortedChannels as channel (channel.login)}
				{@const isCapturing = capturingLogins.has(channel.login.toLowerCase())}
				{@const isClickable = channel.isLive && !isCapturing && !loading}
				<div
					class="channel-row"
					class:offline={!channel.isLive}
					class:capturing={isCapturing}
					class:clickable={isClickable}
					onclick={() => isClickable && handleCapture(channel)}
					role={isClickable ? 'button' : undefined}
					tabindex={isClickable ? 0 : undefined}
					onkeydown={(e) => { if (isClickable && e.key === 'Enter') handleCapture(channel); }}
				>
					<div class="channel-pfp">
						{#if channel.profileImageUrl}
							<img src={channel.profileImageUrl} alt="" class="pfp-img" />
						{:else}
							<div class="pfp-placeholder"></div>
						{/if}
						{#if isCapturing}
							<span class="rec-dot"></span>
						{/if}
					</div>

					<div class="channel-info">
						<div class="channel-name-row">
							<span class="channel-name">{channel.displayName || channel.login}</span>
							{#if isCapturing}
								<span class="rec-badge">REC</span>
							{/if}
						</div>
						{#if channel.isLive && channel.title}
							<span class="channel-title" title={channel.title}>{channel.title}</span>
						{/if}
					</div>

					{#if channel.isLive}
						<div class="channel-meta">
							{#if channel.viewerCount != null}
								<span class="viewer-count">{formatViewers(channel.viewerCount)}</span>
							{/if}
							{#if channel.startedAt}
								<span class="uptime">{formatUptime(channel.startedAt)}</span>
							{/if}
						</div>
					{/if}

					<button
						class="remove-btn"
						onclick={(e) => { e.stopPropagation(); removeFromWatchlist(channel.login); }}
						title="Remove from watchlist"
					>&times;</button>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.add-stream-bar {
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-width: 560px;
	}

	.input-group {
		display: flex;
		align-items: center;
		gap: 0;
	}

	.input-prefix {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-right: none;
		border-radius: 6px 0 0 6px;
		padding: 5px 8px;
		color: #666;
		font-size: 0.8rem;
		font-family: monospace;
	}

	.channel-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-left: none;
		border-right: none;
		padding: 5px 10px;
		color: #e0e0ff;
		font-size: 0.8rem;
		outline: none;
		font-family: monospace;
		width: 150px;
	}

	.channel-input::placeholder {
		color: #444;
	}

	.channel-input:focus {
		border-color: #7c3aed;
	}

	.add-btn {
		background: #7c3aed;
		border: 1px solid #7c3aed;
		border-radius: 0 6px 6px 0;
		color: white;
		padding: 5px 12px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.2s;
	}

	.add-btn:hover:not(:disabled) {
		background: #6d28d9;
	}

	.add-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error {
		color: #ef4444;
		font-size: 0.8rem;
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.channel-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-radius: 6px;
		background: #12122a;
		transition: background 0.15s;
	}

	.channel-row.clickable {
		cursor: pointer;
	}

	.channel-row.clickable:hover {
		background: #1a1a3a;
	}

	.channel-row.offline {
		opacity: 0.4;
		cursor: default;
	}

	.channel-row.capturing {
		border-left: 3px solid #ef4444;
	}

	.channel-pfp {
		position: relative;
		flex-shrink: 0;
		width: 32px;
		height: 32px;
	}

	.pfp-img {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
	}

	.pfp-placeholder {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: #2a2a4a;
	}

	.rec-dot {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 10px;
		height: 10px;
		background: #ef4444;
		border-radius: 50%;
		border: 2px solid #12122a;
	}

	.channel-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.channel-name-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.channel-name {
		font-size: 0.85rem;
		font-weight: 600;
		color: #e0e0ff;
	}

	.rec-badge {
		font-size: 0.55rem;
		font-weight: 700;
		color: #ef4444;
		background: rgba(239, 68, 68, 0.15);
		padding: 1px 5px;
		border-radius: 3px;
		letter-spacing: 0.5px;
	}

	.channel-title {
		font-size: 0.7rem;
		color: #888;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.channel-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 1px;
		flex-shrink: 0;
	}

	.viewer-count {
		font-size: 0.75rem;
		color: #ef4444;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.uptime {
		font-size: 0.65rem;
		color: #666;
		font-family: monospace;
	}

	.remove-btn {
		background: none;
		border: none;
		color: #444;
		font-size: 1rem;
		cursor: pointer;
		padding: 2px 4px;
		line-height: 1;
		border-radius: 3px;
		flex-shrink: 0;
		transition: color 0.15s;
	}

	.remove-btn:hover {
		color: #ef4444;
	}
</style>
