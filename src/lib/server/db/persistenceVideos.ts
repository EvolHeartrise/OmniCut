import type { ClipEntry, EffectEntry, VideoRecord } from '../../types.js';
import type { ThumbnailRecord } from './persistenceThumbnails.js';
import { getDb } from './persistenceBase.js';

interface VideoRow {
	id: string;
	title: string;
	description: string | null;
	clip_entries: string;
	effect_entries: string | null;
	format: string;
	created_at: number;
	updated_at: number;
}

function mapVideoRow(r: VideoRow): VideoRecord {
	let clipEntries: ClipEntry[];
	try {
		clipEntries = JSON.parse(r.clip_entries) as ClipEntry[];
	} catch {
		console.error(`[persistence] Corrupt clip_entries JSON for video ${r.id}, treating as empty`);
		clipEntries = [];
	}
	let effectEntries: EffectEntry[] | undefined;
	if (r.effect_entries) {
		try {
			effectEntries = JSON.parse(r.effect_entries) as EffectEntry[];
		} catch {
			console.error(`[persistence] Corrupt effect_entries JSON for video ${r.id}, treating as empty`);
			effectEntries = [];
		}
	}
	return {
		id: r.id,
		title: r.title,
		...(r.description && { description: r.description }),
		clipEntries,
		...(effectEntries && effectEntries.length > 0 && { effectEntries }),
		format: (r.format || 'standard') as VideoRecord['format'],
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

export function saveVideo(record: VideoRecord): void {
	const d = getDb();
	d.run(
		`INSERT INTO videos (id, title, description, clip_entries, effect_entries, format, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			clip_entries = excluded.clip_entries,
			effect_entries = excluded.effect_entries,
			format = excluded.format,
			updated_at = excluded.updated_at`,
		[
			record.id,
			record.title,
			record.description ?? null,
			JSON.stringify(record.clipEntries),
			record.effectEntries ? JSON.stringify(record.effectEntries) : null,
			record.format,
			record.createdAt,
			record.updatedAt
		]
	);
}

export function updateVideoRecord(
	id: string,
	updates: Partial<Pick<VideoRecord, 'title' | 'description' | 'clipEntries' | 'effectEntries' | 'format'>>
): void {
	const d = getDb();
	const sets: string[] = ['updated_at = unixepoch()'];
	const params: (string | number | null)[] = [];
	if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
	if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
	if (updates.clipEntries !== undefined) { sets.push('clip_entries = ?'); params.push(JSON.stringify(updates.clipEntries)); }
	if (updates.effectEntries !== undefined) { sets.push('effect_entries = ?'); params.push(JSON.stringify(updates.effectEntries)); }
	if (updates.format !== undefined) { sets.push('format = ?'); params.push(updates.format); }
	if (sets.length === 1) return; // only updated_at, nothing to do
	params.push(id);
	d.run(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`, params);
}

export function loadVideo(id: string): VideoRecord | null {
	const d = getDb();
	const row = d.query('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | null;
	if (!row) return null;
	return mapVideoRow(row);
}

export function loadAllVideos(): VideoRecord[] {
	const d = getDb();
	const rows = d.query('SELECT * FROM videos ORDER BY updated_at DESC').all() as VideoRow[];
	return rows.map(mapVideoRow);
}

export function deleteVideoRecord(id: string): void {
	const d = getDb();
	d.run('DELETE FROM videos WHERE id = ?', [id]);
}

// Note: This function uses ThumbnailRow/mapThumbnailRow from persistenceThumbnails,
// but to avoid circular imports we inline the query and mapping here.
import { mapThumbnailRow, type ThumbnailRow } from './persistenceThumbnails.js';

export function loadThumbnailByVideo(videoId: string): ThumbnailRecord | null {
	const d = getDb();
	const row = d.query('SELECT * FROM thumbnails WHERE video_id = ? ORDER BY updated_at DESC LIMIT 1').get(videoId) as ThumbnailRow | null;
	if (!row) return null;
	return mapThumbnailRow(row);
}
