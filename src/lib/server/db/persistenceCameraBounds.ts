import type { CameraBoundsEntry } from '../../types.js';
import { getDb } from './persistenceBase.js';

interface CameraBoundsRow {
	id: number;
	channel: string;
	timestamp: number;
	cam_x: number;
	cam_y: number;
	cam_w: number;
	cam_h: number;
}

function mapCameraBoundsRow(r: CameraBoundsRow): CameraBoundsEntry {
	return {
		id: r.id,
		channel: r.channel,
		timestamp: r.timestamp,
		camX: r.cam_x,
		camY: r.cam_y,
		camW: r.cam_w,
		camH: r.cam_h
	};
}

/** Resolve camera bounds for a channel at a given timestamp (most recent entry at or before the timestamp). */
export function resolveCameraBounds(channel: string, timestamp: number): CameraBoundsEntry | null {
	const d = getDb();
	const row = d.query(
		'SELECT * FROM channel_camera_bounds WHERE channel = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1'
	).get(channel.toLowerCase(), timestamp) as CameraBoundsRow | null;
	return row ? mapCameraBoundsRow(row) : null;
}

/** Save (upsert) camera bounds for a channel at a specific timestamp. */
export function saveCameraBounds(
	channel: string,
	timestamp: number,
	camX: number,
	camY: number,
	camW: number,
	camH: number
): CameraBoundsEntry {
	const d = getDb();
	d.run(
		`INSERT INTO channel_camera_bounds (channel, timestamp, cam_x, cam_y, cam_w, cam_h)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(channel, timestamp) DO UPDATE SET
			cam_x = excluded.cam_x, cam_y = excluded.cam_y,
			cam_w = excluded.cam_w, cam_h = excluded.cam_h`,
		[channel.toLowerCase(), timestamp, camX, camY, camW, camH]
	);
	const row = d.query(
		'SELECT * FROM channel_camera_bounds WHERE channel = ? AND timestamp = ?'
	).get(channel.toLowerCase(), timestamp) as CameraBoundsRow;
	return mapCameraBoundsRow(row);
}

/** Delete a camera bounds entry by ID. */
export function deleteCameraBounds(id: number): void {
	const d = getDb();
	d.run('DELETE FROM channel_camera_bounds WHERE id = ?', [id]);
}

/** Load all camera bounds entries for a channel, ordered by timestamp. */
export function loadCameraBoundsForChannel(channel: string): CameraBoundsEntry[] {
	const d = getDb();
	const rows = d.query(
		'SELECT * FROM channel_camera_bounds WHERE channel = ? ORDER BY timestamp'
	).all(channel.toLowerCase()) as CameraBoundsRow[];
	return rows.map(mapCameraBoundsRow);
}
