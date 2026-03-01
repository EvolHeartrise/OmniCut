/**
 * Export queue module.
 * Sequential FIFO queue for video exports — one active export at a time
 * to avoid FFmpeg/disk I/O contention.
 */

import { newExportId } from '../ids.js';
import type { ClipEntry, EffectEntry } from '../types.js';
import { getClipRegion } from './clipManager.js';
import { validateClipIds } from './clipValidation.js';
import { getVideo } from './videoManager.js';
import { exportVideo, type StreamLookup } from './exporter.js';
import { exportVerticalVideo, type VerticalClip } from './verticalExporter.js';
import { cleanupFiles } from './fsUtils.js';
import * as db from './db/index.js';
import type { ExportRecord } from './db/index.js';
import { broadcastExportStatus } from './sseBroadcaster.js';
import { getStream, getStreamRecordingDir } from './streamManager.js';
import { SequentialQueue } from './sequentialQueue.js';

// --- State ---

const sq = new SequentialQueue(runExport);

// --- Public API ---

/**
 * Create and enqueue a new export. Returns the ExportRecord.
 * Validates that all clip IDs exist before creating.
 */
export function createAndQueueExport(clipIds: string[], title: string, description?: string, format?: 'standard' | 'mobile_short'): ExportRecord {
	validateClipIds(clipIds);

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
	sq.enqueue(id);

	return record;
}

/**
 * Create and enqueue an export from a video composition.
 * Freezes the video's clip entries and format into the export record.
 */
export function createAndQueueExportFromVideo(videoId: string): ExportRecord {
	const video = getVideo(videoId);
	if (!video) throw new Error(`Video not found: ${videoId}`);

	const clipIds = video.clipEntries.map((e) => e.clipId);
	validateClipIds(clipIds);

	const id = newExportId();
	const record: ExportRecord = {
		id,
		title: video.title,
		...(video.description && { description: video.description }),
		clipIds,
		clipEntries: video.clipEntries,
		...(video.effectEntries && video.effectEntries.length > 0 && { effectEntries: video.effectEntries }),
		status: 'pending',
		createdAt: Math.floor(Date.now() / 1000),
		format: video.format,
		videoId
	};

	db.saveExport(record);
	sq.enqueue(id);
	return record;
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
	if (sq.active) {
		db.updateExportStatus(sq.active, 'error', undefined, 'Server shutting down');
	}
	sq.shutdown();
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
	if (sq.isActive(id)) {
		throw new Error('Cannot re-queue an export that is currently in progress');
	}
	sq.dequeue(id);
	// Clean up previous output
	if (record.outputPath) cleanupFiles(record.outputPath);
	// Reset status
	db.updateExportStatus(id, 'pending', undefined, undefined);
	broadcastExportStatus(id, 'pending');
	sq.enqueue(id);
}

export function deleteExport(id: string): void {
	if (sq.isActive(id)) {
		throw new Error('Cannot delete an export that is currently in progress');
	}
	sq.dequeue(id);
	// Delete output file if it exists
	const record = db.loadExport(id);
	if (record?.outputPath) cleanupFiles(record.outputPath);
	db.deleteExport(id);
}

// --- Internal ---

async function runExport(exportId: string): Promise<void> {
	const record = db.loadExport(exportId);
	if (!record) return;

	// Build a map from clipId → ClipEntry for trim/speed/transition metadata
	const entryMap = new Map<string, ClipEntry>();
	if (record.clipEntries) {
		for (const entry of record.clipEntries) {
			entryMap.set(entry.clipId, entry);
		}
	}

	// Resolve clip IDs → ClipRegion objects, preserving caller-specified order
	const clips = record.clipIds.map((id) => getClipRegion(id)).filter((c) => c !== undefined);

	if (clips.length === 0) {
		db.updateExportStatus(exportId, 'error', undefined, 'No valid clips found');
		broadcastExportStatus(exportId, 'error', undefined, 'No valid clips found');
		return;
	}

	// Collect the ordered clip entries (for exporters that support effects)
	const clipEntries = clips.map((clip) => entryMap.get(clip.id));

	// Compute composition-time offsets for each clip (used to map effectEntries to per-clip windows)
	const compOffsets: number[] = [];
	let compTime = 0;
	for (let i = 0; i < clips.length; i++) {
		compOffsets.push(compTime);
		const entry = clipEntries[i];
		const trimStart = entry?.trimStart ?? 0;
		const trimEnd = entry?.trimEnd ?? 0;
		const speed = entry?.speed ?? 1;
		const dur = (clips[i].endTime - clips[i].startTime - trimStart - trimEnd) / speed;
		compTime += Math.max(0, dur);
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

		// Build channel map (streamId → channel login) for twitch-chat effects
		const channelMap = new Map<string, string>();
		for (const clip of clips) {
			if (channelMap.has(clip.streamId)) continue;
			const stream = getStream(clip.streamId);
			if (stream) channelMap.set(clip.streamId, stream.channel);
		}

		let outputPath: string;
		if (record.format === 'mobile_short') {
			// Resolve camera bounds from channel table for each clip
			const verticalClips: VerticalClip[] = [];
			for (let i = 0; i < clips.length; i++) {
				const clip = clips[i];
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
				verticalClips.push({ clip, cam, entry: clipEntries[i] });
			}
			if (verticalClips.length === 0) {
				throw new Error('No clips have camera bounds set — cannot create vertical export');
			}
			({ outputPath } = await exportVerticalVideo(verticalClips, streamMap, exportId, () => {}, record.effectEntries, compOffsets, channelMap));
		} else {
			({ outputPath } = await exportVideo(clips, streamMap, exportId, () => {}, clipEntries, record.effectEntries, compOffsets, channelMap));
		}

		db.updateExportStatus(exportId, 'ready', outputPath);
		broadcastExportStatus(exportId, 'ready', outputPath);
		console.log(`[export-queue] Export "${record.title}" (${record.format}) complete → ${outputPath}`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		db.updateExportStatus(exportId, 'error', undefined, message);
		broadcastExportStatus(exportId, 'error', undefined, message);
		console.error(`[export-queue] Export "${record.title}" failed:`, message);
	}
}
