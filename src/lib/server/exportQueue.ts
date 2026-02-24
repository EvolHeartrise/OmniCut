/**
 * Export queue module.
 * Sequential FIFO queue for video exports — one active export at a time
 * to avoid FFmpeg/disk I/O contention with the clip encoder.
 */

import { newExportId } from '../ids.js';
import { getClipRegion } from './clipManager.js';
import { exportVideo } from './exporter.js';
import * as db from './persistence.js';
import type { ExportRecord } from './persistence.js';
import { broadcastExportStatus } from './sseBroadcaster.js';

// --- State ---

const queue: string[] = [];
let activeExport: { exportId: string } | null = null;

// --- Public API ---

/**
 * Create and enqueue a new export. Returns the ExportRecord.
 * Validates that all clip IDs exist before creating.
 */
export function createAndQueueExport(clipIds: string[], title: string, description?: string): ExportRecord {
	// Validate all clip IDs exist
	const missing: string[] = [];
	for (const clipId of clipIds) {
		if (!getClipRegion(clipId)) {
			missing.push(clipId);
		}
	}
	if (missing.length > 0) {
		throw new Error(`Clip IDs not found: ${missing.join(', ')}`);
	}

	const id = newExportId();
	const record: ExportRecord = {
		id,
		title,
		...(description && { description }),
		clipIds,
		status: 'pending',
		createdAt: Math.floor(Date.now() / 1000)
	};

	db.saveExport(record);
	queueExport(id);

	return record;
}

/**
 * Enqueue an existing export ID for processing.
 */
export function queueExport(exportId: string): void {
	queue.push(exportId);
	processQueue();
}

/**
 * On startup, mark any incomplete exports (pending/exporting) as error —
 * the process died before they could complete.
 */
export function restoreExportQueue(): void {
	const all = db.loadAllExports();
	for (const record of all) {
		if (record.status === 'pending' || record.status === 'exporting') {
			db.updateExportStatus(record.id, 'error', undefined, 'Server restarted before export completed');
		}
	}
}

/**
 * Shut down the export queue. Marks active export as error.
 */
export function shutdownExportQueue(): void {
	if (activeExport) {
		db.updateExportStatus(activeExport.exportId, 'error', undefined, 'Server shutting down');
		activeExport = null;
	}
	queue.length = 0;
}

// Re-export DB reads for convenience
export function loadExport(id: string): ExportRecord | null {
	return db.loadExport(id);
}

export function loadAllExports(): ExportRecord[] {
	return db.loadAllExports();
}

// --- Internal ---

function processQueue(): void {
	if (activeExport || queue.length === 0) return;
	const exportId = queue.shift()!;
	runExport(exportId);
}

async function runExport(exportId: string): Promise<void> {
	const record = db.loadExport(exportId);
	if (!record) {
		processQueue();
		return;
	}

	activeExport = { exportId };

	// Resolve clip IDs → ClipRegion objects, preserving caller-specified order
	const clips = record.clipIds.map((id) => getClipRegion(id)).filter((c) => c !== undefined);

	if (clips.length === 0) {
		db.updateExportStatus(exportId, 'error', undefined, 'No valid clips found');
		broadcastExportStatus(exportId, 'error', undefined, 'No valid clips found');
		activeExport = null;
		processQueue();
		return;
	}

	// Update status → exporting
	db.updateExportStatus(exportId, 'exporting');
	broadcastExportStatus(exportId, 'exporting');

	// Derive filename from title
	const safeName = record.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);

	try {
		const { outputPath } = await exportVideo(clips, safeName, () => {});

		db.updateExportStatus(exportId, 'ready', outputPath);
		broadcastExportStatus(exportId, 'ready', outputPath);
		console.log(`[export-queue] Export "${record.title}" complete → ${outputPath}`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		db.updateExportStatus(exportId, 'error', undefined, message);
		broadcastExportStatus(exportId, 'error', undefined, message);
		console.error(`[export-queue] Export "${record.title}" failed:`, message);
	} finally {
		activeExport = null;
		processQueue();
	}
}
