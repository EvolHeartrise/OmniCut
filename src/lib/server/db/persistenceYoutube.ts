import { getDb } from './persistenceBase.js';

// --- YouTube Accounts ---

interface YouTubeAccountRow {
	id: string;
	channel_id: string;
	channel_name: string;
	channel_thumbnail: string | null;
	access_token: string;
	refresh_token: string;
	expiry_date: number;
	scope: string | null;
	token_type: string;
	created_at: number;
	updated_at: number;
}

export interface YouTubeAccount {
	id: string;
	channelId: string;
	channelName: string;
	channelThumbnail?: string;
	accessToken: string;
	refreshToken: string;
	expiryDate: number;
	scope?: string;
	tokenType: string;
	createdAt: number;
	updatedAt: number;
}

function mapYouTubeAccountRow(r: YouTubeAccountRow): YouTubeAccount {
	return {
		id: r.id,
		channelId: r.channel_id,
		channelName: r.channel_name,
		...(r.channel_thumbnail && { channelThumbnail: r.channel_thumbnail }),
		accessToken: r.access_token,
		refreshToken: r.refresh_token,
		expiryDate: r.expiry_date,
		...(r.scope && { scope: r.scope }),
		tokenType: r.token_type,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

export function saveYouTubeAccount(account: YouTubeAccount): void {
	const d = getDb();
	d.run(
		`INSERT INTO youtube_accounts (id, channel_id, channel_name, channel_thumbnail, access_token, refresh_token, expiry_date, scope, token_type, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			channel_id = excluded.channel_id,
			channel_name = excluded.channel_name,
			channel_thumbnail = excluded.channel_thumbnail,
			access_token = excluded.access_token,
			refresh_token = excluded.refresh_token,
			expiry_date = excluded.expiry_date,
			scope = excluded.scope,
			token_type = excluded.token_type,
			updated_at = excluded.updated_at`,
		[
			account.id,
			account.channelId,
			account.channelName,
			account.channelThumbnail ?? null,
			account.accessToken,
			account.refreshToken,
			account.expiryDate,
			account.scope ?? null,
			account.tokenType,
			account.createdAt,
			account.updatedAt
		]
	);
}

export function updateYouTubeAccountTokens(
	accountId: string,
	accessToken: string,
	expiryDate: number,
	refreshToken?: string
): void {
	const d = getDb();
	if (refreshToken) {
		d.run(
			'UPDATE youtube_accounts SET access_token = ?, refresh_token = ?, expiry_date = ?, updated_at = unixepoch() WHERE id = ?',
			[accessToken, refreshToken, expiryDate, accountId]
		);
	} else {
		d.run(
			'UPDATE youtube_accounts SET access_token = ?, expiry_date = ?, updated_at = unixepoch() WHERE id = ?',
			[accessToken, expiryDate, accountId]
		);
	}
}

export function loadYouTubeAccount(id: string): YouTubeAccount | null {
	const d = getDb();
	const row = d.query('SELECT * FROM youtube_accounts WHERE id = ?').get(id) as YouTubeAccountRow | null;
	if (!row) return null;
	return mapYouTubeAccountRow(row);
}

export function loadYouTubeAccountByChannelId(channelId: string): YouTubeAccount | null {
	const d = getDb();
	const row = d.query('SELECT * FROM youtube_accounts WHERE channel_id = ?').get(channelId) as YouTubeAccountRow | null;
	if (!row) return null;
	return mapYouTubeAccountRow(row);
}

export function loadAllYouTubeAccounts(): YouTubeAccount[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM youtube_accounts ORDER BY created_at').all() as YouTubeAccountRow[];
	return rows.map(mapYouTubeAccountRow);
}

export function deleteYouTubeAccount(id: string): void {
	const d = getDb();
	d.run('DELETE FROM youtube_accounts WHERE id = ?', [id]);
}

// --- YouTube Uploads ---

interface YouTubeUploadRow {
	id: string;
	export_id: string;
	account_id: string;
	youtube_video_id: string | null;
	title: string;
	description: string | null;
	privacy: string;
	tags: string | null;
	category_id: string | null;
	playlist_id: string | null;
	status: string;
	progress: number;
	error: string | null;
	created_at: number;
	completed_at: number | null;
}

export interface YouTubeUploadRecord {
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

function mapYouTubeUploadRow(r: YouTubeUploadRow): YouTubeUploadRecord {
	let tags: string[] | undefined;
	if (r.tags) {
		try {
			tags = JSON.parse(r.tags);
		} catch {
			tags = undefined;
		}
	}
	return {
		id: r.id,
		exportId: r.export_id,
		accountId: r.account_id,
		...(r.youtube_video_id && { youtubeVideoId: r.youtube_video_id }),
		title: r.title,
		...(r.description && { description: r.description }),
		privacy: r.privacy,
		...(tags && { tags }),
		...(r.category_id && { categoryId: r.category_id }),
		...(r.playlist_id && { playlistId: r.playlist_id }),
		status: r.status as YouTubeUploadRecord['status'],
		progress: r.progress,
		...(r.error && { error: r.error }),
		createdAt: r.created_at,
		...(r.completed_at != null && { completedAt: r.completed_at })
	};
}

export function saveYouTubeUpload(record: YouTubeUploadRecord): void {
	const d = getDb();
	d.run(
		`INSERT INTO youtube_uploads (id, export_id, account_id, youtube_video_id, title, description, privacy, tags, category_id, playlist_id, status, progress, error, created_at, completed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			record.id,
			record.exportId,
			record.accountId,
			record.youtubeVideoId ?? null,
			record.title,
			record.description ?? null,
			record.privacy,
			record.tags ? JSON.stringify(record.tags) : null,
			record.categoryId ?? null,
			record.playlistId ?? null,
			record.status,
			record.progress,
			record.error ?? null,
			record.createdAt,
			record.completedAt ?? null
		]
	);
}

export function updateYouTubeUploadStatus(
	id: string,
	status: YouTubeUploadRecord['status'],
	progress?: number,
	youtubeVideoId?: string,
	error?: string
): void {
	const d = getDb();
	const completedAt = status === 'complete' || status === 'error' ? Math.floor(Date.now() / 1000) : null;
	d.run(
		`UPDATE youtube_uploads SET
			status = ?,
			progress = COALESCE(?, progress),
			youtube_video_id = COALESCE(?, youtube_video_id),
			error = ?,
			completed_at = COALESCE(?, completed_at)
		WHERE id = ?`,
		[status, progress ?? null, youtubeVideoId ?? null, error ?? null, completedAt, id]
	);
}

export function loadYouTubeUpload(id: string): YouTubeUploadRecord | null {
	const d = getDb();
	const row = d.query('SELECT * FROM youtube_uploads WHERE id = ?').get(id) as YouTubeUploadRow | null;
	if (!row) return null;
	return mapYouTubeUploadRow(row);
}

export function loadAllYouTubeUploads(): YouTubeUploadRecord[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM youtube_uploads ORDER BY created_at DESC').all() as YouTubeUploadRow[];
	return rows.map(mapYouTubeUploadRow);
}

export function loadYouTubeUploadsByExport(exportId: string): YouTubeUploadRecord[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM youtube_uploads WHERE export_id = ? ORDER BY created_at DESC').all(exportId) as YouTubeUploadRow[];
	return rows.map(mapYouTubeUploadRow);
}

export function deleteYouTubeUpload(id: string): void {
	const d = getDb();
	d.run('DELETE FROM youtube_uploads WHERE id = ?', [id]);
}
