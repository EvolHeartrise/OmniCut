import * as path from 'node:path';
import * as fs from 'node:fs';
import type { StreamInfo, ClipRegion, ChatMessage } from './types.js';

// bun:sqlite is a Bun-native module. We use a lazy import because Vite's SSR
// renderer evaluates the bundle in a Node.js worker thread during build, which
// can't resolve the bun: protocol. The actual import only runs at server startup
// when Bun is the runtime.
type Database = import('bun:sqlite').Database;
let Database: typeof import('bun:sqlite').Database;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'omnicut.db');

let db: Database | null = null;

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
			parent_stream_id TEXT
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

		CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stream_id TEXT NOT NULL,
			username TEXT NOT NULL,
			text TEXT NOT NULL,
			timestamp REAL NOT NULL,
			FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_chat_stream ON chat_messages(stream_id);
		CREATE INDEX IF NOT EXISTS idx_chat_stream_time ON chat_messages(stream_id, timestamp);

		CREATE TABLE IF NOT EXISTS clip_regions (
			id TEXT PRIMARY KEY,
			stream_id TEXT NOT NULL,
			start_time REAL NOT NULL,
			end_time REAL NOT NULL,
			FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
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
	`);

	// Migration: add game_name column for existing databases
	try {
		db.exec('ALTER TABLE streams ADD COLUMN game_name TEXT');
	} catch {
		// Column already exists — ignore
	}

	// Migration: add platform column for existing databases
	try {
		db.exec("ALTER TABLE streams ADD COLUMN platform TEXT NOT NULL DEFAULT 'twitch'");
	} catch {
		// Column already exists — ignore
	}

	// Migration: add source_url column for VOD deduplication
	try {
		db.exec('ALTER TABLE streams ADD COLUMN source_url TEXT');
	} catch {
		// Column already exists — ignore
	}

	// Migration: add chat_complete flag
	try {
		db.exec("ALTER TABLE streams ADD COLUMN chat_complete INTEGER NOT NULL DEFAULT 0");
	} catch {
		// Column already exists — ignore
	}

	// Migration: add unique index for chat message dedup on refetch
	try {
		db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_dedup ON chat_messages(stream_id, username, timestamp, text)');
	} catch {
		// Index already exists — ignore
	}

	// Migration: add color column for chat message user colors
	try {
		db.exec('ALTER TABLE chat_messages ADD COLUMN color TEXT');
	} catch {
		// Column already exists — ignore
	}

	// Migration: add composite index for time-range transcription queries
	try {
		db.exec('CREATE INDEX IF NOT EXISTS idx_transcriptions_stream_time ON transcriptions(stream_id, start_time)');
	} catch {
		// Index already exists — ignore
	}
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
}

interface ClipRow {
	id: string;
	stream_id: string;
	start_time: number;
	end_time: number;
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
	const d = getDb();
	d.run(
		`INSERT INTO streams
		(id, channel, status, started_at, error, segment_count, disk_usage_bytes,
		 viewer_count, stream_title, game_name, recording_dir, offset, source_type, parent_stream_id, platform, source_url, chat_complete)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			chat_complete = excluded.chat_complete`,
		[
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
			info.chatComplete ? 1 : 0
		]
	);
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
		chatComplete: !!r.chat_complete
	}));
}

export function updateStreamOffset(id: string, offset: number): void {
	const d = getDb();
	d.run('UPDATE streams SET offset = ? WHERE id = ?', [offset, id]);
}

// --- Transcriptions ---

export function saveTranscription(streamId: string, text: string, startTime: number, endTime: number): void {
	const d = getDb();
	d.run(
		'INSERT INTO transcriptions (stream_id, text, start_time, end_time) VALUES (?, ?, ?, ?)',
		[streamId, text, startTime, endTime]
	);
}

export function loadTranscriptionsInRange(streamId: string, fromTime: number, toTime: number): Array<{ id: number; text: string; startTime: number; endTime: number }> {
	const d = getDb();
	const rows = d.query(
		'SELECT id, text, start_time, end_time FROM transcriptions WHERE stream_id = ? AND end_time >= ? AND start_time <= ? ORDER BY start_time'
	).all(streamId, fromTime, toTime) as TranscriptionRow[];
	return rows.map((r) => ({ id: r.id, text: r.text, startTime: r.start_time, endTime: r.end_time }));
}

export function countTranscriptions(streamId: string): number {
	const d = getDb();
	const row = d.query('SELECT COUNT(*) as cnt FROM transcriptions WHERE stream_id = ?').get(streamId) as { cnt: number } | null;
	return row?.cnt ?? 0;
}

export function deleteTranscriptions(streamId: string): void {
	const d = getDb();
	d.run('DELETE FROM transcriptions WHERE stream_id = ?', [streamId]);
}

// --- Chat Messages ---

export function saveChatMessage(streamId: string, msg: ChatMessage): void {
	const d = getDb();
	d.run(
		'INSERT OR IGNORE INTO chat_messages (stream_id, username, text, timestamp, color) VALUES (?, ?, ?, ?, ?)',
		[streamId, msg.username, msg.text, msg.timestamp, msg.color ?? null]
	);
}

export function countChatMessages(streamId: string): number {
	const d = getDb();
	const row = d.query('SELECT COUNT(*) as cnt FROM chat_messages WHERE stream_id = ?').get(streamId) as { cnt: number } | null;
	return row?.cnt ?? 0;
}

export function loadChatMessagesInRange(streamId: string, fromTime: number, toTime: number): (ChatMessage & { id: number })[] {
	const d = getDb();
	const rows = d.query(
		'SELECT id, username, text, timestamp, color FROM chat_messages WHERE stream_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp'
	).all(streamId, fromTime, toTime) as ChatRow[];
	return rows.map((r) => ({ id: r.id, username: r.username, text: r.text, timestamp: r.timestamp, color: r.color ?? null }));
}

export function loadChatHeatmap(streamId: string, bucketSeconds: number): Array<{ bucket: number; count: number }> {
	const d = getDb();
	const rows = d.query(
		`SELECT
			CAST(timestamp / ? AS INTEGER) * ? AS bucket,
			COUNT(*) AS count
		FROM chat_messages
		WHERE stream_id = ?
		GROUP BY bucket
		ORDER BY bucket`
	).all(bucketSeconds, bucketSeconds, streamId) as HeatmapRow[];
	return rows.map((r) => ({ bucket: r.bucket, count: r.count }));
}

// --- Clip Regions ---

export function saveClipRegion(region: ClipRegion): void {
	const d = getDb();
	d.run(
		`INSERT INTO clip_regions (id, stream_id, start_time, end_time) VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time`,
		[region.id, region.streamId, region.startTime, region.endTime]
	);
}

export function deleteClipRegion(id: string): void {
	const d = getDb();
	d.run('DELETE FROM clip_regions WHERE id = ?', [id]);
}

export function loadAllClipRegions(): ClipRegion[] {
	const d = getDb();
	const rows = d.query('SELECT id, stream_id, start_time, end_time FROM clip_regions').all() as ClipRow[];
	return rows.map((r) => ({
		id: r.id,
		streamId: r.stream_id,
		startTime: r.start_time,
		endTime: r.end_time
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
	return rows.map(r => r.login);
}

// --- Channel Settings ---

export function getChannelSettings(login: string): { login: string; language: string | null } | null {
	const d = getDb();
	const row = d.query('SELECT login, language FROM channel_settings WHERE login = ?').get(login.toLowerCase()) as { login: string; language: string | null } | null;
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
	const rows = d.query('SELECT login, language FROM channel_settings ORDER BY login').all() as { login: string; language: string | null }[];
	return rows;
}

// --- Watchlist ---

export function loadWatchlist(): Array<{ login: string; platform: string }> {
	const d = getDb();
	const rows = d.query('SELECT login, platform FROM watchlist ORDER BY added_at').all() as { login: string; platform: string }[];
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

/**
 * Close the database connection gracefully.
 */
export function closeDatabase(): void {
	if (db) {
		db.close();
		db = null;
	}
}
