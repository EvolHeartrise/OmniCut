import type { WordTimestamp } from '../transcriber.js';
import { getDb, buildTextFilter } from './persistenceBase.js';

type Database = import('bun:sqlite').Database;
type Statement = import('bun:sqlite').Statement;

let stmtSaveTranscription: Statement | null = null;
let stmtSaveWord: Statement | null = null;

export function initTranscriptionStatements(db: Database): void {
	stmtSaveTranscription = db.prepare(
		'INSERT INTO transcriptions (stream_id, text, start_time, end_time) VALUES (?, ?, ?, ?)'
	);
	stmtSaveWord = db.prepare(
		'INSERT INTO transcription_words (transcription_id, word, start_time, end_time) VALUES (?, ?, ?, ?)'
	);
}

interface TranscriptionRow {
	id: number;
	stream_id: string;
	text: string;
	start_time: number;
	end_time: number;
}

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
