import { getDb } from './persistenceBase.js';

// --- Layer config types ---

export interface TextLayerConfig {
	id: string;
	type: 'text';
	text: string;
	x: number;
	y: number;
	fontSize: number;
	fontFamily: string;
	color: string;
	strokeColor?: string;
	strokeWidth?: number;
	rotation?: number;            // degrees, clockwise
	scaleX?: number;              // horizontal scale, default 1
	scaleY?: number;              // vertical scale, default 1
	cropX?: number;               // crop region left (0-1 of layer bounds)
	cropY?: number;               // crop region top (0-1 of layer bounds)
	cropW?: number;               // crop region width (0-1 of layer bounds)
	cropH?: number;               // crop region height (0-1 of layer bounds)
	shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
}

export interface ImageLayerConfig {
	id: string;
	type: 'image';
	x: number;
	y: number;
	rotation?: number;
	scaleX?: number;
	scaleY?: number;
	opacity?: number;             // 0-1, default 1
	cropX?: number;               // crop region left (0-1 of layer bounds)
	cropY?: number;               // crop region top (0-1 of layer bounds)
	cropW?: number;               // crop region width (0-1 of layer bounds)
	cropH?: number;               // crop region height (0-1 of layer bounds)
	streamId?: string;            // for re-fetching from stream
	timestamp?: number;           // for re-fetching from stream
	dataUrl?: string;             // base64 data URL for pasted/imported images
	naturalWidth: number;         // original px
	naturalHeight: number;        // original px
}

export interface EffectLayerConfig {
	id: string;
	type: 'effect';
	kind: 'blur' | 'ai';
	blurRadius?: number;          // px, default 8 (blur)
	prompt?: string;              // AI prompt (ai)
}

export type LayerConfig = TextLayerConfig | ImageLayerConfig | EffectLayerConfig;

export interface ThumbnailRecord {
	id: string;
	videoId: string;
	exportId?: string;
	filePath: string;
	width: number;
	height: number;
	layers?: LayerConfig[];
	aiEnhanced: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ThumbnailRow {
	id: string;
	export_id: string;
	video_id: string | null;
	file_path: string;
	width: number;
	height: number;
	source_stream_id: string | null;
	source_timestamp: number | null;
	text_layers: string | null;
	ai_enhanced: number;
	created_at: number;
	updated_at: number;
}

export function mapThumbnailRow(r: ThumbnailRow): ThumbnailRecord {
	let layers: LayerConfig[] | undefined;
	if (r.text_layers) {
		try {
			layers = JSON.parse(r.text_layers);
		} catch {
			layers = undefined;
		}
	}
	return {
		id: r.id,
		videoId: r.video_id ?? '',
		...(r.export_id && { exportId: r.export_id }),
		filePath: r.file_path,
		width: r.width,
		height: r.height,
		...(layers && { layers }),
		aiEnhanced: !!r.ai_enhanced,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

export function saveThumbnail(record: ThumbnailRecord): void {
	const d = getDb();
	d.run(
		`INSERT INTO thumbnails (id, video_id, export_id, file_path, width, height, source_stream_id, source_timestamp, text_layers, ai_enhanced, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			file_path = excluded.file_path,
			export_id = excluded.export_id,
			width = excluded.width,
			height = excluded.height,
			source_stream_id = excluded.source_stream_id,
			source_timestamp = excluded.source_timestamp,
			text_layers = excluded.text_layers,
			ai_enhanced = excluded.ai_enhanced,
			updated_at = excluded.updated_at`,
		[
			record.id,
			record.videoId,
			record.exportId ?? null,
			record.filePath,
			record.width,
			record.height,
			null,
			null,
			record.layers ? JSON.stringify(record.layers) : null,
			record.aiEnhanced ? 1 : 0,
			record.createdAt,
			record.updatedAt
		]
	);
}

export function loadThumbnail(id: string): ThumbnailRecord | null {
	const d = getDb();
	const row = d.query('SELECT * FROM thumbnails WHERE id = ?').get(id) as ThumbnailRow | null;
	if (!row) return null;
	return mapThumbnailRow(row);
}

export function updateThumbnail(id: string, updates: Partial<Pick<ThumbnailRecord, 'filePath' | 'width' | 'height' | 'layers' | 'aiEnhanced'>>): void {
	const d = getDb();
	const sets: string[] = ['updated_at = unixepoch()'];
	const params: (string | number | null)[] = [];
	if (updates.filePath !== undefined) { sets.push('file_path = ?'); params.push(updates.filePath); }
	if (updates.width !== undefined) { sets.push('width = ?'); params.push(updates.width); }
	if (updates.height !== undefined) { sets.push('height = ?'); params.push(updates.height); }
	if (updates.layers !== undefined) { sets.push('text_layers = ?'); params.push(JSON.stringify(updates.layers)); }
	if (updates.aiEnhanced !== undefined) { sets.push('ai_enhanced = ?'); params.push(updates.aiEnhanced ? 1 : 0); }
	params.push(id);
	d.run(`UPDATE thumbnails SET ${sets.join(', ')} WHERE id = ?`, params);
}

export function deleteThumbnail(id: string): void {
	const d = getDb();
	d.run('DELETE FROM thumbnails WHERE id = ?', [id]);
}
