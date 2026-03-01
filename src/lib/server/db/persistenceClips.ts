import type { ClipRegion } from '../../types.js';
import { getDb } from './persistenceBase.js';

interface ClipRow {
	id: number;
	stream_id: string;
	start_time: number;
	end_time: number;
	created_by: string | null;
	title: string | null;
	notes: string | null;
	favourite: number | null;
}

/** Insert a new clip region, letting the DB auto-generate the ID. Returns the generated ID as a string. */
export function insertClipRegion(data: Omit<ClipRegion, 'id'>): string {
	const d = getDb();
	d.run(
		'INSERT INTO clip_regions (stream_id, start_time, end_time, created_by, title, notes, favourite) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[data.streamId, data.startTime, data.endTime, data.createdBy ?? 'human', data.title ?? null, data.notes ?? null, data.favourite ? 1 : 0]
	);
	const row = d.query('SELECT last_insert_rowid() as id').get() as { id: number };
	return String(row.id);
}

/** Upsert a clip region with a known ID (for updates, undo re-adds, etc.). */
export function saveClipRegion(region: ClipRegion): void {
	const d = getDb();
	d.run(
		`INSERT INTO clip_regions (id, stream_id, start_time, end_time, created_by, title, notes, favourite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, created_by = excluded.created_by, title = excluded.title, notes = excluded.notes, favourite = excluded.favourite`,
		[
			region.id,
			region.streamId,
			region.startTime,
			region.endTime,
			region.createdBy ?? 'human',
			region.title ?? null,
			region.notes ?? null,
			region.favourite ? 1 : 0
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
		.query('SELECT id, stream_id, start_time, end_time, created_by, title, notes, favourite FROM clip_regions')
		.all() as ClipRow[];
	return rows.map((r) => ({
		id: String(r.id),
		streamId: r.stream_id,
		startTime: r.start_time,
		endTime: r.end_time,
		createdBy: (r.created_by as 'human' | 'ai') ?? 'human',
		...(r.title && { title: r.title }),
		...(r.notes && { notes: r.notes }),
		...(r.favourite && { favourite: true })
	}));
}
