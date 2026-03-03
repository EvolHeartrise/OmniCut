import type { ClipEntry, EffectEntry } from '../../types.js';
import { getDb, parseJsonField } from './persistenceBase.js';

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

export interface ExportRecord {
	id: string;
	title: string;
	description?: string;
	clipEntries: ClipEntry[];
	effectEntries?: EffectEntry[];
	status: 'pending' | 'exporting' | 'ready' | 'error';
	outputPath?: string;
	error?: string;
	createdAt: number;
	completedAt?: number;
	format: 'standard' | 'mobile_short';
	videoId?: string;
}

function mapExportRow(r: ExportRow): ExportRecord {
	const clipEntries = parseJsonField<ClipEntry[] | undefined>(r.clip_entries, undefined)
		?? parseJsonField<string[]>(r.clip_ids, [], `clip_ids for export ${r.id}`).map((clipId) => ({ clipId }));
	const effectEntries = parseJsonField<EffectEntry[] | undefined>(r.effect_entries, undefined);
	return {
		id: r.id,
		title: r.title,
		...(r.description && { description: r.description }),
		clipEntries,
		...(effectEntries && { effectEntries }),
		status: r.status as ExportRecord['status'],
		...(r.output_path && { outputPath: r.output_path }),
		...(r.error && { error: r.error }),
		createdAt: r.created_at,
		...(r.completed_at != null && { completedAt: r.completed_at }),
		format: (r.format || 'standard') as ExportRecord['format'],
		...(r.video_id && { videoId: r.video_id })
	};
}

export function saveExport(record: ExportRecord): void {
	const d = getDb();
	d.run(
		`INSERT INTO exports (id, title, description, clip_ids, clip_entries, effect_entries, status, output_path, error, created_at, completed_at, format, video_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			record.id,
			record.title,
			record.description ?? null,
			JSON.stringify(record.clipEntries.map((e) => e.clipId)),
			JSON.stringify(record.clipEntries),
			record.effectEntries ? JSON.stringify(record.effectEntries) : null,
			record.status,
			record.outputPath ?? null,
			record.error ?? null,
			record.createdAt,
			record.completedAt ?? null,
			record.format ?? 'standard',
			record.videoId ?? null
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
	if (status === 'pending') {
		// Full reset — clear output, error, and completed_at
		d.run(
			`UPDATE exports SET status = ?, output_path = NULL, error = NULL, completed_at = NULL WHERE id = ?`,
			[status, id]
		);
	} else {
		const completedAt = status === 'ready' || status === 'error' ? Math.floor(Date.now() / 1000) : null;
		d.run(
			`UPDATE exports SET status = ?, output_path = COALESCE(?, output_path), error = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`,
			[status, outputPath ?? null, error ?? null, completedAt, id]
		);
	}
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

