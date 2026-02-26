/**
 * YouTube upload queue module.
 * Sequential FIFO queue — one active upload at a time.
 * Mirrors the exportQueue pattern.
 */

import { newUploadId } from '../ids.js';
import * as db from './persistence.js';
import type { YouTubeUploadRecord } from './persistence.js';
import { uploadVideo, addToPlaylist } from './youtubeClient.js';
import { broadcastYouTubeUploadStatus } from './sseBroadcaster.js';

// --- State ---

const queue: string[] = [];
let activeUpload: { uploadId: string } | null = null;

// --- Public API ---

/**
 * Create and enqueue a new YouTube upload. Returns the upload record.
 * Validates that the export exists and is ready.
 */
export function createAndQueueUpload(
	exportId: string,
	accountId: string,
	metadata: {
		title: string;
		description?: string;
		privacy?: string;
		tags?: string[];
		categoryId?: string;
		playlistId?: string;
	}
): YouTubeUploadRecord {
	// Validate export exists and is ready
	const exportRecord = db.loadExport(exportId);
	if (!exportRecord) throw new Error(`Export not found: ${exportId}`);
	if (exportRecord.status !== 'ready') throw new Error(`Export is not ready (status: ${exportRecord.status})`);
	if (!exportRecord.outputPath) throw new Error('Export has no output file');

	// Validate account exists
	const account = db.loadYouTubeAccount(accountId);
	if (!account) throw new Error(`YouTube account not found: ${accountId}`);

	const id = newUploadId();
	const record: YouTubeUploadRecord = {
		id,
		exportId,
		accountId,
		title: metadata.title,
		...(metadata.description && { description: metadata.description }),
		privacy: metadata.privacy ?? 'private',
		...(metadata.tags && { tags: metadata.tags }),
		...(metadata.categoryId && { categoryId: metadata.categoryId }),
		...(metadata.playlistId && { playlistId: metadata.playlistId }),
		status: 'pending',
		progress: 0,
		createdAt: Math.floor(Date.now() / 1000)
	};

	db.saveYouTubeUpload(record);
	queueUpload(id);

	return record;
}

/**
 * Enqueue an existing upload ID for processing.
 */
function queueUpload(uploadId: string): void {
	queue.push(uploadId);
	processQueue();
}

/**
 * On startup, mark any incomplete uploads as error.
 */
export function restoreUploadQueue(): void {
	const all = db.loadAllYouTubeUploads();
	for (const record of all) {
		if (record.status === 'pending' || record.status === 'uploading') {
			db.updateYouTubeUploadStatus(record.id, 'error', undefined, undefined, 'Server restarted before upload completed');
		}
	}
}

/**
 * Shut down the upload queue. Marks active upload as error.
 */
export function shutdownUploadQueue(): void {
	if (activeUpload) {
		db.updateYouTubeUploadStatus(activeUpload.uploadId, 'error', undefined, undefined, 'Server shutting down');
		activeUpload = null;
	}
	queue.length = 0;
}

// Re-export DB reads for convenience
export function loadUpload(id: string): YouTubeUploadRecord | null {
	return db.loadYouTubeUpload(id);
}

export function loadAllUploads(): YouTubeUploadRecord[] {
	return db.loadAllYouTubeUploads();
}

export function loadUploadsByExport(exportId: string): YouTubeUploadRecord[] {
	return db.loadYouTubeUploadsByExport(exportId);
}

export function deleteUpload(id: string): void {
	if (activeUpload?.uploadId === id) {
		throw new Error('Cannot delete an upload that is currently in progress');
	}
	// Remove from queue if pending
	const idx = queue.indexOf(id);
	if (idx !== -1) queue.splice(idx, 1);
	db.deleteYouTubeUpload(id);
}

// --- Internal ---

function processQueue(): void {
	if (activeUpload || queue.length === 0) return;
	const uploadId = queue.shift()!;
	runUpload(uploadId);
}

async function runUpload(uploadId: string): Promise<void> {
	const record = db.loadYouTubeUpload(uploadId);
	if (!record) {
		processQueue();
		return;
	}

	activeUpload = { uploadId };

	// Re-validate export
	const exportRecord = db.loadExport(record.exportId);
	if (!exportRecord?.outputPath) {
		db.updateYouTubeUploadStatus(uploadId, 'error', undefined, undefined, 'Export output file not found');
		broadcastYouTubeUploadStatus(uploadId, 'error', undefined, undefined, 'Export output file not found');
		activeUpload = null;
		processQueue();
		return;
	}

	// Update status → uploading
	db.updateYouTubeUploadStatus(uploadId, 'uploading', 0);
	broadcastYouTubeUploadStatus(uploadId, 'uploading', 0);

	try {
		const videoId = await uploadVideo(
			record.accountId,
			exportRecord.outputPath,
			{
				title: record.title,
				description: record.description,
				privacy: record.privacy,
				tags: record.tags,
				categoryId: record.categoryId
			},
			(progress) => {
				db.updateYouTubeUploadStatus(uploadId, 'uploading', progress);
				broadcastYouTubeUploadStatus(uploadId, 'uploading', progress);
			}
		);

		// Add to playlist if specified
		if (record.playlistId) {
			try {
				await addToPlaylist(record.accountId, videoId, record.playlistId);
			} catch (err) {
				console.warn(`[youtube-upload] Failed to add video to playlist: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		db.updateYouTubeUploadStatus(uploadId, 'complete', 1, videoId);
		broadcastYouTubeUploadStatus(uploadId, 'complete', 1, videoId);
		console.log(`[youtube-upload] Upload "${record.title}" complete → https://youtu.be/${videoId}`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		db.updateYouTubeUploadStatus(uploadId, 'error', undefined, undefined, message);
		broadcastYouTubeUploadStatus(uploadId, 'error', undefined, undefined, message);
		console.error(`[youtube-upload] Upload "${record.title}" failed:`, message);
	} finally {
		activeUpload = null;
		processQueue();
	}
}
