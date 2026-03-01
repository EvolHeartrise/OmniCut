import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { ClipEntry } from '../../types.js';
import { newVideoId } from '../../ids.js';
import { initStreamStatements } from './persistenceStreams.js';
import { initTranscriptionStatements } from './persistenceTranscriptions.js';
import { initChatStatements } from './persistenceChat.js';

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

// Private row type needed for export→video migration
interface ExportRow {
	id: string;
	title: string;
	description: string | null;
	clip_ids: string;
	clip_entries: string | null;
	effect_entries: string | null;
	status: string;
	output_path: string | null;
	error: string | null;
	created_at: number;
	completed_at: number | null;
	format: string;
	video_id: string | null;
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
			emotes TEXT,
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

		CREATE TABLE IF NOT EXISTS videos (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT,
			clip_entries TEXT NOT NULL,
			format TEXT NOT NULL DEFAULT 'standard',
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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

		CREATE TABLE IF NOT EXISTS thumbnails (
			id TEXT PRIMARY KEY,
			export_id TEXT NOT NULL,
			file_path TEXT NOT NULL,
			width INTEGER NOT NULL DEFAULT 1280,
			height INTEGER NOT NULL DEFAULT 720,
			source_stream_id TEXT,
			source_timestamp REAL,
			text_layers TEXT,
			ai_enhanced INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
			FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS channel_camera_bounds (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel TEXT NOT NULL,
			timestamp REAL NOT NULL,
			cam_x REAL NOT NULL,
			cam_y REAL NOT NULL,
			cam_w REAL NOT NULL,
			cam_h REAL NOT NULL,
			UNIQUE(channel, timestamp)
		);

		CREATE INDEX IF NOT EXISTS idx_cam_bounds_channel_time ON channel_camera_bounds(channel, timestamp);

		-- Purge old-format thumbnail rows (schema changed to unified layer system)
		DELETE FROM thumbnails;

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

	// Idempotent schema migrations — add columns if they don't exist
	const migrations = [
		'ALTER TABLE clip_regions ADD COLUMN cam_x REAL',
		'ALTER TABLE clip_regions ADD COLUMN cam_y REAL',
		'ALTER TABLE clip_regions ADD COLUMN cam_w REAL',
		'ALTER TABLE clip_regions ADD COLUMN cam_h REAL',
		"ALTER TABLE exports ADD COLUMN format TEXT NOT NULL DEFAULT 'standard'",
		'ALTER TABLE chat_messages ADD COLUMN emotes TEXT',
		'ALTER TABLE exports ADD COLUMN video_id TEXT REFERENCES videos(id)',
		'ALTER TABLE exports ADD COLUMN clip_entries TEXT',
		'ALTER TABLE thumbnails ADD COLUMN video_id TEXT REFERENCES videos(id)',
		'ALTER TABLE clip_regions ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0',
		'ALTER TABLE videos ADD COLUMN effect_entries TEXT',
		'ALTER TABLE exports ADD COLUMN effect_entries TEXT'
	];
	for (const sql of migrations) {
		try { db.exec(sql); } catch { /* column already exists */ }
	}

	// Migrate existing clip cam fields into channel_camera_bounds (one-time)
	try {
		const migrated = db.query(
			`SELECT COUNT(*) as cnt FROM channel_camera_bounds`
		).get() as { cnt: number };
		if (migrated.cnt === 0) {
			// Copy cam fields from clip_regions (join with streams to get channel)
			db.exec(`
				INSERT OR IGNORE INTO channel_camera_bounds (channel, timestamp, cam_x, cam_y, cam_w, cam_h)
				SELECT s.channel, cr.start_time, cr.cam_x, cr.cam_y, cr.cam_w, cr.cam_h
				FROM clip_regions cr
				JOIN streams s ON s.id = cr.stream_id
				WHERE cr.cam_x IS NOT NULL AND cr.cam_y IS NOT NULL AND cr.cam_w IS NOT NULL AND cr.cam_h IS NOT NULL
			`);
			const count = (db.query('SELECT changes() as n').get() as { n: number }).n;
			if (count > 0) {
				console.log(`[persistence] Migrated ${count} clip camera bounds to channel_camera_bounds table`);
			}
		}
	} catch (err) {
		console.warn('[persistence] Camera bounds migration error:', err instanceof Error ? err.message : String(err));
	}

	// Migrate existing exports to videos (one-time)
	try {
		const unmigrated = db.query(
			`SELECT * FROM exports WHERE video_id IS NULL AND clip_ids IS NOT NULL`
		).all() as ExportRow[];
		if (unmigrated.length > 0) {
			const insertVideo = db.prepare(
				`INSERT INTO videos (id, title, description, clip_entries, format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
			);
			const linkExport = db.prepare(`UPDATE exports SET video_id = ? WHERE id = ?`);
			const linkThumbnail = db.prepare(`UPDATE thumbnails SET video_id = ? WHERE export_id = ?`);
			for (const exp of unmigrated) {
				const videoId = newVideoId();
				let clipIds: string[];
				try { clipIds = JSON.parse(exp.clip_ids); } catch { clipIds = []; }
				const clipEntries: ClipEntry[] = clipIds.map((clipId) => ({ clipId }));
				insertVideo.run(videoId, exp.title, exp.description, JSON.stringify(clipEntries), exp.format || 'standard', exp.created_at, exp.created_at);
				linkExport.run(videoId, exp.id);
				linkThumbnail.run(videoId, exp.id);
			}
			console.log(`[persistence] Migrated ${unmigrated.length} exports to videos`);
		}
	} catch (err) {
		console.warn('[persistence] Export→Video migration error:', err instanceof Error ? err.message : String(err));
	}

	// Initialize prepared statements in domain modules
	initStreamStatements(db);
	initChatStatements(db);
	initTranscriptionStatements(db);
}

export function getDb(): Database {
	if (!db) {
		throw new Error('Database not initialized — call initDatabase() first');
	}
	return db;
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

// --- Shared query helpers ---

/** Build an optional text filter clause for SQL queries using LIKE or REGEXP. */
export function buildTextFilter(query?: string, regex?: string): { clause: string; params: string[] } {
	if (regex) return { clause: ' AND regexp(?, text)', params: [regex] };
	if (query) return { clause: ' AND text LIKE ?', params: [`%${query}%`] };
	return { clause: '', params: [] };
}
