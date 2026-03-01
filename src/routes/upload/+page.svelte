<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { page } from '$app/state';
	import { youtubeUploadEvents } from '$lib/stores/streams.js';
	import {
		youtubeStatus,
		youtubeAuthUrl,
		youtubeRemoveAccountCmd,
		youtubeCategories,
		youtubePlaylists,
		youtubeUploads,
		youtubeUploadCmd,
		youtubeDeleteUploadCmd,
		listExports,
		getThumbnailByVideo
	} from '$lib/streams.remote';

	// --- Types ---
	interface YouTubeAccountInfo {
		id: string;
		channelId: string;
		channelName: string;
		channelThumbnail?: string;
	}

	interface ExportRecord {
		id: string;
		title: string;
		description?: string;
		clipIds: string[];
		videoId?: string;
		status: 'pending' | 'exporting' | 'ready' | 'error';
		outputPath?: string;
		createdAt: number;
	}

	interface UploadRecord {
		id: string;
		exportId: string;
		accountId: string;
		youtubeVideoId?: string;
		title: string;
		description?: string;
		privacy: string;
		tags?: string[];
		categoryId?: string;
		playlistId?: string;
		status: 'pending' | 'uploading' | 'processing' | 'complete' | 'error';
		progress: number;
		error?: string;
		createdAt: number;
		completedAt?: number;
	}

	interface Category {
		id: string;
		title: string;
	}

	interface Playlist {
		id: string;
		title: string;
		itemCount: number;
	}

	// --- State ---
	let configured = $state(false);
	let accounts = $state<YouTubeAccountInfo[]>([]);
	let exports = $state<ExportRecord[]>([]);
	let uploads = $state<UploadRecord[]>([]);
	let categories = $state<Category[]>([]);
	let playlists = $state<Playlist[]>([]);
	let loading = $state(true);

	// Form state
	let selectedExportId = $state<string | null>(null);
	let selectedAccountId = $state<string | null>(null);
	let title = $state('');
	let description = $state('');
	let privacy = $state('private');
	let tagsInput = $state('');
	let categoryId = $state('');
	let playlistId = $state('');
	let uploading = $state(false);

	// Thumbnail state
	let thumbnailId = $state<string | null>(null);
	let thumbnailUrl = $state<string | null>(null);

	// Auth popup listener
	let messageHandler: ((e: MessageEvent) => void) | null = null;

	// Pre-select export from URL query param
	let preselectedExportId = $derived(page.url.searchParams.get('export'));

	let readyExports = $derived(exports.filter((e) => e.status === 'ready'));

	let selectedExport = $derived(readyExports.find((e) => e.id === selectedExportId) ?? null);

	onMount(async () => {
		messageHandler = (e: MessageEvent) => {
			if (e.data?.type === 'youtube-auth-success') {
				refreshStatus();
			}
		};
		window.addEventListener('message', messageHandler);

		await Promise.all([refreshStatus(), refreshExports(), refreshUploads()]);

		// Pre-select export from URL
		if (preselectedExportId && readyExports.some((e) => e.id === preselectedExportId)) {
			selectExport(preselectedExportId);
		}

		loading = false;
	});

	onDestroy(() => {
		if (messageHandler) {
			window.removeEventListener('message', messageHandler);
		}
	});

	async function refreshStatus() {
		try {
			const data = await youtubeStatus();
			configured = data.configured;
			accounts = data.accounts;
			// Auto-select first account if none selected
			if (accounts.length > 0 && !selectedAccountId) {
				selectedAccountId = accounts[0].id;
			}
		} catch (err) {
			console.error('Failed to fetch YouTube status:', err);
		}
	}

	async function refreshExports() {
		try {
			const data = await listExports();
			exports = data.exports;
		} catch (err) {
			console.error('Failed to fetch exports:', err);
		}
	}

	async function refreshUploads() {
		try {
			const data = await youtubeUploads();
			uploads = data.uploads;
		} catch (err) {
			console.error('Failed to fetch uploads:', err);
		}
	}

	async function connectAccount() {
		try {
			const data = await youtubeAuthUrl();
			window.open(data.url, 'youtube-auth', 'width=600,height=700');
		} catch (err) {
			console.error('Failed to get auth URL:', err);
		}
	}

	async function removeAccount(accountId: string) {
		if (!confirm('Remove this YouTube account?')) return;
		try {
			await youtubeRemoveAccountCmd({ accountId });
			await refreshStatus();
			if (selectedAccountId === accountId) {
				selectedAccountId = accounts.length > 0 ? accounts[0].id : null;
			}
		} catch (err) {
			console.error('Failed to remove account:', err);
		}
	}

	function selectExport(exportId: string) {
		selectedExportId = exportId;
		const exp = exports.find((e) => e.id === exportId);
		if (exp) {
			title = exp.title;
			description = exp.description ?? '';
		}
		// Fetch thumbnail for the video
		thumbnailId = null;
		thumbnailUrl = null;
		if (exp?.videoId) {
			getThumbnailByVideo({ videoId: exp.videoId }).then((data) => {
				if (data.thumbnail) {
					thumbnailId = data.thumbnail.id;
					thumbnailUrl = `/api/thumbnail/${data.thumbnail.id}`;
				}
			}).catch(() => {});
		}
	}

	// Fetch categories on mount (once)
	$effect(() => {
		if (configured && categories.length === 0) {
			youtubeCategories({}).then((data) => {
				categories = data.categories;
			}).catch(() => {});
		}
	});

	// Fetch playlists when selected account changes
	$effect(() => {
		const acctId = selectedAccountId;
		if (acctId) {
			youtubePlaylists({ accountId: acctId }).then((data) => {
				playlists = data.playlists;
			}).catch(() => {
				playlists = [];
			});
		} else {
			playlists = [];
		}
	});

	async function handleUpload() {
		if (!selectedExportId || !selectedAccountId || !title.trim()) return;
		uploading = true;
		try {
			const tags = tagsInput.trim()
				? tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
				: undefined;
			await youtubeUploadCmd({
				exportId: selectedExportId,
				accountId: selectedAccountId,
				title: title.trim(),
				description: description.trim() || undefined,
				privacy,
				tags,
				categoryId: categoryId || undefined,
				playlistId: playlistId || undefined
			});
			await refreshUploads();
		} catch (err) {
			console.error('Failed to queue upload:', err);
			alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			uploading = false;
		}
	}

	async function handleDeleteUpload(id: string) {
		if (!confirm('Delete this upload record?')) return;
		try {
			await youtubeDeleteUploadCmd({ id });
			uploads = uploads.filter((u) => u.id !== id);
		} catch (err) {
			console.error('Failed to delete upload:', err);
		}
	}

	// React to SSE upload status events
	let lastProcessedCount = 0;
	$effect(() => {
		const events = $youtubeUploadEvents;
		if (events.length === 0 || events.length === lastProcessedCount) return;
		const latest = events[events.length - 1];
		lastProcessedCount = events.length;
		uploads = untrack(() => uploads).map((u) => {
			if (u.id !== latest.uploadId) return u;
			return {
				...u,
				status: latest.status as UploadRecord['status'],
				...(latest.progress != null && { progress: latest.progress }),
				...(latest.youtubeVideoId && { youtubeVideoId: latest.youtubeVideoId }),
				...(latest.error && { error: latest.error }),
				...(latest.status === 'complete' || latest.status === 'error'
					? { completedAt: Math.floor(Date.now() / 1000) }
					: {})
			};
		});
	});

	function formatDate(epoch: number): string {
		return new Date(epoch * 1000).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function statusInfo(status: string): { label: string; cls: string } {
		switch (status) {
			case 'complete': return { label: 'Complete', cls: 'status-complete' };
			case 'uploading': return { label: 'Uploading', cls: 'status-uploading' };
			case 'processing': return { label: 'Processing', cls: 'status-uploading' };
			case 'pending': return { label: 'Pending', cls: 'status-pending' };
			case 'error': return { label: 'Error', cls: 'status-error' };
			default: return { label: status, cls: 'status-pending' };
		}
	}

	function getAccountName(accountId: string): string {
		return accounts.find((a) => a.id === accountId)?.channelName ?? 'Unknown';
	}
</script>

<div class="upload-page">
	<div class="upload-card">
		<h2 class="page-title">Upload to YouTube</h2>

		{#if loading}
			<p class="loading-text">Loading...</p>
		{:else if !configured}
			<div class="setup-guide">
				<h3>YouTube Integration Not Configured</h3>
				<p>To enable YouTube uploads, set the following environment variables:</p>
				<pre class="env-example">YOUTUBE_CLIENT_ID=your-client-id
YOUTUBE_CLIENT_SECRET=your-client-secret
YOUTUBE_REDIRECT_URI=http://localhost:5173/api/youtube/callback</pre>
				<p class="setup-hint">
					Create a project in the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>,
					enable the YouTube Data API v3, and create OAuth 2.0 credentials.
				</p>
			</div>
		{:else}
			<!-- Accounts Bar -->
			<section class="accounts-section">
				<div class="section-header">
					<h3 class="section-title">Connected Accounts</h3>
					<button class="btn-connect" onclick={connectAccount}>+ Connect YouTube Account</button>
				</div>
				{#if accounts.length === 0}
					<p class="empty-hint">No YouTube accounts connected yet. Click "Connect YouTube Account" to get started.</p>
				{:else}
					<div class="accounts-list">
						{#each accounts as account (account.id)}
							<div class="account-item">
								{#if account.channelThumbnail}
									<img class="account-thumb" src={account.channelThumbnail} alt="" referrerpolicy="no-referrer" />
								{:else}
									<div class="account-thumb-placeholder"></div>
								{/if}
								<span class="account-name">{account.channelName}</span>
								<button class="btn-remove-account" onclick={() => removeAccount(account.id)}>Remove</button>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Export Selector -->
			<section class="exports-section">
				<h3 class="section-title">Select Export</h3>
				{#if readyExports.length === 0}
					<p class="empty-hint">No ready exports. Export clips first from the Clips or Exports tab.</p>
				{:else}
					<div class="exports-list">
						{#each readyExports as exp (exp.id)}
							<button
								class="export-option"
								class:selected={selectedExportId === exp.id}
								onclick={() => selectExport(exp.id)}
							>
								<span class="export-option-title">{exp.title}</span>
								<span class="export-option-meta">
									{exp.clipIds.length} clip{exp.clipIds.length !== 1 ? 's' : ''} &middot; {formatDate(exp.createdAt)}
								</span>
							</button>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Metadata Form -->
			{#if selectedExport && accounts.length > 0}
				<section class="form-section">
					<h3 class="section-title">Upload Details</h3>
					<div class="form-grid">
						<label class="form-label">
							Channel
							<select class="form-select" bind:value={selectedAccountId}>
								{#each accounts as account (account.id)}
									<option value={account.id}>{account.channelName}</option>
								{/each}
							</select>
						</label>

						<label class="form-label">
							Title
							<input class="form-input" type="text" bind:value={title} placeholder="Video title" />
						</label>

						<label class="form-label form-full">
							Description
							<textarea class="form-textarea" bind:value={description} placeholder="Video description" rows="3"></textarea>
						</label>

						<label class="form-label">
							Privacy
							<select class="form-select" bind:value={privacy}>
								<option value="private">Private</option>
								<option value="unlisted">Unlisted</option>
								<option value="public">Public</option>
							</select>
						</label>

						<label class="form-label">
							Tags
							<input class="form-input" type="text" bind:value={tagsInput} placeholder="tag1, tag2, tag3" />
						</label>

						{#if categories.length > 0}
							<label class="form-label">
								Category
								<select class="form-select" bind:value={categoryId}>
									<option value="">None</option>
									{#each categories as cat (cat.id)}
										<option value={cat.id}>{cat.title}</option>
									{/each}
								</select>
							</label>
						{/if}

						{#if playlists.length > 0}
							<label class="form-label">
								Playlist
								<select class="form-select" bind:value={playlistId}>
									<option value="">None</option>
									{#each playlists as pl (pl.id)}
										<option value={pl.id}>{pl.title} ({pl.itemCount})</option>
									{/each}
								</select>
							</label>
						{/if}
					</div>

					{#if thumbnailUrl}
						<div class="thumbnail-preview">
							<span class="thumbnail-label">Thumbnail</span>
							<img class="thumbnail-img" src={thumbnailUrl} alt="Thumbnail" />
							<span class="thumbnail-hint">Will be auto-set after upload</span>
						</div>
					{:else if selectedExport?.videoId}
						<div class="thumbnail-preview">
							<span class="thumbnail-label">Thumbnail</span>
							<a class="thumbnail-link" href="/thumbnail?video={selectedExport.videoId}">Create a thumbnail</a>
						</div>
					{/if}

					<button
						class="btn-upload"
						onclick={handleUpload}
						disabled={uploading || !title.trim() || !selectedAccountId}
					>
						{uploading ? 'Queuing...' : 'Upload to YouTube'}
					</button>
				</section>
			{/if}

			<!-- Upload History -->
			{#if uploads.length > 0}
				<section class="history-section">
					<h3 class="section-title">Upload History</h3>
					<div class="uploads-list">
						{#each uploads as upload (upload.id)}
							{@const info = statusInfo(upload.status)}
							<div class="upload-item">
								<div class="upload-item-header">
									<span class="upload-item-title">{upload.title}</span>
									<div class="upload-item-actions">
										{#if upload.status === 'complete' || upload.status === 'error'}
											<button class="btn-delete-upload" onclick={() => handleDeleteUpload(upload.id)}>Delete</button>
										{/if}
										<span class="upload-status {info.cls}">{info.label}</span>
									</div>
								</div>
								<div class="upload-details">
									<span class="upload-detail">Channel: {getAccountName(upload.accountId)}</span>
									<span class="upload-detail">{upload.privacy}</span>
									<span class="upload-detail">{formatDate(upload.createdAt)}</span>
								</div>
								{#if upload.status === 'uploading'}
									<div class="upload-progress">
										<div class="progress-bar">
											<div class="progress-fill" style="width: {(upload.progress * 100).toFixed(1)}%"></div>
										</div>
										<span class="progress-text">{(upload.progress * 100).toFixed(0)}%</span>
									</div>
								{/if}
								{#if upload.status === 'complete' && upload.youtubeVideoId}
									<div class="upload-success">
										<a
											href="https://youtu.be/{upload.youtubeVideoId}"
											target="_blank"
											rel="noopener"
											class="youtube-link"
										>
											https://youtu.be/{upload.youtubeVideoId}
										</a>
									</div>
								{/if}
								{#if upload.status === 'error' && upload.error}
									<div class="upload-error">{upload.error}</div>
								{/if}
							</div>
						{/each}
					</div>
				</section>
			{/if}
		{/if}
	</div>
</div>

<style>
	.upload-page {
		flex: 1;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 32px 24px;
		overflow: auto;
	}

	.upload-card {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 8px;
		padding: 24px;
		width: 100%;
		max-width: 720px;
	}

	.page-title {
		font-size: 1rem;
		font-weight: 700;
		color: #e0e0ff;
		margin: 0 0 20px;
	}

	.loading-text {
		color: #888;
		font-size: 0.85rem;
	}

	/* Setup guide */
	.setup-guide {
		padding: 16px;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
	}

	.setup-guide h3 {
		font-size: 0.9rem;
		margin: 0 0 8px;
		color: #e0e0ff;
	}

	.setup-guide p {
		font-size: 0.8rem;
		color: #888;
		margin: 8px 0;
	}

	.env-example {
		background: #0a0a1a;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		padding: 12px;
		font-size: 0.75rem;
		color: #4ade80;
		overflow-x: auto;
	}

	.setup-hint a {
		color: #7c3aed;
	}

	/* Section */
	.section-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: #ccc;
		margin: 0 0 10px;
	}

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}

	.section-header .section-title {
		margin: 0;
	}

	.accounts-section, .exports-section, .form-section, .history-section {
		margin-top: 20px;
		padding-top: 20px;
		border-top: 1px solid #2a2a4a;
	}

	.accounts-section {
		margin-top: 0;
		padding-top: 0;
		border-top: none;
	}

	.empty-hint {
		font-size: 0.8rem;
		color: #666;
	}

	/* Accounts */
	.btn-connect {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
	}

	.btn-connect:hover {
		background: #6d28d9;
	}

	.accounts-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.account-item {
		display: flex;
		align-items: center;
		gap: 8px;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 8px 12px;
	}

	.account-thumb {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.account-thumb-placeholder {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: #2a2a4a;
	}

	.account-name {
		font-size: 0.8rem;
		color: #e0e0ff;
		font-weight: 500;
	}

	.btn-remove-account {
		background: none;
		border: none;
		color: #666;
		font-size: 0.65rem;
		cursor: pointer;
		padding: 2px 4px;
	}

	.btn-remove-account:hover {
		color: #f87171;
	}

	/* Export selector */
	.exports-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.export-option {
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 10px 14px;
		cursor: pointer;
		text-align: left;
		transition: border-color 0.15s;
	}

	.export-option:hover {
		border-color: #3a3a5a;
	}

	.export-option.selected {
		border-color: #7c3aed;
		background: rgba(124, 58, 237, 0.08);
	}

	.export-option-title {
		font-size: 0.8rem;
		color: #e0e0ff;
		font-weight: 500;
	}

	.export-option-meta {
		font-size: 0.65rem;
		color: #666;
	}

	/* Form */
	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.form-label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.7rem;
		color: #888;
		font-weight: 500;
	}

	.form-full {
		grid-column: 1 / -1;
	}

	.form-input, .form-select, .form-textarea {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		color: #e0e0ff;
		font-size: 0.8rem;
		padding: 8px 10px;
		font-family: inherit;
	}

	.form-input:focus, .form-select:focus, .form-textarea:focus {
		outline: none;
		border-color: #7c3aed;
	}

	.form-textarea {
		resize: vertical;
		min-height: 60px;
	}

	.btn-upload {
		margin-top: 16px;
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.8rem;
		font-weight: 600;
		padding: 10px 24px;
		border-radius: 6px;
		cursor: pointer;
		width: 100%;
	}

	.btn-upload:hover:not(:disabled) {
		background: #6d28d9;
	}

	.btn-upload:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Thumbnail preview */
	.thumbnail-preview {
		margin-top: 12px;
		padding: 12px;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.thumbnail-label {
		font-size: 0.7rem;
		color: #888;
		font-weight: 500;
	}

	.thumbnail-img {
		width: 100%;
		max-width: 320px;
		border-radius: 4px;
		border: 1px solid #2a2a4a;
	}

	.thumbnail-hint {
		font-size: 0.65rem;
		color: #4ade80;
	}

	.thumbnail-link {
		font-size: 0.75rem;
		color: #7c3aed;
		text-decoration: none;
	}

	.thumbnail-link:hover {
		text-decoration: underline;
		color: #a78bfa;
	}

	/* Upload history */
	.uploads-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.upload-item {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 12px 14px;
	}

	.upload-item-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.upload-item-title {
		font-size: 0.8rem;
		font-weight: 600;
		color: #e0e0ff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.upload-item-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.btn-delete-upload {
		background: #3a1a1a;
		border: 1px solid #5a2a2a;
		color: #c88;
		font-size: 0.6rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
	}

	.btn-delete-upload:hover {
		background: #5a2a2a;
		color: #faa;
	}

	.upload-status {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		flex-shrink: 0;
	}

	.status-complete {
		background: rgba(22, 163, 74, 0.15);
		color: #4ade80;
	}

	.status-uploading {
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

	.upload-details {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 6px;
		font-size: 0.65rem;
		color: #666;
	}

	.upload-progress {
		margin-top: 8px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.progress-bar {
		flex: 1;
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
		font-variant-numeric: tabular-nums;
		min-width: 3em;
		text-align: right;
	}

	.upload-success {
		margin-top: 8px;
		padding: 6px 10px;
		background: rgba(22, 163, 74, 0.08);
		border-radius: 4px;
	}

	.youtube-link {
		font-size: 0.75rem;
		color: #4ade80;
		font-family: monospace;
		text-decoration: none;
	}

	.youtube-link:hover {
		text-decoration: underline;
	}

	.upload-error {
		margin-top: 8px;
		font-size: 0.7rem;
		color: #f87171;
		padding: 6px 10px;
		background: rgba(220, 38, 38, 0.08);
		border-radius: 4px;
	}
</style>
