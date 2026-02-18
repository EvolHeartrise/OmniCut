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

		CREATE TABLE IF NOT EXISTS clip_regions (
			id TEXT PRIMARY KEY,
			stream_id TEXT NOT NULL,
			start_time REAL NOT NULL,
			end_time REAL NOT NULL,
			FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_clip_stream ON clip_regions(stream_id);
	`);
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
		`INSERT OR REPLACE INTO streams
		(id, channel, status, started_at, error, segment_count, disk_usage_bytes,
		 viewer_count, stream_title, recording_dir, offset, source_type, parent_stream_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			info.recordingDir,
			info.offset,
			info.sourceType,
			info.parentStreamId
		]
	);
}

export function deleteStream(id: string): void {
	const d = getDb();
	d.run('DELETE FROM streams WHERE id = ?', [id]);
}

export function loadAllStreams(): StreamInfo[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM streams').all() as any[];
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
		recordingDir: r.recording_dir,
		offset: r.offset,
		sourceType: r.source_type as StreamInfo['sourceType'],
		parentStreamId: r.parent_stream_id
	}));
}

export function updateStreamOffset(id: string, offset: number): void {
	const d = getDb();
	d.run('UPDATE streams SET offset = ? WHERE id = ?', [offset, id]);
}

export function updateStreamStatus(id: string, status: string, segmentCount?: number, diskUsageBytes?: number): void {
	const d = getDb();
	if (segmentCount !== undefined && diskUsageBytes !== undefined) {
		d.run('UPDATE streams SET status = ?, segment_count = ?, disk_usage_bytes = ? WHERE id = ?',
			[status, segmentCount, diskUsageBytes, id]);
	} else {
		d.run('UPDATE streams SET status = ? WHERE id = ?', [status, id]);
	}
}

export function updateStreamMeta(id: string, viewerCount: number | null, streamTitle: string | null): void {
	const d = getDb();
	d.run('UPDATE streams SET viewer_count = ?, stream_title = ? WHERE id = ?',
		[viewerCount, streamTitle, id]);
}

export function updateStreamSegmentInfo(id: string, segmentCount: number, diskUsageBytes: number, status?: string): void {
	const d = getDb();
	if (status) {
		d.run('UPDATE streams SET segment_count = ?, disk_usage_bytes = ?, status = ? WHERE id = ?',
			[segmentCount, diskUsageBytes, status, id]);
	} else {
		d.run('UPDATE streams SET segment_count = ?, disk_usage_bytes = ? WHERE id = ?',
			[segmentCount, diskUsageBytes, id]);
	}
}

// --- Transcriptions ---

export function saveTranscription(streamId: string, text: string, startTime: number, endTime: number): void {
	const d = getDb();
	d.run(
		'INSERT INTO transcriptions (stream_id, text, start_time, end_time) VALUES (?, ?, ?, ?)',
		[streamId, text, startTime, endTime]
	);
}

export function loadTranscriptions(streamId: string): Array<{ text: string; startTime: number; endTime: number }> {
	const d = getDb();
	const rows = d.query(
		'SELECT text, start_time, end_time FROM transcriptions WHERE stream_id = ? ORDER BY start_time'
	).all(streamId) as any[];
	return rows.map((r) => ({ text: r.text, startTime: r.start_time, endTime: r.end_time }));
}

export function loadAllTranscriptions(): Record<string, Array<{ text: string; startTime: number; endTime: number }>> {
	const d = getDb();
	const rows = d.query(
		'SELECT stream_id, text, start_time, end_time FROM transcriptions ORDER BY start_time'
	).all() as any[];
	const result: Record<string, Array<{ text: string; startTime: number; endTime: number }>> = {};
	for (const r of rows) {
		if (!result[r.stream_id]) result[r.stream_id] = [];
		result[r.stream_id].push({ text: r.text, startTime: r.start_time, endTime: r.end_time });
	}
	return result;
}

export function deleteTranscriptions(streamId: string): void {
	const d = getDb();
	d.run('DELETE FROM transcriptions WHERE stream_id = ?', [streamId]);
}

// --- Chat Messages ---

export function saveChatMessage(streamId: string, msg: ChatMessage): void {
	const d = getDb();
	d.run(
		'INSERT INTO chat_messages (stream_id, username, text, timestamp) VALUES (?, ?, ?, ?)',
		[streamId, msg.username, msg.text, msg.timestamp]
	);
}

export function loadChatMessages(streamId: string): ChatMessage[] {
	const d = getDb();
	const rows = d.query(
		'SELECT username, text, timestamp FROM chat_messages WHERE stream_id = ? ORDER BY timestamp'
	).all(streamId) as any[];
	return rows.map((r) => ({ username: r.username, text: r.text, timestamp: r.timestamp }));
}

export function loadAllChatMessages(): Record<string, ChatMessage[]> {
	const d = getDb();
	const rows = d.query(
		'SELECT stream_id, username, text, timestamp FROM chat_messages ORDER BY timestamp'
	).all() as any[];
	const result: Record<string, ChatMessage[]> = {};
	for (const r of rows) {
		if (!result[r.stream_id]) result[r.stream_id] = [];
		result[r.stream_id].push({ username: r.username, text: r.text, timestamp: r.timestamp });
	}
	return result;
}

export function deleteChatMessages(streamId: string): void {
	const d = getDb();
	d.run('DELETE FROM chat_messages WHERE stream_id = ?', [streamId]);
}

// --- Clip Regions ---

export function saveClipRegion(region: ClipRegion): void {
	const d = getDb();
	d.run(
		'INSERT OR REPLACE INTO clip_regions (id, stream_id, start_time, end_time) VALUES (?, ?, ?, ?)',
		[region.id, region.streamId, region.startTime, region.endTime]
	);
}

export function deleteClipRegion(id: string): void {
	const d = getDb();
	d.run('DELETE FROM clip_regions WHERE id = ?', [id]);
}

export function loadAllClipRegions(): ClipRegion[] {
	const d = getDb();
	const rows = d.query('SELECT id, stream_id, start_time, end_time FROM clip_regions').all() as any[];
	return rows.map((r) => ({
		id: r.id,
		streamId: r.stream_id,
		startTime: r.start_time,
		endTime: r.end_time
	}));
}

// --- Bulk operations for session import/export ---

export function clearAll(): void {
	const d = getDb();
	d.exec('DELETE FROM chat_messages');
	d.exec('DELETE FROM transcriptions');
	d.exec('DELETE FROM clip_regions');
	d.exec('DELETE FROM streams');
}

export function bulkImportTranscriptions(streamId: string, entries: Array<{ text: string; startTime: number; endTime: number }>): void {
	const d = getDb();
	const stmt = d.prepare('INSERT INTO transcriptions (stream_id, text, start_time, end_time) VALUES (?, ?, ?, ?)');
	const tx = d.transaction(() => {
		for (const e of entries) {
			stmt.run(streamId, e.text, e.startTime, e.endTime);
		}
	});
	tx();
}

export function bulkImportChatMessages(streamId: string, messages: ChatMessage[]): void {
	const d = getDb();
	const stmt = d.prepare('INSERT INTO chat_messages (stream_id, username, text, timestamp) VALUES (?, ?, ?, ?)');
	const tx = d.transaction(() => {
		for (const m of messages) {
			stmt.run(streamId, m.username, m.text, m.timestamp);
		}
	});
	tx();
}

export function bulkImportClipRegions(regions: ClipRegion[]): void {
	const d = getDb();
	const stmt = d.prepare('INSERT OR REPLACE INTO clip_regions (id, stream_id, start_time, end_time) VALUES (?, ?, ?, ?)');
	const tx = d.transaction(() => {
		for (const r of regions) {
			stmt.run(r.id, r.streamId, r.startTime, r.endTime);
		}
	});
	tx();
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
