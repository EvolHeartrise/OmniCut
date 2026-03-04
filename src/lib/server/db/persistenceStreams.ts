import type { StreamInfo } from '../types.js';
import { getDb } from './persistenceBase.js';

type Database = import('bun:sqlite').Database;
type Statement = import('bun:sqlite').Statement;

let stmtSaveStream: Statement | null = null;

export function initStreamStatements(db: Database): void {
	stmtSaveStream = db.prepare(
		`INSERT INTO streams
		(id, channel, status, started_at, error, segment_count, disk_usage_bytes,
		 viewer_count, stream_title, game_name, recording_dir, offset, source_type, parent_stream_id, platform, source_url, chat_complete, duration_seconds, remuxed)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			duration_seconds = excluded.duration_seconds,
			remuxed = excluded.remuxed`
	);
}

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
	remuxed: number;
}

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
		info.durationSeconds,
		info.remuxed ? 1 : 0
	];
	if (stmtSaveStream) {
		stmtSaveStream.run(...params);
	} else {
		const d = getDb();
		d.run(
			`INSERT INTO streams
			(id, channel, status, started_at, error, segment_count, disk_usage_bytes,
			 viewer_count, stream_title, game_name, recording_dir, offset, source_type, parent_stream_id, platform, source_url, chat_complete, duration_seconds, remuxed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				duration_seconds = excluded.duration_seconds,
				remuxed = excluded.remuxed`,
			params
		);
	}
}

export function deleteStream(id: string): void {
	const d = getDb();
	d.run('DELETE FROM streams WHERE id = ?', [id]);
}

export function loadStream(id: string): StreamInfo | null {
	const d = getDb();
	const r = d.query('SELECT * FROM streams WHERE id = ?').get(id) as StreamRow | null;
	if (!r) return null;
	return {
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
		durationSeconds: r.duration_seconds ?? null,
		remuxed: !!r.remuxed
	};
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
		durationSeconds: r.duration_seconds ?? null,
		remuxed: !!r.remuxed
	}));
}

export function updateStreamOffset(id: string, offset: number): void {
	const d = getDb();
	d.run('UPDATE streams SET offset = ? WHERE id = ?', [offset, id]);
}
