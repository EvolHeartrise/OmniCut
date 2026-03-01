import type { ChatMessage } from '../types.js';
import { getDb, buildTextFilter } from './persistenceBase.js';

type Database = import('bun:sqlite').Database;
type Statement = import('bun:sqlite').Statement;

let stmtSaveChatMessage: Statement | null = null;

export function initChatStatements(db: Database): void {
	stmtSaveChatMessage = db.prepare(
		`INSERT INTO chat_messages (stream_id, username, text, timestamp, color, badges, twitch_id, emotes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(twitch_id) DO UPDATE SET
		   emotes = COALESCE(NULLIF(excluded.emotes, ''), emotes),
		   badges = COALESCE(NULLIF(excluded.badges, ''), badges)`
	);
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
	emotes: string | null;
}

interface HeatmapRow {
	bucket: number;
	count: number;
}

export function saveChatMessage(streamId: string, msg: ChatMessage): void {
	if (stmtSaveChatMessage) {
		stmtSaveChatMessage.run(streamId, msg.username, msg.text, msg.timestamp, msg.color ?? null, msg.badges ?? null, msg.twitchId, msg.emotes ?? null);
	} else {
		const d = getDb();
		d.run(`INSERT INTO chat_messages (stream_id, username, text, timestamp, color, badges, twitch_id, emotes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(twitch_id) DO UPDATE SET
			  emotes = COALESCE(NULLIF(excluded.emotes, ''), emotes),
			  badges = COALESCE(NULLIF(excluded.badges, ''), badges)`, [
			streamId,
			msg.username,
			msg.text,
			msg.timestamp,
			msg.color ?? null,
			msg.badges ?? null,
			msg.twitchId,
			msg.emotes ?? null
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
			`INSERT INTO chat_messages (stream_id, username, text, timestamp, color, badges, twitch_id, emotes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(twitch_id) DO UPDATE SET
			   emotes = COALESCE(NULLIF(excluded.emotes, ''), emotes),
			   badges = COALESCE(NULLIF(excluded.badges, ''), badges)`
		);
	d.exec('BEGIN');
	try {
		for (const msg of messages) {
			stmt.run(streamId, msg.username, msg.text, msg.timestamp, msg.color ?? null, msg.badges ?? null, msg.twitchId, msg.emotes ?? null);
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
		twitchId: r.twitch_id,
		emotes: r.emotes ?? null
	});
	const cols = 'id, username, text, timestamp, color, badges, twitch_id, emotes';
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

/** Load a single chat message by its Twitch message ID (uses unique index). */
export function loadChatMessageByTwitchId(twitchId: string): (ChatMessage & { id: number; streamId: string }) | null {
	const d = getDb();
	const row = d.query(
		'SELECT id, stream_id, username, text, timestamp, color, badges, twitch_id, emotes FROM chat_messages WHERE twitch_id = ?'
	).get(twitchId) as ChatRow | null;
	if (!row) return null;
	return {
		id: row.id,
		streamId: row.stream_id,
		username: row.username,
		text: row.text,
		timestamp: row.timestamp,
		color: row.color ?? null,
		badges: row.badges ?? null,
		twitchId: row.twitch_id,
		emotes: row.emotes ?? null
	};
}
