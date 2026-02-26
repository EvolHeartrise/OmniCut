import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { StreamInfo, ClipRegion, ChatMessage } from './types.js';
import type { WordTimestamp } from './transcriber.js';

// bun:sqlite is a Bun-native module. We use a lazy import because Vite's SSR
// renderer evaluates the bundle in a Node.js worker thread during build, which
// can't resolve the bun: protocol. The actual import only runs at server startup
// when Bun is the runtime.
type Database = import('bun:sqlite').Database;
let Database: typeof import('bun:sqlite').Database;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'omnicut.db');
const EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions');

let db: Database | null = null;

// Prepared statements for hot-path operations (initialized after DB open)
type Statement = import('bun:sqlite').Statement;
let stmtSaveChatMessage: Statement | null = null;
let stmtSaveTranscription: Statement | null = null;
let stmtSaveWord: Statement | null = null;
let stmtSaveStream: Statement | null = null;

/** Resolve the platform-specific regex0 extension path and load it. */
function loadRegexExtension(database: Database): void {
	const platform = os.platform();
	const arch = os.arch();
	let filename: string;
	if (platform === 'win32') {
		filename = 'regex0.dll';
	} else if (platform === 'darwin') {
		filename = arch === 'arm64' ? 'regex0-aarch64.dylib' : 'regex0-x86_64.dylib';
	} else {
		filename = 'regex0.so';
	}
	const extPath = path.join(EXTENSIONS_DIR, filename);
	if (!fs.existsSync(extPath)) {
		console.warn(`[persistence] sqlite-regex extension not found at ${extPath} — REGEXP will be unavailable`);
		return;
	}
	try {
		// loadExtension expects the path without the file extension
		database.loadExtension(extPath.replace(/\.(dll|dylib|so)$/, ''));
		console.log(`[persistence] Loaded sqlite-regex extension from ${filename}`);
	} catch (err) {
		console.warn(`[persistence] Failed to load sqlite-regex extension: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Initialize the SQLite database, creating tables if they don't exist.
 * Must be called once at server startup (when running under Bun).
 */
export async function initDatabase(): Promise<void> {
	fs.mkdirSync(DATA_DIR, { recursive: true });

	const mod = await import('bun:sqlite');
	Database = mod.Database;

	db = new Database(DB_PATH);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA foreign_keys = ON');

	// Load sqlite-regex extension for DB-side REGEXP support
	loadRegexExtension(db);

	db.exec(`
		CREATE TABLE IF NOT EXISTS streams (
			id TEXT PRIMARY KEY,
			channel TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'stopped',
			started_at INTEGER NOT NULL,
			error TEXT,
			segment_count INTEGER NOT NULL DEFAULT 0,
			disk_usage_bytes INTEGER NOT NULL DEFAULT 0,
			viewer_count INTEGER,
			stream_title TEXT,
			game_name TEXT,
			recording_dir TEXT NOT NULL,
			offset REAL NOT NULL DEFAULT 0,
			source_type TEXT NOT NULL DEFAULT 'live',
			parent_stream_id TEXT,
			platform TEXT NOT NULL DEFAULT 'twitch',
			source_url TEXT,
			chat_complete INTEGER NOT NULL DEFAULT 0,
			duration_seconds REAL
		);

		CREATE TABLE IF NOT EXISTS transcriptions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stream_id TEXT NOT NULL,
			text TEXT NOT NULL,
			start_time REAL NOT NULL,
			end_time REAL NOT NULL,
			FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_transcriptions_stream ON transcriptions(stream_id);
		CREATE INDEX IF NOT EXISTS idx_transcriptions_stream_time ON transcriptions(stream_id, start_time);

		CREATE TABLE IF NOT EXISTS transcription_words (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			transcription_id INTEGER NOT NULL,
			word TEXT NOT NULL,
			start_time REAL NOT NULL,
			end_time REAL NOT NULL,
			FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_twords_transcription ON transcription_words(transcription_id);

		CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stream_id TEXT NOT NULL,
			username TEXT NOT NULL,
			text TEXT NOT NULL,
			timestamp REAL NOT NULL,
			color TEXT,
			badges TEXT,
			twitch_id TEXT NOT NULL,
			FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_chat_stream ON chat_messages(stream_id);
		CREATE INDEX IF NOT EXISTS idx_chat_stream_time ON chat_messages(stream_id, timestamp);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_twitch_id ON chat_messages(twitch_id);

		CREATE TABLE IF NOT EXISTS clip_regions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stream_id TEXT NOT NULL,
			start_time REAL NOT NULL,
			end_time REAL NOT NULL,
			created_by TEXT DEFAULT 'human',
			title TEXT,
			notes TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_clip_stream ON clip_regions(stream_id);

		CREATE TABLE IF NOT EXISTS ignored_channels (
			login TEXT PRIMARY KEY,
			ignored_at INTEGER NOT NULL DEFAULT (unixepoch())
		);

		CREATE TABLE IF NOT EXISTS channel_settings (
			login TEXT PRIMARY KEY,
			language TEXT,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		);

		CREATE TABLE IF NOT EXISTS watchlist (
			login TEXT NOT NULL,
			platform TEXT NOT NULL DEFAULT 'twitch',
			added_at INTEGER NOT NULL DEFAULT (unixepoch()),
			PRIMARY KEY (login, platform)
		);

		CREATE TABLE IF NOT EXISTS exports (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT,
			clip_ids TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			output_path TEXT,
			error TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			completed_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS youtube_accounts (
			id TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL UNIQUE,
			channel_name TEXT NOT NULL,
			channel_thumbnail TEXT,
			access_token TEXT NOT NULL,
			refresh_token TEXT NOT NULL,
			expiry_date INTEGER NOT NULL,
			scope TEXT,
			token_type TEXT DEFAULT 'Bearer',
			created_at INTEGER DEFAULT (unixepoch()),
			updated_at INTEGER DEFAULT (unixepoch())
		);

		CREATE TABLE IF NOT EXISTS youtube_uploads (
			id TEXT PRIMARY KEY,
			export_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			youtube_video_id TEXT,
			title TEXT NOT NULL,
			description TEXT,
			privacy TEXT NOT NULL DEFAULT 'private',
			tags TEXT,
			category_id TEXT,
			playlist_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			progress REAL DEFAULT 0,
			error TEXT,
			created_at INTEGER DEFAULT (unixepoch()),
			completed_at INTEGER,
			FOREIGN KEY (export_id) REFERENCES exports(id),
			FOREIGN KEY (account_id) REFERENCES youtube_accounts(id)
		);
	`);

	// Prepare hot-path statements for better performance
	stmtSaveChatMessage = db.prepare(
		'INSERT OR IGNORE INTO chat_messages (stream_id, username, text, timestamp, color, badges, twitch_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	stmtSaveTranscription = db.prepare(
		'INSERT INTO transcriptions (stream_id, text, start_time, end_time) VALUES (?, ?, ?, ?)'
	);
	stmtSaveWord = db.prepare(
		'INSERT INTO transcription_words (transcription_id, word, start_time, end_time) VALUES (?, ?, ?, ?)'
	);
	stmtSaveStream = db.prepare(
		`INSERT INTO streams
		(id, channel, status, started_at, error, segment_count, disk_usage_bytes,
		 viewer_count, stream_title, game_name, recording_dir, offset, source_type, parent_stream_id, platform, source_url, chat_complete, duration_seconds)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			status = excluded.status,
			started_at = excluded.started_at,
			error = excluded.error,
			segment_count = excluded.segment_count,
			disk_usage_bytes = excluded.disk_usage_bytes,
			viewer_count = excluded.viewer_count,
			stream_title = excluded.stream_title,
			game_name = excluded.game_name,
			recording_dir = excluded.recording_dir,
			offset = excluded.offset,
			source_type = excluded.source_type,
			parent_stream_id = excluded.parent_stream_id,
			platform = excluded.platform,
			source_url = excluded.source_url,
			chat_complete = excluded.chat_complete,
			duration_seconds = excluded.duration_seconds`
	);
}

// --- Row types for query results ---

interface StreamRow {
	id: string;
	channel: string;
	status: string;
	started_at: number;
	error: string | null;
	segment_count: number;
	disk_usage_bytes: number;
	viewer_count: number | null;
	stream_title: string | null;
	game_name: string | null;
	recording_dir: string;
	offset: number;
	source_type: string;
	parent_stream_id: string | null;
	platform: string;
	source_url: string | null;
	chat_complete: number;
	duration_seconds: number | null;
}

interface TranscriptionRow {
	id: number;
	stream_id: string;
	text: string;
	start_time: number;
	end_time: number;
}

interface ChatRow {
	id: number;
	stream_id: string;
	username: string;
	text: string;
	timestamp: number;
	color: string | null;
	badges: string | null;
	twitch_id: string;
}

interface ClipRow {
	id: number;
	stream_id: string;
	start_time: number;
	end_time: number;
	created_by: string | null;
	title: string | null;
	notes: string | null;
}

interface ExportRow {
	id: string;
	title: string;
	description: string | null;
	clip_ids: string;
	status: string;
	output_path: string | null;
	error: string | null;
	created_at: number;
	completed_at: number | null;
}

export interface ExportRecord {
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

interface HeatmapRow {
	bucket: number;
	count: number;
}

function getDb(): Database {
	if (!db) {
		throw new Error('Database not initialized — call initDatabase() first');
	}
	return db;
}

// --- Streams ---

export function saveStream(info: StreamInfo): void {
	const params = [
		info.id,
		info.channel,
		info.status,
		info.startedAt,
		info.error || null,
		info.segmentCount,
		info.diskUsageBytes,
		info.viewerCount,
		info.streamTitle,
		info.gameName,
		info.recordingDir,
		info.offset,
		info.sourceType,
		info.parentStreamId,
		info.platform,
		info.sourceUrl,
		info.chatComplete ? 1 : 0,
		info.durationSeconds
	];
	if (stmtSaveStream) {
		stmtSaveStream.run(...params);
	} else {
		const d = getDb();
		d.run(
			`INSERT INTO streams
			(id, channel, status, started_at, error, segment_count, disk_usage_bytes,
			 viewer_count, stream_title, game_name, recording_dir, offset, source_type, parent_stream_id, platform, source_url, chat_complete, duration_seconds)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				status = excluded.status,
				started_at = excluded.started_at,
				error = excluded.error,
				segment_count = excluded.segment_count,
				disk_usage_bytes = excluded.disk_usage_bytes,
				viewer_count = excluded.viewer_count,
				stream_title = excluded.stream_title,
				game_name = excluded.game_name,
				recording_dir = excluded.recording_dir,
				offset = excluded.offset,
				source_type = excluded.source_type,
				parent_stream_id = excluded.parent_stream_id,
				platform = excluded.platform,
				source_url = excluded.source_url,
				chat_complete = excluded.chat_complete,
				duration_seconds = excluded.duration_seconds`,
			params
		);
	}
}

export function deleteStream(id: string): void {
	const d = getDb();
	d.run('DELETE FROM streams WHERE id = ?', [id]);
}

export function loadAllStreams(): StreamInfo[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM streams').all() as StreamRow[];
	return rows.map((r) => ({
		id: r.id,
		channel: r.channel,
		status: r.status as StreamInfo['status'],
		startedAt: r.started_at,
		error: r.error || undefined,
		segmentCount: r.segment_count,
		diskUsageBytes: r.disk_usage_bytes,
		viewerCount: r.viewer_count,
		streamTitle: r.stream_title,
		gameName: r.game_name ?? null,
		recordingDir: r.recording_dir,
		offset: r.offset,
		sourceType: r.source_type as StreamInfo['sourceType'],
		parentStreamId: r.parent_stream_id,
		platform: (r.platform || 'twitch') as StreamInfo['platform'],
		sourceUrl: r.source_url || null,
		chatComplete: !!r.chat_complete,
		durationSeconds: r.duration_seconds ?? null
	}));
}

export function updateStreamOffset(id: string, offset: number): void {
	const d = getDb();
	d.run('UPDATE streams SET offset = ? WHERE id = ?', [offset, id]);
}

// --- Shared query helpers ---

/** Build an optional text filter clause for SQL queries using LIKE or REGEXP. */
function buildTextFilter(query?: string, regex?: string): { clause: string; params: string[] } {
	if (regex) return { clause: ' AND regexp(?, text)', params: [regex] };
	if (query) return { clause: ' AND text LIKE ?', params: [`%${query}%`] };
	return { clause: '', params: [] };
}

// --- Transcriptions ---

export function saveTranscription(
	streamId: string,
	text: string,
	startTime: number,
	endTime: number,
	words?: WordTimestamp[]
): void {
	const d = getDb();
	try {
		if (stmtSaveTranscription) {
			stmtSaveTranscription.run(streamId, text, startTime, endTime);
		} else {
			d.run('INSERT INTO transcriptions (stream_id, text, start_time, end_time) VALUES (?, ?, ?, ?)', [
				streamId,
				text,
				startTime,
				endTime
			]);
		}
	} catch (err: any) {
		if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
			// Stream was deleted while transcription was still in-flight — silently discard
			return;
		}
		throw err;
	}

	if (words && words.length > 0) {
		const transcriptionId = (d.query('SELECT last_insert_rowid() as id').get() as { id: number }).id;
		const ws =
			stmtSaveWord ??
			d.prepare('INSERT INTO transcription_words (transcription_id, word, start_time, end_time) VALUES (?, ?, ?, ?)');
		for (const w of words) {
			ws.run(transcriptionId, w.word, w.start, w.end);
		}
	}
}

export function loadTranscriptionsInRange(
	streamId: string,
	fromTime: number,
	toTime: number,
	query?: string,
	regex?: string
): Array<{ id: number; text: string; startTime: number; endTime: number }> {
	const d = getDb();
	const { clause, params: filterParams } = buildTextFilter(query, regex);
	const sql = `SELECT id, text, start_time, end_time FROM transcriptions WHERE stream_id = ? AND end_time >= ? AND start_time <= ?${clause} ORDER BY start_time`;
	const rows = d.query(sql).all(streamId, fromTime, toTime, ...filterParams) as TranscriptionRow[];
	return rows.map((r) => ({ id: r.id, text: r.text, startTime: r.start_time, endTime: r.end_time }));
}

export function countTranscriptions(streamId: string): number {
	const d = getDb();
	const row = d.query('SELECT COUNT(*) as cnt FROM transcriptions WHERE stream_id = ?').get(streamId) as {
		cnt: number;
	} | null;
	return row?.cnt ?? 0;
}

export function loadWordTimestamps(
	transcriptionId: number
): Array<{ word: string; startTime: number; endTime: number }> {
	const d = getDb();
	const rows = d
		.query('SELECT word, start_time, end_time FROM transcription_words WHERE transcription_id = ? ORDER BY start_time')
		.all(transcriptionId) as Array<{ word: string; start_time: number; end_time: number }>;
	return rows.map((r) => ({ word: r.word, startTime: r.start_time, endTime: r.end_time }));
}

export function deleteTranscriptions(streamId: string): void {
	const d = getDb();
	d.run('DELETE FROM transcriptions WHERE stream_id = ?', [streamId]);
}

// --- Chat Messages ---

export function saveChatMessage(streamId: string, msg: ChatMessage): void {
	if (stmtSaveChatMessage) {
		stmtSaveChatMessage.run(streamId, msg.username, msg.text, msg.timestamp, msg.color ?? null, msg.badges ?? null, msg.twitchId);
	} else {
		const d = getDb();
		d.run('INSERT OR IGNORE INTO chat_messages (stream_id, username, text, timestamp, color, badges, twitch_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [
			streamId,
			msg.username,
			msg.text,
			msg.timestamp,
			msg.color ?? null,
			msg.badges ?? null,
			msg.twitchId
		]);
	}
}

/** Batch-insert chat messages inside a single transaction (much faster for VOD chat imports). */
export function saveChatMessagesBatch(streamId: string, messages: ChatMessage[]): void {
	if (messages.length === 0) return;
	const d = getDb();
	const stmt =
		stmtSaveChatMessage ??
		d.prepare(
			'INSERT OR IGNORE INTO chat_messages (stream_id, username, text, timestamp, color, badges, twitch_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
		);
	d.exec('BEGIN');
	try {
		for (const msg of messages) {
			stmt.run(streamId, msg.username, msg.text, msg.timestamp, msg.color ?? null, msg.badges ?? null, msg.twitchId);
		}
		d.exec('COMMIT');
	} catch (err) {
		d.exec('ROLLBACK');
		throw err;
	}
}

export function countChatMessages(streamId: string): number {
	const d = getDb();
	const row = d.query('SELECT COUNT(*) as cnt FROM chat_messages WHERE stream_id = ?').get(streamId) as {
		cnt: number;
	} | null;
	return row?.cnt ?? 0;
}

export function loadChatMessagesInRange(
	streamId: string,
	fromTime: number,
	toTime: number,
	query?: string,
	limit?: number,
	regex?: string
): (ChatMessage & { id: number })[] {
	const d = getDb();
	const cap = limit ?? 0;
	const mapRow = (r: ChatRow) => ({
		id: r.id,
		username: r.username,
		text: r.text,
		timestamp: r.timestamp,
		color: r.color ?? null,
		badges: r.badges ?? null,
		twitchId: r.twitch_id
	});
	const cols = 'id, username, text, timestamp, color, badges, twitch_id';
	const base = `SELECT ${cols} FROM chat_messages WHERE stream_id = ? AND timestamp >= ? AND timestamp <= ?`;
	const { clause, params: textParams } = buildTextFilter(query, regex);
	// When limited, fetch the LAST N messages in the range (most recent, near the playhead)
	const sql = cap > 0
		? `SELECT * FROM (${base}${clause} ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp`
		: `${base}${clause} ORDER BY timestamp`;
	const params = cap > 0 ? [streamId, fromTime, toTime, ...textParams, cap] : [streamId, fromTime, toTime, ...textParams];
	return (d.query(sql).all(...params) as ChatRow[]).map(mapRow);
}

export function loadChatHeatmap(streamId: string, bucketSeconds: number): Array<{ bucket: number; count: number }> {
	const d = getDb();
	const rows = d
		.query(
			`SELECT
			CAST(timestamp / ? AS INTEGER) * ? AS bucket,
			COUNT(*) AS count
		FROM chat_messages
		WHERE stream_id = ?
		GROUP BY bucket
		ORDER BY bucket`
		)
		.all(bucketSeconds, bucketSeconds, streamId) as HeatmapRow[];
	return rows.map((r) => ({ bucket: r.bucket, count: r.count }));
}

// --- Clip Regions ---

/** Insert a new clip region, letting the DB auto-generate the ID. Returns the generated ID as a string. */
export function insertClipRegion(data: Omit<ClipRegion, 'id'>): string {
	const d = getDb();
	d.run(
		'INSERT INTO clip_regions (stream_id, start_time, end_time, created_by, title, notes) VALUES (?, ?, ?, ?, ?, ?)',
		[data.streamId, data.startTime, data.endTime, data.createdBy ?? 'human', data.title ?? null, data.notes ?? null]
	);
	const row = d.query('SELECT last_insert_rowid() as id').get() as { id: number };
	return String(row.id);
}

/** Upsert a clip region with a known ID (for updates, undo re-adds, etc.). */
export function saveClipRegion(region: ClipRegion): void {
	const d = getDb();
	d.run(
		`INSERT INTO clip_regions (id, stream_id, start_time, end_time, created_by, title, notes) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, created_by = excluded.created_by, title = excluded.title, notes = excluded.notes`,
		[
			region.id,
			region.streamId,
			region.startTime,
			region.endTime,
			region.createdBy ?? 'human',
			region.title ?? null,
			region.notes ?? null
		]
	);
}

export function deleteClipRegion(id: string): void {
	const d = getDb();
	d.run('DELETE FROM clip_regions WHERE id = ?', [id]);
}

export function loadAllClipRegions(): ClipRegion[] {
	const d = getDb();
	const rows = d
		.query('SELECT id, stream_id, start_time, end_time, created_by, title, notes FROM clip_regions')
		.all() as ClipRow[];
	return rows.map((r) => ({
		id: String(r.id),
		streamId: r.stream_id,
		startTime: r.start_time,
		endTime: r.end_time,
		createdBy: (r.created_by as 'human' | 'ai') ?? 'human',
		...(r.title && { title: r.title }),
		...(r.notes && { notes: r.notes })
	}));
}

// --- Ignored Channels ---

export function addIgnoredChannel(login: string): void {
	const d = getDb();
	d.run('INSERT OR IGNORE INTO ignored_channels (login) VALUES (?)', [login.toLowerCase()]);
}

export function removeIgnoredChannel(login: string): void {
	const d = getDb();
	d.run('DELETE FROM ignored_channels WHERE login = ?', [login.toLowerCase()]);
}

export function loadIgnoredChannels(): string[] {
	const d = getDb();
	const rows = d.query('SELECT login FROM ignored_channels ORDER BY ignored_at').all() as { login: string }[];
	return rows.map((r) => r.login);
}

// --- Channel Settings ---

export function getChannelSettings(login: string): { login: string; language: string | null } | null {
	const d = getDb();
	const row = d.query('SELECT login, language FROM channel_settings WHERE login = ?').get(login.toLowerCase()) as {
		login: string;
		language: string | null;
	} | null;
	return row ?? null;
}

export function saveChannelSettings(login: string, language: string | null): void {
	const d = getDb();
	d.run(
		`INSERT INTO channel_settings (login, language, updated_at) VALUES (?, ?, unixepoch())
		 ON CONFLICT(login) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at`,
		[login.toLowerCase(), language]
	);
}

export function loadAllChannelSettings(): { login: string; language: string | null }[] {
	const d = getDb();
	const rows = d.query('SELECT login, language FROM channel_settings ORDER BY login').all() as {
		login: string;
		language: string | null;
	}[];
	return rows;
}

// --- Watchlist ---

export function loadWatchlist(): Array<{ login: string; platform: string }> {
	const d = getDb();
	const rows = d.query('SELECT login, platform FROM watchlist ORDER BY added_at').all() as {
		login: string;
		platform: string;
	}[];
	return rows;
}

export function addToWatchlist(login: string, platform: string): void {
	const d = getDb();
	d.run('INSERT OR IGNORE INTO watchlist (login, platform) VALUES (?, ?)', [login, platform]);
}

export function removeFromWatchlist(login: string, platform: string): void {
	const d = getDb();
	d.run('DELETE FROM watchlist WHERE login = ? AND platform = ?', [login, platform]);
}

// --- Exports ---

export function saveExport(record: ExportRecord): void {
	const d = getDb();
	d.run(
		`INSERT INTO exports (id, title, description, clip_ids, status, output_path, error, created_at, completed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			record.id,
			record.title,
			record.description ?? null,
			JSON.stringify(record.clipIds),
			record.status,
			record.outputPath ?? null,
			record.error ?? null,
			record.createdAt,
			record.completedAt ?? null
		]
	);
}

export function updateExportStatus(
	id: string,
	status: ExportRecord['status'],
	outputPath?: string,
	error?: string
): void {
	const d = getDb();
	const completedAt = status === 'ready' || status === 'error' ? Math.floor(Date.now() / 1000) : null;
	d.run(
		`UPDATE exports SET status = ?, output_path = COALESCE(?, output_path), error = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`,
		[status, outputPath ?? null, error ?? null, completedAt, id]
	);
}

export function loadExport(id: string): ExportRecord | null {
	const d = getDb();
	const row = d.query('SELECT * FROM exports WHERE id = ?').get(id) as ExportRow | null;
	if (!row) return null;
	return mapExportRow(row);
}

export function loadAllExports(): ExportRecord[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM exports ORDER BY created_at DESC').all() as ExportRow[];
	return rows.map(mapExportRow);
}

export function deleteExport(id: string): void {
	const d = getDb();
	d.run('DELETE FROM exports WHERE id = ?', [id]);
}

function mapExportRow(r: ExportRow): ExportRecord {
	let clipIds: string[];
	try {
		clipIds = JSON.parse(r.clip_ids) as string[];
	} catch {
		console.error(`[persistence] Corrupt clip_ids JSON for export ${r.id}, treating as empty`);
		clipIds = [];
	}
	return {
		id: r.id,
		title: r.title,
		...(r.description && { description: r.description }),
		clipIds,
		status: r.status as ExportRecord['status'],
		...(r.output_path && { outputPath: r.output_path }),
		...(r.error && { error: r.error }),
		createdAt: r.created_at,
		...(r.completed_at != null && { completedAt: r.completed_at })
	};
}

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

/**
 * Close the database connection gracefully.
 */
export function closeDatabase(): void {
	if (db) {
		db.close();
		db = null;
	}
}
