/**
 * Export queue module.
 * Sequential FIFO queue for video exports — one active export at a time
 * to avoid FFmpeg/disk I/O contention.
 */

import { newExportId } from '../ids.js';
import { getClipRegion } from './clipManager.js';
import { exportVideo, type StreamLookup } from './exporter.js';
import { exportVerticalVideo, type VerticalClip } from './verticalExporter.js';
import { cleanupFiles } from './fsUtils.js';
import * as db from './persistence.js';
import type { ExportRecord } from './persistence.js';
import { broadcastExportStatus } from './sseBroadcaster.js';
import { getStream, getStreamRecordingDir } from './streamManager.js';

// --- State ---

const queue: string[] = [];
let activeExport: { exportId: string } | null = null;

// --- Public API ---

/**
 * Create and enqueue a new export. Returns the ExportRecord.
 * Validates that all clip IDs exist before creating.
 */
export function createAndQueueExport(clipIds: string[], title: string, description?: string, format?: 'standard' | 'mobile_short'): ExportRecord {
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
		createdAt: Math.floor(Date.now() / 1000),
		format: format ?? 'standard'
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

/**
 * Re-queue an existing export in place. Resets status to pending,
 * cleans up any previous output file, and enqueues for processing.
 */
export function requeueExport(id: string): void {
	const record = db.loadExport(id);
	if (!record) throw new Error('Export not found');
	if (activeExport?.exportId === id) {
		throw new Error('Cannot re-queue an export that is currently in progress');
	}
	// Remove from queue if already pending
	const idx = queue.indexOf(id);
	if (idx !== -1) queue.splice(idx, 1);
	// Clean up previous output
	if (record.outputPath) cleanupFiles(record.outputPath);
	// Reset status
	db.updateExportStatus(id, 'pending', undefined, undefined);
	broadcastExportStatus(id, 'pending');
	queueExport(id);
}

export function deleteExport(id: string): void {
	if (activeExport?.exportId === id) {
		throw new Error('Cannot delete an export that is currently in progress');
	}
	// Remove from queue if pending
	const idx = queue.indexOf(id);
	if (idx !== -1) queue.splice(idx, 1);
	// Delete output file if it exists
	const record = db.loadExport(id);
	if (record?.outputPath) cleanupFiles(record.outputPath);
	db.deleteExport(id);
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

	try {
		// Build stream lookup map for all clips
		const streamMap = new Map<string, StreamLookup>();
		for (const clip of clips) {
			if (streamMap.has(clip.streamId)) continue;
			const stream = getStream(clip.streamId);
			const recordingDir = getStreamRecordingDir(clip.streamId);
			if (stream && recordingDir) {
				streamMap.set(clip.streamId, {
					recordingDir,
					startedAt: stream.startedAt,
					offset: stream.offset
				});
			}
		}

		let outputPath: string;
		if (record.format === 'mobile_short') {
			// Resolve camera bounds from channel table for each clip
			const verticalClips: VerticalClip[] = [];
			for (const clip of clips) {
				const stream = getStream(clip.streamId);
				if (!stream) {
					console.warn(`[export-queue] Skipping clip ${clip.id} — stream not found`);
					continue;
				}
				const cam = db.resolveCameraBounds(stream.channel, clip.startTime);
				if (!cam) {
					console.warn(`[export-queue] Skipping clip ${clip.id} — no camera bounds for ${stream.channel}`);
					continue;
				}
				verticalClips.push({ clip, cam });
			}
			if (verticalClips.length === 0) {
				throw new Error('No clips have camera bounds set — cannot create vertical export');
			}
			({ outputPath } = await exportVerticalVideo(verticalClips, streamMap, exportId, () => {}));
		} else {
			({ outputPath } = await exportVideo(clips, streamMap, exportId, () => {}));
		}

		db.updateExportStatus(exportId, 'ready', outputPath);
		broadcastExportStatus(exportId, 'ready', outputPath);
		console.log(`[export-queue] Export "${record.title}" (${record.format}) complete → ${outputPath}`);
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
