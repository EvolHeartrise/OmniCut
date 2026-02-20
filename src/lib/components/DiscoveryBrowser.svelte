<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { streams } from '$lib/stores/streams.js';
	import type { ChannelInfo } from '$lib/types.js';
	import { formatUptime, formatViewers } from '$lib/utils.js';
	import {
		browseStreams,
		searchCategories,
		ignoreChannelCmd,
		getIgnoredChannels,
		getWatchlist
	} from '$lib/streams.remote.js';

	const STORAGE_KEY = 'omni-discovery-categories';
	const VIEWER_STORAGE_KEY = 'omni-discovery-viewers';


	type FilterMode = 'include' | 'exclude';
	interface CategoryFilter {
		name: string;
		id: string;
		mode: FilterMode;
	}
	interface CategorySuggestion {
		id: string;
		name: string;
	}

	let categoryInput = $state('');
	let filterMode = $state<FilterMode>('include');
	let categories = $state<CategoryFilter[]>([]);
	let allStreams = $state<ChannelInfo[]>([]);
	let loading = $state(false);
	let loadingMore = $state(false);
	let error = $state('');
	let cursors = $state<Map<string, string | null>>(new Map());
	let hasMore = $state(true);

	let now = $state(Date.now());
	let tickTimer: ReturnType<typeof setInterval> | null = null;

	// Autocomplete state
	let suggestions = $state<CategorySuggestion[]>([]);
	let showSuggestions = $state(false);
	let selectedSuggestionIdx = $state(-1);
	let searchTimeout: ReturnType<typeof setTimeout> | null = null;
	let inputEl: HTMLInputElement | undefined = $state();

	// Watchlist tracking
	let watchlistLogins = $state<Set<string>>(new Set());

	// Ignored channels (persisted in DB)
	let ignoredLogins = $state<Set<string>>(new Set());

	// Viewer range state
	let viewerMin = $state('');
	let viewerMax = $state('');

	let capturingLogins = $derived(
		new Set($streams.filter(s => s.sourceType === 'live' && s.status !== 'stopped').map(s => s.channel.toLowerCase()))
	);

	let includeCategories = $derived(categories.filter(c => c.mode === 'include'));
	let excludeCategories = $derived(categories.filter(c => c.mode === 'exclude'));

	let parsedViewerMin = $derived(viewerMin ? parseInt(viewerMin, 10) : null);
	let parsedViewerMax = $derived(viewerMax ? parseInt(viewerMax, 10) : null);

	let hasViewerFilter = $derived(
		(parsedViewerMin != null && !isNaN(parsedViewerMin)) ||
		(parsedViewerMax != null && !isNaN(parsedViewerMax))
	);

	let displayStreams = $derived.by(() => {
		let result = allStreams;

		// Filter out ignored and watchlisted channels
		result = result.filter(s => {
			const login = s.login.toLowerCase();
			return !ignoredLogins.has(login) && !watchlistLogins.has(login);
		});

		if (excludeCategories.length > 0) {
			const excludeNames = new Set(excludeCategories.map(c => c.name.toLowerCase()));
			result = result.filter(s => !s.gameName || !excludeNames.has(s.gameName.toLowerCase()));
		}

		const min = parsedViewerMin;
		const max = parsedViewerMax;
		if (min != null && !isNaN(min)) {
			result = result.filter(s => (s.viewerCount ?? 0) >= min);
		}
		if (max != null && !isNaN(max)) {
			result = result.filter(s => (s.viewerCount ?? 0) <= max);
		}

		result.sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0));
		return result;
	});

	// Auto-backfill: if viewer range filtering hides everything but there are more pages, keep loading
	let backfilling = $state(false);
	let backfillAttempts = 0;
	const MAX_BACKFILL = 15; // max pages to auto-fetch (~300 streams scanned)

	// Reset backfill counter when viewer filter changes
	$effect(() => {
		// Just reading these to subscribe
		void parsedViewerMin;
		void parsedViewerMax;
		backfillAttempts = 0;
	});

	$effect(() => {
		const shouldBackfill = !loading && !loadingMore && !backfilling
			&& hasViewerFilter && hasMore
			&& allStreams.length > 0 && displayStreams.length < 5
			&& backfillAttempts < MAX_BACKFILL;
		if (shouldBackfill) {
			backfilling = true;
			backfillAttempts++;
			loadMore().finally(() => { backfilling = false; });
		}
	});

	function saveCategories() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(categories));
	}

	function saveViewerRange() {
		localStorage.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ min: viewerMin, max: viewerMax }));
	}

	function addCategoryFromSuggestion(suggestion: CategorySuggestion) {
		if (categories.some(c => c.id === suggestion.id && c.mode === filterMode)) return;
		categories = [...categories, { name: suggestion.name, id: suggestion.id, mode: filterMode }];
		categoryInput = '';
		suggestions = [];
		showSuggestions = false;
		selectedSuggestionIdx = -1;
		saveCategories();
		if (filterMode === 'include') fetchStreams();
	}

	function removeCategory(idx: number) {
		const wasInclude = categories[idx].mode === 'include';
		categories = categories.filter((_, i) => i !== idx);
		saveCategories();
		if (wasInclude) fetchStreams();
	}

	async function fetchSuggestions(q: string) {
		if (!q.trim()) {
			suggestions = [];
			showSuggestions = false;
			return;
		}
		try {
			const data = await searchCategories({ query: q });
			const cats: CategorySuggestion[] = data.categories ?? [];
			suggestions = cats;
			showSuggestions = suggestions.length > 0;
			selectedSuggestionIdx = -1;
		} catch {
			suggestions = [];
			showSuggestions = false;
		}
	}

	function handleCategoryInput() {
		if (searchTimeout) clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => fetchSuggestions(categoryInput), 200);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (showSuggestions && suggestions.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selectedSuggestionIdx = Math.min(selectedSuggestionIdx + 1, suggestions.length - 1);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				selectedSuggestionIdx = Math.max(selectedSuggestionIdx - 1, -1);
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				// If an item is highlighted use it, otherwise auto-select the first
				const idx = selectedSuggestionIdx >= 0 ? selectedSuggestionIdx : 0;
				addCategoryFromSuggestion(suggestions[idx]);
				return;
			}
			if (e.key === 'Escape') {
				showSuggestions = false;
				selectedSuggestionIdx = -1;
				return;
			}
		}
	}

	function handleInputFocus() {
		if (suggestions.length > 0) showSuggestions = true;
	}

	function handleInputBlur() {
		// Delay to allow click on suggestion
		setTimeout(() => { showSuggestions = false; }, 150);
	}

	function handleViewerChange() {
		saveViewerRange();
	}

	async function fetchBrowse(gameId?: string, after?: string): Promise<{ streams: ChannelInfo[]; cursor: string | null; hasNextPage: boolean }> {
		return browseStreams({ gameId, after });
	}

	async function fetchStreams() {
		loading = true;
		error = '';
		cursors = new Map();
		try {
			if (includeCategories.length === 0) {
				const data = await fetchBrowse();
				allStreams = data.streams;
				hasMore = data.hasNextPage;
				if (data.cursor) cursors.set('__all__', data.cursor);
			} else {
				const results = await Promise.all(
					includeCategories.map(c => fetchBrowse(c.id))
				);
				const seen = new Set<string>();
				const merged: ChannelInfo[] = [];
				const newCursors = new Map<string, string | null>();
				let anyHasMore = false;

				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					if (r.cursor) newCursors.set(includeCategories[i].id, r.cursor);
					if (r.hasNextPage) anyHasMore = true;
					for (const s of r.streams) {
						if (!seen.has(s.login)) {
							seen.add(s.login);
							merged.push(s);
						}
					}
				}
				merged.sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0));
				allStreams = merged;
				cursors = newCursors;
				hasMore = anyHasMore;
			}
		} catch (err) {
			console.error('Discovery fetch error:', err);
			error = 'Failed to load streams';
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		try {
			if (includeCategories.length === 0) {
				const after = cursors.get('__all__') ?? undefined;
				const data = await fetchBrowse(undefined, after);
				const seen = new Set(allStreams.map(s => s.login));
				const newStreams = data.streams.filter(s => !seen.has(s.login));
				allStreams = [...allStreams, ...newStreams];
				hasMore = data.hasNextPage;
				if (data.cursor) cursors.set('__all__', data.cursor);
			} else {
				const results = await Promise.all(
					includeCategories.map(c => fetchBrowse(c.id, cursors.get(c.id) ?? undefined))
				);
				const seen = new Set(allStreams.map(s => s.login));
				const newStreams: ChannelInfo[] = [];
				let anyHasMore = false;

				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					if (r.cursor) cursors.set(includeCategories[i].id, r.cursor);
					if (r.hasNextPage) anyHasMore = true;
					for (const s of r.streams) {
						if (!seen.has(s.login)) {
							seen.add(s.login);
							newStreams.push(s);
						}
					}
				}
				newStreams.sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0));
				allStreams = [...allStreams, ...newStreams];
				hasMore = anyHasMore;
			}
		} catch {
			error = 'Failed to load more streams';
		} finally {
			loadingMore = false;
		}
	}

	function addToWatchlist(channel: ChannelInfo) {
		const login = channel.login.toLowerCase();
		if (watchlistLogins.has(login)) return;
		window.dispatchEvent(new CustomEvent('watchlist-add', { detail: login }));
		watchlistLogins = new Set([...watchlistLogins, login]);
	}

	async function ignoreChannel(channel: ChannelInfo) {
		const login = channel.login.toLowerCase();
		if (ignoredLogins.has(login)) return;
		ignoredLogins = new Set([...ignoredLogins, login]);
		try {
			await ignoreChannelCmd({ login });
		} catch {
			// Revert on failure
			ignoredLogins = new Set([...ignoredLogins].filter(l => l !== login));
		}
	}

	onMount(() => {
		try {
			categories = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
		} catch { categories = []; }
		try {
			const saved = JSON.parse(localStorage.getItem(VIEWER_STORAGE_KEY) || '{}');
			viewerMin = saved.min ?? '';
			viewerMax = saved.max ?? '';
		} catch { /* ignore */ }
		getWatchlist().then(d => {
			watchlistLogins = new Set((d.watchlist ?? []).map((e: { login: string }) => e.login));
		}).catch(() => {});
		getIgnoredChannels().then(d => {
			ignoredLogins = new Set(d.channels ?? []);
		}).catch(() => {});
		fetchStreams();
		tickTimer = setInterval(() => { now = Date.now(); }, 10_000);
	});

	onDestroy(() => {
		if (tickTimer) clearInterval(tickTimer);
		if (searchTimeout) clearTimeout(searchTimeout);
	});
</script>

<div class="discovery-browser">
	<div class="filter-bar">
		<div class="input-wrapper">
			<div class="input-group">
				<button
					class="mode-toggle"
					class:include={filterMode === 'include'}
					class:exclude={filterMode === 'exclude'}
					onclick={() => filterMode = filterMode === 'include' ? 'exclude' : 'include'}
					title={filterMode === 'include' ? 'Include mode' : 'Exclude mode'}
				>
					{filterMode === 'include' ? '+' : '\u2212'}
				</button>
				<input
					type="text"
					bind:value={categoryInput}
					bind:this={inputEl}
					oninput={handleCategoryInput}
					onkeydown={handleKeydown}
					onfocus={handleInputFocus}
					onblur={handleInputBlur}
					placeholder="category name"
					class="category-input"
					autocomplete="off"
				/>
				<button
					onclick={async () => {
					if (suggestions.length > 0) {
						addCategoryFromSuggestion(suggestions[selectedSuggestionIdx >= 0 ? selectedSuggestionIdx : 0]);
					} else if (categoryInput.trim()) {
						await fetchSuggestions(categoryInput);
						if (suggestions.length > 0) addCategoryFromSuggestion(suggestions[0]);
					}
				}}
					disabled={!categoryInput.trim()}
					class="add-btn"
				>
					Add
				</button>
			</div>

			{#if showSuggestions && suggestions.length > 0}
				<div class="suggestions-dropdown">
					{#each suggestions as suggestion, i}
						<button
							class="suggestion-item"
							class:selected={i === selectedSuggestionIdx}
							onmousedown={(e) => { e.preventDefault(); addCategoryFromSuggestion(suggestion); }}
							onmouseenter={() => selectedSuggestionIdx = i}
						>
							{suggestion.name}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="viewer-range">
			<span class="viewer-range-label">Viewers</span>
			<input
				type="number"
				bind:value={viewerMin}
				oninput={handleViewerChange}
				placeholder="min"
				class="viewer-input"
				min="0"
			/>
			<span class="viewer-range-sep">&ndash;</span>
			<input
				type="number"
				bind:value={viewerMax}
				oninput={handleViewerChange}
				placeholder="max"
				class="viewer-input"
				min="0"
			/>
		</div>

		{#if categories.length > 0}
			<div class="category-pills">
				{#each categories as cat, i}
					<span class="pill" class:pill-include={cat.mode === 'include'} class:pill-exclude={cat.mode === 'exclude'}>
						<span class="pill-mode">{cat.mode === 'include' ? '+' : '\u2212'}</span>
						{cat.name}
						<button class="pill-remove" onclick={() => removeCategory(i)}>&times;</button>
					</span>
				{/each}
			</div>
		{/if}
	</div>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	{#if backfilling}
		<p class="loading-text">Searching for streams in viewer range...</p>
	{/if}

	{#if hasMore && !backfilling}
		<button
			class="load-more-btn"
			onclick={loadMore}
			disabled={loadingMore}
		>
			{loadingMore ? 'Loading...' : 'Load more'}
		</button>
	{/if}

	{#if loading && allStreams.length === 0}
		<p class="loading-text">Loading streams...</p>
	{/if}

	{#if displayStreams.length > 0}
		<div class="stream-list">
			{#each displayStreams as channel (channel.login)}
				{@const isCapturing = capturingLogins.has(channel.login.toLowerCase())}
				{@const inWatchlist = watchlistLogins.has(channel.login.toLowerCase())}
				<div
					class="channel-row"
					class:capturing={isCapturing}
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
							{#if inWatchlist}
								<span class="saved-badge">SAVED</span>
							{/if}
							{#if isCapturing}
								<span class="rec-badge">REC</span>
							{/if}
							{#if channel.gameName}
								<span class="game-name">{channel.gameName}</span>
							{/if}
						</div>
						{#if channel.title}
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
					{/if}

					<div class="row-actions">
						{#if !inWatchlist}
							<button
								class="action-btn action-fav"
								onclick={() => addToWatchlist(channel)}
								title="Add to watchlist"
							>+</button>
						{/if}
						<button
							class="action-btn action-ignore"
							onclick={() => ignoreChannel(channel)}
							title="Ignore channel"
						>&times;</button>
						<a
							class="action-btn action-link"
							href="https://twitch.tv/{channel.login}"
							target="_blank"
							rel="noopener noreferrer"
							title="Open on Twitch"
							onclick={(e) => e.stopPropagation()}
						>&#8599;</a>
					</div>
				</div>
			{/each}
		</div>
	{:else if !loading && !backfilling}
		<p class="empty-text">No streams found</p>
	{/if}
</div>

<style>
	.discovery-browser {
		display: flex;
		flex-direction: column;
		gap: 12px;
		flex: 1;
		min-width: 0;
	}

	.filter-bar {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.input-wrapper {
		position: relative;
	}

	.input-group {
		display: flex;
		align-items: center;
		gap: 0;
	}

	.mode-toggle {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-right: none;
		border-radius: 6px 0 0 6px;
		padding: 5px 10px;
		font-size: 0.9rem;
		font-weight: 700;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
		width: 36px;
		text-align: center;
	}

	.mode-toggle.include {
		color: #7c3aed;
	}

	.mode-toggle.exclude {
		color: #ef4444;
	}

	.mode-toggle:hover {
		background: #222244;
	}

	.category-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-left: none;
		border-right: none;
		padding: 5px 10px;
		color: #e0e0ff;
		font-size: 0.8rem;
		outline: none;
		font-family: monospace;
		flex: 1;
		min-width: 0;
	}

	.category-input::placeholder {
		color: #444;
	}

	.category-input:focus {
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

	/* Autocomplete dropdown */
	.suggestions-dropdown {
		position: absolute;
		top: 100%;
		left: 36px;
		right: 0;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-top: none;
		border-radius: 0 0 6px 6px;
		z-index: 50;
		max-height: 200px;
		overflow-y: auto;
	}

	.suggestion-item {
		display: block;
		width: 100%;
		background: none;
		border: none;
		color: #c0c0e0;
		font-size: 0.8rem;
		padding: 6px 10px;
		text-align: left;
		cursor: pointer;
		transition: background 0.1s;
	}

	.suggestion-item:hover,
	.suggestion-item.selected {
		background: #2a2a4a;
		color: #e0e0ff;
	}

	/* Viewer range */
	.viewer-range {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.viewer-range-label {
		font-size: 0.7rem;
		color: #666;
		font-weight: 600;
		white-space: nowrap;
	}

	.viewer-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		padding: 3px 6px;
		color: #e0e0ff;
		font-size: 0.75rem;
		font-family: monospace;
		width: 72px;
		outline: none;
		-moz-appearance: textfield;
	}

	.viewer-input::-webkit-outer-spin-button,
	.viewer-input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.viewer-input::placeholder {
		color: #444;
	}

	.viewer-input:focus {
		border-color: #7c3aed;
	}

	.viewer-range-sep {
		color: #444;
		font-size: 0.8rem;
	}

	.category-pills {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.pill {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: 12px;
		font-size: 0.7rem;
		font-weight: 600;
	}

	.pill-include {
		background: rgba(124, 58, 237, 0.15);
		color: #a78bfa;
	}

	.pill-exclude {
		background: rgba(239, 68, 68, 0.15);
		color: #f87171;
	}

	.pill-mode {
		font-weight: 700;
	}

	.pill-remove {
		background: none;
		border: none;
		color: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		padding: 0 2px;
		line-height: 1;
		opacity: 0.6;
		transition: opacity 0.15s;
	}

	.pill-remove:hover {
		opacity: 1;
	}

	.error {
		color: #ef4444;
		font-size: 0.8rem;
	}

	.loading-text,
	.empty-text {
		color: #666;
		font-size: 0.8rem;
	}

	.stream-list {
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

	.saved-badge {
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

	.row-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 4px;
		border: 1px solid #2a2a4a;
		background: #1a1a2e;
		color: #888;
		font-size: 0.85rem;
		cursor: pointer;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
		text-decoration: none;
		line-height: 1;
		padding: 0;
	}

	.action-fav:hover {
		background: rgba(124, 58, 237, 0.2);
		color: #a78bfa;
		border-color: #7c3aed;
	}

	.action-ignore:hover {
		background: rgba(239, 68, 68, 0.2);
		color: #f87171;
		border-color: #ef4444;
	}

	.action-link:hover {
		background: rgba(96, 165, 250, 0.2);
		color: #93c5fd;
		border-color: #60a5fa;
	}

	.load-more-btn {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		color: #aaa;
		font-size: 0.8rem;
		padding: 8px;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
		text-align: center;
		margin-top: 4px;
	}

	.load-more-btn:hover:not(:disabled) {
		background: #2a2a4a;
		color: #e0e0ff;
	}

	.load-more-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
