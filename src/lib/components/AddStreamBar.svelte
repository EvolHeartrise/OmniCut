<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { addStream, streams } from '$lib/stores/streams.js';
	import type { ChannelInfo, VodInfo } from '$lib/types.js';
	import { formatUptime, formatViewers, formatVodDuration } from '$lib/utils.js';
	import {
		getWatchlist,
		addToWatchlistCmd,
		removeFromWatchlistCmd,
		lookupChannels,
		getAllChannelSettings,
		saveChannelSettingsCmd,
		getChannelVods
	} from '$lib/streams.remote.js';

	type Platform = 'twitch' | 'douyu';
	interface WatchlistEntry {
		login: string;
		platform: Platform;
	}

	const LEGACY_STORAGE_KEY = 'omni-channel-history';
	const POLL_INTERVAL = 30_000;

	const LANGUAGE_OPTIONS: { code: string; label: string; badge: string }[] = [
		{ code: '', label: 'Auto-detect', badge: '' },
		{ code: 'en', label: 'English', badge: 'EN' },
		{ code: 'ja', label: 'Japanese', badge: 'JA' },
		{ code: 'ko', label: 'Korean', badge: 'KO' },
		{ code: 'zh', label: 'Chinese', badge: 'ZH' },
		{ code: 'es', label: 'Spanish', badge: 'ES' },
		{ code: 'fr', label: 'French', badge: 'FR' },
		{ code: 'de', label: 'German', badge: 'DE' },
		{ code: 'pt', label: 'Portuguese', badge: 'PT' },
		{ code: 'ru', label: 'Russian', badge: 'RU' },
		{ code: 'it', label: 'Italian', badge: 'IT' },
		{ code: 'ar', label: 'Arabic', badge: 'AR' },
		{ code: 'th', label: 'Thai', badge: 'TH' },
		{ code: 'vi', label: 'Vietnamese', badge: 'VI' },
		{ code: 'id', label: 'Indonesian', badge: 'ID' },
		{ code: 'tr', label: 'Turkish', badge: 'TR' },
		{ code: 'pl', label: 'Polish', badge: 'PL' },
		{ code: 'uk', label: 'Ukrainian', badge: 'UK' },
		{ code: 'hi', label: 'Hindi', badge: 'HI' }
	];

	let channelInput = $state('');
	let watchlist = $state<WatchlistEntry[]>([]);
	let channelData = $state<ChannelInfo[]>([]);
	let loading = $state(false);
	let error = $state('');
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let now = $state(Date.now());
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	// Detect input type: VOD URL, Douyu URL/room, or Twitch channel
	let isVodInput = $derived(!!channelInput.match(/(?:twitch\.tv\/videos\/|^)(\d{8,})\b/));
	let isDouyuInput = $derived(!!channelInput.match(/douyu\.com\/(\d+)/) || !!channelInput.match(/^\d{6,7}$/));
	let inputPrefix = $derived(isVodInput ? 'twitch.tv/videos/' : isDouyuInput ? 'douyu.com/' : 'twitch.tv/');

	// Channel language settings (login → language code or null)
	let channelSettings = $state(new Map<string, string | null>());
	let settingsModalLogin = $state<string | null>(null);
	let settingsLanguage = $state('');

	// Set of channel logins currently being captured (live and vod separately)
	let capturingLogins = $derived(
		new Set(
			$streams.filter((s) => s.sourceType === 'live' && s.status !== 'stopped').map((s) => s.channel.toLowerCase())
		)
	);
	let capturingVodLogins = $derived(
		new Set(
			$streams.filter((s) => s.sourceType === 'vod' && s.status !== 'stopped').map((s) => s.channel.toLowerCase())
		)
	);

	// --- VOD browser state ---
	let expandedVodsLogin = $state<string | null>(null);
	let vodsData = $state<VodInfo[]>([]);
	let vodsLoading = $state(false);
	let vodsCursor = $state<string | null>(null);
	let vodsHasMore = $state(false);

	// Set of already-added VOD IDs (from sourceUrl)
	let addedVodIds = $derived(
		new Set(
			$streams
				.filter((s) => s.sourceType === 'vod' && s.sourceUrl)
				.map((s) => {
					const m = s.sourceUrl!.match(/videos\/(\d+)/);
					return m?.[1];
				})
				.filter(Boolean) as string[]
		)
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

	async function loadWatchlistData() {
		try {
			const data = await getWatchlist();
			watchlist = data.watchlist.map((e: { login: string; platform: string }) => ({
				login: e.login,
				platform: e.platform as Platform
			}));
		} catch (err) {
			console.error('Failed to load watchlist:', err);
		}
	}

	async function addToWatchlist(channel: string, platform: Platform = 'twitch') {
		const lower = channel.toLowerCase().trim();
		if (!lower) return;
		if (watchlist.some((w) => w.login === lower && w.platform === platform)) return;
		try {
			await addToWatchlistCmd({ login: lower, platform });
			watchlist = [...watchlist, { login: lower, platform }];
			fetchChannelData();
		} catch (err) {
			console.error('Failed to add to watchlist:', err);
		}
	}

	async function removeFromWatchlist(login: string, platform: Platform) {
		try {
			await removeFromWatchlistCmd({ login, platform });
			watchlist = watchlist.filter((w) => !(w.login === login && w.platform === platform));
			channelData = channelData.filter((c) => !(c.login === login && c.platform === platform));
		} catch (err) {
			console.error('Failed to remove from watchlist:', err);
		}
	}

	async function fetchChannelData() {
		if (watchlist.length === 0) {
			channelData = [];
			return;
		}
		try {
			// Group by platform and fetch each batch
			const byPlatform = new Map<Platform, string[]>();
			for (const entry of watchlist) {
				const list = byPlatform.get(entry.platform) || [];
				list.push(entry.login);
				byPlatform.set(entry.platform, list);
			}

			const results: ChannelInfo[] = [];
			const fetches = [...byPlatform.entries()].map(async ([platform, channels]) => {
				const data = await lookupChannels({ channels, platform });
				results.push(...data.channels);
			});
			await Promise.all(fetches);
			channelData = results;
		} catch (err) {
			console.error('Failed to fetch channel data:', err);
		}
	}

	async function fetchChannelSettings() {
		try {
			const data = await getAllChannelSettings();
			const map = new Map<string, string | null>();
			for (const s of data.settings) {
				map.set(s.login, s.language);
			}
			channelSettings = map;
		} catch (err) {
			console.error('Failed to fetch channel settings:', err);
		}
	}

	function openSettingsModal(login: string) {
		settingsModalLogin = login;
		settingsLanguage = channelSettings.get(login) || '';
	}

	async function saveSettings() {
		if (!settingsModalLogin) return;
		const login = settingsModalLogin;
		const language = settingsLanguage || null;
		try {
			await saveChannelSettingsCmd({ login, language });
			const updated = new Map(channelSettings);
			if (language) {
				updated.set(login, language);
			} else {
				updated.delete(login);
			}
			channelSettings = updated;
		} catch (err) {
			console.error('Failed to save channel settings:', err);
		}
		settingsModalLogin = null;
	}

	function getLanguageBadge(login: string): string {
		const lang = channelSettings.get(login);
		if (!lang) return '';
		const opt = LANGUAGE_OPTIONS.find((o) => o.code === lang);
		return opt?.badge || lang.toUpperCase();
	}

	async function handleAddStream(channel: ChannelInfo) {
		if (!channel.isLive || capturingLogins.has(channel.login.toLowerCase())) return;
		loading = true;
		error = '';
		try {
			const lang = channelSettings.get(channel.login) || undefined;
			await addStream(channel.login, { language: lang, platform: channel.platform });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start capture';
		} finally {
			loading = false;
		}
	}

	async function handleAddVod(channel: ChannelInfo) {
		if (!channel.isLive || !channel.hasVod || capturingVodLogins.has(channel.login.toLowerCase())) return;
		loading = true;
		error = '';
		try {
			const lang = channelSettings.get(channel.login) || undefined;
			await addStream(channel.login, { language: lang, vod: true });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start VOD capture';
		} finally {
			loading = false;
		}
	}

	function parseVodUrl(input: string): string | null {
		const m = input.match(/(?:twitch\.tv\/videos\/|^)(\d{8,})\b/);
		return m ? m[1] : null;
	}

	function parseDouyuInput(input: string): string | null {
		const urlMatch = input.match(/douyu\.com\/(\d+)/);
		if (urlMatch) return urlMatch[1];
		// Bare 6-7 digit number → Douyu room ID (8+ digits → Twitch VOD)
		if (/^\d{6,7}$/.test(input)) return input;
		return null;
	}

	async function handleAddVodByUrl(vodUrl: string) {
		loading = true;
		error = '';
		try {
			await addStream('_vod', { vodUrl });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to add VOD';
		} finally {
			loading = false;
		}
	}

	// --- VOD browser functions ---

	async function fetchVods(login: string, after?: string) {
		vodsLoading = true;
		try {
			const data = await getChannelVods({ login, first: 20, after });
			if (after) {
				vodsData = [...vodsData, ...data.vods];
			} else {
				vodsData = data.vods;
			}
			vodsCursor = data.cursor;
			vodsHasMore = data.hasNextPage;
		} catch (err) {
			console.error('Failed to fetch VODs:', err);
		} finally {
			vodsLoading = false;
		}
	}

	function toggleVodBrowser(login: string) {
		if (expandedVodsLogin === login) {
			expandedVodsLogin = null;
			vodsData = [];
			vodsCursor = null;
			vodsHasMore = false;
		} else {
			expandedVodsLogin = login;
			vodsData = [];
			vodsCursor = null;
			vodsHasMore = false;
			fetchVods(login);
		}
	}

	async function handleAddVodById(vodId: string) {
		loading = true;
		error = '';
		try {
			const lang = expandedVodsLogin ? channelSettings.get(expandedVodsLogin) || undefined : undefined;
			await addStream('_vod', { vodUrl: `https://twitch.tv/videos/${vodId}`, language: lang });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to add VOD';
		} finally {
			loading = false;
		}
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function formatVodViews(count: number | null): string {
		if (count == null) return '';
		if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
		if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
		return String(count);
	}

	function handleSubmit() {
		const value = channelInput.trim();
		if (!value) return;

		// Check Douyu first
		if (isDouyuInput) {
			const roomId = parseDouyuInput(value);
			if (roomId) {
				channelInput = '';
				addToWatchlist(roomId, 'douyu');
				return;
			}
		}

		const vodId = parseVodUrl(value);
		if (vodId) {
			channelInput = '';
			handleAddVodByUrl(value);
		} else {
			// Clean Twitch URL if pasted
			const cleaned = value
				.replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
				.replace(/\/.*$/, '')
				.trim()
				.toLowerCase();
			addToWatchlist(cleaned, 'twitch');
			channelInput = '';
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			handleSubmit();
		}
	}

	function handleWatchlistAdd(e: Event) {
		const login = (e as CustomEvent<string>).detail;
		if (login) addToWatchlist(login, 'twitch');
	}

	/** Migrate any existing localStorage watchlist entries to the server */
	async function migrateLocalStorage() {
		try {
			const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
			if (!raw) return;
			const old: string[] = JSON.parse(raw);
			if (!Array.isArray(old) || old.length === 0) {
				localStorage.removeItem(LEGACY_STORAGE_KEY);
				return;
			}
			// Add each to server as Twitch
			await Promise.all(
				old.map((login) => addToWatchlistCmd({ login: login.toLowerCase().trim(), platform: 'twitch' }))
			);
			localStorage.removeItem(LEGACY_STORAGE_KEY);
		} catch {
			// Non-fatal — keep localStorage for next attempt
		}
	}

	onMount(async () => {
		await migrateLocalStorage();
		await loadWatchlistData();
		fetchChannelData();
		fetchChannelSettings();
		pollTimer = setInterval(fetchChannelData, POLL_INTERVAL);
		tickTimer = setInterval(() => {
			now = Date.now();
		}, 10_000);
		window.addEventListener('watchlist-add', handleWatchlistAdd);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (tickTimer) clearInterval(tickTimer);
		if (typeof window !== 'undefined') {
			window.removeEventListener('watchlist-add', handleWatchlistAdd);
		}
	});
</script>

<div class="add-stream-bar">
	<div class="input-group">
		<span class="input-prefix">{inputPrefix}</span>
		<input
			type="text"
			bind:value={channelInput}
			onkeydown={handleKeydown}
			placeholder="channel name or VOD URL"
			class="channel-input"
		/>
		<button onclick={handleSubmit} disabled={!channelInput.trim() || loading} class="add-btn">
			{isVodInput ? '+ Add VOD' : isDouyuInput ? '+ Add DY' : '+ Add'}
		</button>
	</div>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	{#if sortedChannels.length > 0}
		<div class="channel-list">
			{#each sortedChannels as channel (channel.login)}
				{@const isCapturing = capturingLogins.has(channel.login.toLowerCase())}
				{@const isVodCapturing = capturingVodLogins.has(channel.login.toLowerCase())}
				{@const langBadge = getLanguageBadge(channel.login)}
				<div class="channel-row" class:offline={!channel.isLive} class:capturing={isCapturing}>
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
							{#if channel.platform === 'douyu'}
								<span class="dy-badge">DY</span>
							{/if}
							{#if isCapturing}
								<span class="rec-badge">REC</span>
							{/if}
							{#if isVodCapturing}
								<span class="vod-rec-badge">VOD</span>
							{/if}
							{#if langBadge}
								<span class="lang-badge">{langBadge}</span>
							{/if}
							{#if channel.isLive && channel.gameName}
								<span class="game-name">{channel.gameName}</span>
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
								<span class="uptime">{formatUptime(channel.startedAt, now)}</span>
							{/if}
						</div>

						<div class="capture-actions">
							<button class="capture-btn" disabled={isCapturing || loading} onclick={() => handleAddStream(channel)}
								>Stream</button
							>
							{#if channel.hasVod}
								<button
									class="capture-btn vod"
									disabled={isVodCapturing || loading}
									onclick={() => handleAddVod(channel)}>VOD</button
								>
							{/if}
						</div>
					{/if}

					{#if channel.platform === 'twitch'}
						<button
							class="vods-btn"
							class:active={expandedVodsLogin === channel.login}
							onclick={() => toggleVodBrowser(channel.login)}
							title="Browse past VODs">VODs</button
						>
					{/if}

					<button class="settings-btn" onclick={() => openSettingsModal(channel.login)} title="Language settings">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
							<path
								d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"
							/>
							<path
								d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"
							/>
						</svg>
					</button>

					<button
						class="remove-btn"
						onclick={() => removeFromWatchlist(channel.login, channel.platform)}
						title="Remove from watchlist">&times;</button
					>
				</div>

				{#if expandedVodsLogin === channel.login}
					<div class="vod-browser">
						{#if vodsLoading && vodsData.length === 0}
							<div class="vod-loading">Loading VODs...</div>
						{:else if vodsData.length === 0 && !vodsLoading}
							<div class="vod-empty">No past broadcasts found</div>
						{:else}
							{#each vodsData as vod (vod.id)}
								{@const isAdded = addedVodIds.has(vod.id)}
								<div class="vod-row">
									{#if vod.thumbnailUrl}
										<img src={vod.thumbnailUrl} alt="" class="vod-thumb" />
									{:else}
										<div class="vod-thumb-placeholder"></div>
									{/if}
									<div class="vod-info">
										<span class="vod-title" title={vod.title || ''}>{vod.title || 'Untitled'}</span>
										<span class="vod-meta">
											{formatDate(vod.createdAt)}
											{#if vod.durationSeconds}&nbsp;&middot; {formatVodDuration(vod.durationSeconds)}{/if}
											{#if vod.viewCount != null}&nbsp;&middot; {formatVodViews(vod.viewCount)} views{/if}
										</span>
									</div>
									<button class="vod-add-btn" disabled={isAdded || loading} onclick={() => handleAddVodById(vod.id)}
										>{isAdded ? 'Added' : '+ Add'}</button
									>
								</div>
							{/each}
							{#if vodsHasMore}
								<button
									class="vod-load-more"
									disabled={vodsLoading}
									onclick={() => fetchVods(channel.login, vodsCursor ?? undefined)}
									>{vodsLoading ? 'Loading...' : 'Load more'}</button
								>
							{/if}
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>

{#if settingsModalLogin}
	{@const modalChannel = channelData.find((c) => c.login === settingsModalLogin)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="modal-backdrop"
		onclick={() => {
			settingsModalLogin = null;
		}}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-panel" onclick={(e) => e.stopPropagation()}>
			<h3 class="modal-title">
				Settings: {modalChannel?.displayName || settingsModalLogin}
			</h3>

			<label class="modal-label">
				Transcription language
				<select class="modal-select" bind:value={settingsLanguage}>
					{#each LANGUAGE_OPTIONS as opt}
						<option value={opt.code}>{opt.label}</option>
					{/each}
				</select>
			</label>

			<p class="modal-hint">
				Non-English languages will be auto-translated to English. Changes apply to new captures only.
			</p>

			<div class="modal-actions">
				<button
					class="modal-btn cancel"
					onclick={() => {
						settingsModalLogin = null;
					}}>Cancel</button
				>
				<button class="modal-btn save" onclick={saveSettings}>Save</button>
			</div>
		</div>
	</div>
{/if}

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
		width: 200px;
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

	.vod-rec-badge {
		font-size: 0.55rem;
		font-weight: 700;
		color: #d97706;
		background: rgba(217, 119, 6, 0.15);
		padding: 1px 5px;
		border-radius: 3px;
		letter-spacing: 0.5px;
	}

	.dy-badge {
		font-size: 0.55rem;
		font-weight: 700;
		color: #d97706;
		background: rgba(217, 119, 6, 0.15);
		padding: 1px 5px;
		border-radius: 3px;
		letter-spacing: 0.5px;
	}

	.lang-badge {
		font-size: 0.55rem;
		font-weight: 700;
		color: #7c3aed;
		background: rgba(124, 58, 237, 0.15);
		padding: 1px 5px;
		border-radius: 3px;
		letter-spacing: 0.5px;
	}

	.game-name {
		font-size: 0.65rem;
		color: #7c3aed;
		background: rgba(124, 58, 237, 0.12);
		padding: 1px 6px;
		border-radius: 3px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 180px;
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

	.capture-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.capture-btn {
		background: #7c3aed;
		border: 1px solid #7c3aed;
		border-radius: 4px;
		color: white;
		padding: 3px 10px;
		font-size: 0.65rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.15s,
			opacity 0.15s;
	}

	.capture-btn:hover:not(:disabled) {
		background: #6d28d9;
	}

	.capture-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.capture-btn.vod {
		background: transparent;
		border-color: #d97706;
		color: #d97706;
	}

	.capture-btn.vod:hover:not(:disabled) {
		background: rgba(217, 119, 6, 0.15);
	}

	.settings-btn {
		background: none;
		border: none;
		color: #555;
		cursor: pointer;
		padding: 4px;
		line-height: 1;
		border-radius: 3px;
		flex-shrink: 0;
		transition: color 0.15s;
		display: flex;
		align-items: center;
	}

	.settings-btn:hover {
		color: #7c3aed;
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

	/* Settings modal */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal-panel {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		padding: 20px 24px;
		min-width: 300px;
		max-width: 400px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.modal-title {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: #e0e0ff;
	}

	.modal-label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 0.8rem;
		color: #aaa;
	}

	.modal-select {
		background: #12122a;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 6px 10px;
		color: #e0e0ff;
		font-size: 0.85rem;
		outline: none;
	}

	.modal-select:focus {
		border-color: #7c3aed;
	}

	.modal-hint {
		font-size: 0.7rem;
		color: #666;
		margin: 0;
		line-height: 1.4;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}

	.modal-btn {
		padding: 5px 16px;
		border-radius: 6px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: background 0.15s;
	}

	.modal-btn.cancel {
		background: #2a2a4a;
		color: #aaa;
	}

	.modal-btn.cancel:hover {
		background: #3a3a5a;
	}

	.modal-btn.save {
		background: #7c3aed;
		color: white;
	}

	.modal-btn.save:hover {
		background: #6d28d9;
	}

	/* VOD browser */
	.vods-btn {
		background: none;
		border: 1px solid #555;
		color: #888;
		font-size: 0.6rem;
		font-weight: 600;
		padding: 2px 7px;
		border-radius: 3px;
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s;
	}

	.vods-btn:hover {
		border-color: #d97706;
		color: #d97706;
	}

	.vods-btn.active {
		background: rgba(217, 119, 6, 0.15);
		border-color: #d97706;
		color: #d97706;
	}

	.vod-browser {
		margin-left: 42px;
		padding: 8px 0 8px 12px;
		border-left: 2px solid #d97706;
		background: rgba(217, 119, 6, 0.04);
		border-radius: 0 6px 6px 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.vod-loading,
	.vod-empty {
		font-size: 0.7rem;
		color: #666;
		padding: 6px 0;
	}

	.vod-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 4px 0;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.vod-row:hover {
		background: rgba(255, 255, 255, 0.03);
	}

	.vod-thumb {
		width: 80px;
		height: 45px;
		border-radius: 3px;
		object-fit: cover;
		flex-shrink: 0;
		background: #1a1a2e;
	}

	.vod-thumb-placeholder {
		width: 80px;
		height: 45px;
		border-radius: 3px;
		background: #1a1a2e;
		flex-shrink: 0;
	}

	.vod-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.vod-title {
		font-size: 0.72rem;
		color: #ccc;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.vod-meta {
		font-size: 0.6rem;
		color: #666;
	}

	.vod-add-btn {
		background: transparent;
		border: 1px solid #d97706;
		color: #d97706;
		font-size: 0.6rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		flex-shrink: 0;
		white-space: nowrap;
		transition: background 0.15s;
	}

	.vod-add-btn:hover:not(:disabled) {
		background: rgba(217, 119, 6, 0.15);
	}

	.vod-add-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.vod-load-more {
		background: none;
		border: 1px solid #333;
		color: #888;
		font-size: 0.65rem;
		padding: 4px 12px;
		border-radius: 4px;
		cursor: pointer;
		align-self: center;
		margin-top: 4px;
		transition: all 0.15s;
	}

	.vod-load-more:hover:not(:disabled) {
		border-color: #d97706;
		color: #d97706;
	}

	.vod-load-more:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
