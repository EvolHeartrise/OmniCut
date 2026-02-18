import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { startCapture, fetchStreamMeta, type CaptureHandle } from './captureProcess.js';
import { startTranscription, stopTranscription, shutdownTranscriber } from './transcriber.js';
import type { StreamInfo, SessionExport } from './types.js';

const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');
const EXPORTS_DIR = path.resolve(process.cwd(), 'exports');

// In-memory store of active captures
const captures = new Map<string, CaptureHandle>();

// In-memory store of transcriptions per stream
const streamTranscriptions = new Map<string, Array<{ text: string; startTime: number; endTime: number }>>();

// In-memory store of clip regions
interface ClipRegionData {
	id: string;
	streamId: string;
	startTime: number;
	endTime: number;
}
const clipRegionsStore: ClipRegionData[] = [];

// SSE clients for real-time updates
const sseClients = new Set<(data: string) => void>();

export function getRecordingsDir(): string {
	return RECORDINGS_DIR;
}

function broadcastUpdate(info: StreamInfo) {
	const data = JSON.stringify({ type: 'stream-update', stream: serializeStreamInfo(info) });
	for (const send of sseClients) {
		try {
			send(data);
		} catch {
			sseClients.delete(send);
		}
	}
}

function broadcastTranscription(streamId: string, text: string, startTime: number, endTime: number) {
	// Persist in memory so clients can fetch on page load
	let entries = streamTranscriptions.get(streamId);
	if (!entries) {
		entries = [];
		streamTranscriptions.set(streamId, entries);
	}
	entries.push({ text, startTime, endTime });

	const data = JSON.stringify({ type: 'transcription', streamId, text, startTime, endTime });
	for (const send of sseClients) {
		try {
			send(data);
		} catch {
			sseClients.delete(send);
		}
	}
}

function broadcastExportProgress(message: string, step: number, totalSteps: number) {
	const data = JSON.stringify({ type: 'export-progress', message, step, totalSteps });
	for (const send of sseClients) {
		try {
			send(data);
		} catch {
			sseClients.delete(send);
		}
	}
}

export function addSSEClient(send: (data: string) => void): () => void {
	sseClients.add(send);
	return () => sseClients.delete(send);
}

function serializeStreamInfo(info: StreamInfo) {
	return {
		id: info.id,
		channel: info.channel,
		status: info.status,
		startedAt: info.startedAt,
		error: info.error,
		segmentCount: info.segmentCount,
		diskUsageBytes: info.diskUsageBytes,
		viewerCount: info.viewerCount,
		streamTitle: info.streamTitle,
		offset: info.offset,
		sourceType: info.sourceType,
		parentStreamId: info.parentStreamId
	};
}

/**
 * Start capturing a Twitch channel.
 * Returns the stream info with an assigned ID.
 * Automatically spawns a VOD capture if the streamer has an ongoing archive.
 */
export async function addStream(channel: string): Promise<StreamInfo> {
	// Check if we're already capturing this channel (live track only — allow VOD alongside)
	for (const [, handle] of captures) {
		if (
			handle.info.channel.toLowerCase() === channel.toLowerCase() &&
			handle.info.sourceType === 'live' &&
			handle.info.status !== 'stopped'
		) {
			throw new Error(`Already capturing channel: ${channel}`);
		}
	}

	const id = uuidv4();

	// Ensure recordings directory exists
	fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	const handle = startCapture(channel, id, RECORDINGS_DIR, (info) => {
		broadcastUpdate(info);

		// Start transcription once segments begin appearing
		if (info.status === 'capturing') {
			startTranscription(id, info.recordingDir, (_streamId, text, startTime, endTime) => {
				broadcastTranscription(id, text, startTime, endTime);
			});
		}
	});

	captures.set(id, handle);

	// Auto-spawn VOD capture if available
	try {
		const meta = await fetchStreamMeta(channel);
		if (meta.vodId && meta.createdAt) {
			const vodId = uuidv4();
			const vodUrl = `https://twitch.tv/videos/${meta.vodId}`;

			const vodHandle = startCapture(channel, vodId, RECORDINGS_DIR, (info) => {
				broadcastUpdate(info);
			}, vodUrl);

			vodHandle.info.startedAt = Date.parse(meta.createdAt);
			vodHandle.info.parentStreamId = id;
			captures.set(vodId, vodHandle);

			console.log(`[vod:${channel}] Auto-spawned VOD capture (video ${meta.vodId}), startedAt=${meta.createdAt}`);
		}
	} catch (err) {
		console.error(`[vod:${channel}] Failed to check/spawn VOD capture:`, err);
	}

	return handle.info;
}

/**
 * Stop a stream's capture process but keep it in the map for playback.
 */
export function stopStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	if (handle.info.status === 'stopped') return true;
	stopTranscription(id);
	handle.kill();
	return true;
}

/**
 * Remove a stream entirely by ID.
 */
export function removeStream(id: string): boolean {
	const handle = captures.get(id);
	if (!handle) return false;

	stopTranscription(id);
	handle.kill();
	captures.delete(id);
	return true;
}

/**
 * List all current streams (active and recently stopped).
 */
export function listStreams(): ReturnType<typeof serializeStreamInfo>[] {
	const results: ReturnType<typeof serializeStreamInfo>[] = [];
	for (const [, handle] of captures) {
		results.push(serializeStreamInfo(handle.info));
	}
	return results;
}

/**
 * Get a single stream's info.
 */
export function getStream(id: string): ReturnType<typeof serializeStreamInfo> | null {
	const handle = captures.get(id);
	if (!handle) return null;
	return serializeStreamInfo(handle.info);
}

/**
 * Update a stream's timeline offset.
 */
export function updateStreamOffset(id: string, offset: number): boolean {
	const handle = captures.get(id);
	if (!handle) return false;
	handle.info.offset = offset;
	return true;
}

/**
 * Add or update a clip region (upsert by ID).
 */
export function addClipRegion(region: ClipRegionData): void {
	const idx = clipRegionsStore.findIndex((r) => r.id === region.id);
	if (idx !== -1) {
		clipRegionsStore[idx] = region;
	} else {
		clipRegionsStore.push(region);
	}
}

/**
 * Remove a clip region by ID.
 */
export function removeClipRegion(id: string): boolean {
	const idx = clipRegionsStore.findIndex((r) => r.id === id);
	if (idx === -1) return false;
	clipRegionsStore.splice(idx, 1);
	return true;
}

/**
 * Get all clip regions.
 */
export function getAllClipRegions(): ClipRegionData[] {
	return clipRegionsStore;
}

/**
 * Get all stored transcriptions for a stream.
 */
export function getTranscriptions(id: string): Array<{ text: string; startTime: number; endTime: number }> {
	return streamTranscriptions.get(id) || [];
}

/**
 * Get the recording directory path for a stream.
 */
export function getStreamRecordingDir(id: string): string | null {
	const handle = captures.get(id);
	if (!handle) return null;
	return handle.info.recordingDir;
}

/**
 * Export all session state to a portable JSON structure.
 */
export function exportSession(): SessionExport {
	const streams: SessionExport['streams'] = [];
	for (const [, handle] of captures) {
		const info = handle.info;
		streams.push({
			id: info.id,
			channel: info.channel,
			startedAt: info.startedAt,
			viewerCount: info.viewerCount,
			streamTitle: info.streamTitle,
			recordingDir: path.relative(RECORDINGS_DIR, info.recordingDir),
			offset: info.offset,
			sourceType: info.sourceType,
			parentStreamId: info.parentStreamId
		});
	}

	const transcriptions: SessionExport['transcriptions'] = {};
	for (const [id, entries] of streamTranscriptions) {
		transcriptions[id] = entries;
	}

	return {
		version: 1,
		exportedAt: Date.now(),
		streams,
		transcriptions,
		clipRegions: [...clipRegionsStore]
	};
}

/**
 * Import session state from a previously exported JSON structure.
 * Clears existing state and replaces with imported data.
 */
export function importSession(data: SessionExport): { imported: number; errors: string[] } {
	if (data.version !== 1) {
		return { imported: 0, errors: [`Unsupported export version: ${data.version}`] };
	}

	// Clear existing state
	for (const [id, handle] of captures) {
		stopTranscription(id);
		handle.kill();
	}
	captures.clear();
	streamTranscriptions.clear();
	clipRegionsStore.length = 0;

	const errors: string[] = [];
	let imported = 0;

	for (const stream of data.streams) {
		const recordingDir = path.join(RECORDINGS_DIR, stream.recordingDir);

		// Verify recording directory exists
		if (!fs.existsSync(recordingDir)) {
			errors.push(`Recording directory missing for ${stream.channel} (${stream.recordingDir})`);
			continue;
		}

		// Verify playlist exists
		const playlistPath = path.join(recordingDir, 'playlist.m3u8');
		if (!fs.existsSync(playlistPath)) {
			errors.push(`playlist.m3u8 missing for ${stream.channel} (${stream.recordingDir})`);
			continue;
		}

		// Recount segments and disk usage from disk
		let segmentCount = 0;
		let diskUsageBytes = 0;
		try {
			const files = fs.readdirSync(recordingDir);
			for (const file of files) {
				if (file.endsWith('.ts')) {
					segmentCount++;
				}
				const stat = fs.statSync(path.join(recordingDir, file));
				diskUsageBytes += stat.size;
			}
		} catch {
			// Non-fatal: just use zeros
		}

		const info: StreamInfo = {
			id: stream.id,
			channel: stream.channel,
			status: 'stopped',
			startedAt: stream.startedAt,
			segmentCount,
			diskUsageBytes,
			viewerCount: stream.viewerCount,
			streamTitle: stream.streamTitle,
			recordingDir,
			offset: stream.offset,
			sourceType: stream.sourceType,
			parentStreamId: stream.parentStreamId
		};

		// Create stub CaptureHandle (no process, just data)
		const stubHandle: CaptureHandle = {
			info,
			kill: () => {},
			segmentWatchInterval: null
		};

		captures.set(stream.id, stubHandle);
		imported++;
	}

	// Restore transcriptions (only for successfully imported streams)
	if (data.transcriptions) {
		for (const [streamId, entries] of Object.entries(data.transcriptions)) {
			if (captures.has(streamId)) {
				streamTranscriptions.set(streamId, [...entries]);
			}
		}
	}

	// Restore clip regions (only for successfully imported streams)
	if (data.clipRegions) {
		for (const region of data.clipRegions) {
			if (captures.has(region.streamId)) {
				clipRegionsStore.push({ ...region });
			}
		}
	}

	return { imported, errors };
}

/**
 * Export all clip regions as a single stitched video file.
 * Clips are sorted by startTime (same order as Cleaning mode).
 */
export async function exportVideo(filename: string): Promise<{ outputPath: string }> {
	const sortedClips = [...clipRegionsStore].sort((a, b) => a.startTime - b.startTime);
	if (sortedClips.length === 0) {
		throw new Error('No clip regions to export');
	}

	fs.mkdirSync(EXPORTS_DIR, { recursive: true });

	const tempDir = path.join(EXPORTS_DIR, `temp_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	const clipFiles: string[] = [];
	const totalSteps = sortedClips.length + 1; // clips + concat

	broadcastExportProgress(`Starting export: ${sortedClips.length} clips`, 0, totalSteps);

	// Detect NVENC support by running a quick test encode
	let useNvenc = await detectNvenc();
	if (useNvenc) {
		broadcastExportProgress('Using NVENC GPU encoding', 0, totalSteps);
	} else {
		broadcastExportProgress('NVENC unavailable — using CPU encoding (slower)', 0, totalSteps);
	}

	try {
		for (let i = 0; i < sortedClips.length; i++) {
			const clip = sortedClips[i];
			const handle = captures.get(clip.streamId);
			if (!handle) {
				throw new Error(`Stream ${clip.streamId} not found for clip ${i + 1}`);
			}

			const info = handle.info;
			const anchor = info.startedAt / 1000;
			const localStart = clip.startTime - anchor + info.offset;
			const localEnd = clip.endTime - anchor + info.offset;
			const dur = clip.endTime - clip.startTime;
			const playlistPath = path.join(info.recordingDir, 'playlist.m3u8');

			const encoder = useNvenc ? 'NVENC' : 'x264';
			broadcastExportProgress(
				`[${encoder}] Encoding clip ${i + 1}/${sortedClips.length} — ${info.channel} (${dur.toFixed(1)}s)`,
				i, totalSteps
			);

			// Parse playlist to find segments covering [localStart, localEnd]
			const playlistContent = fs.readFileSync(playlistPath, 'utf-8');
			const lines = playlistContent.split('\n');
			let segTime = 0;
			const relevantSegments: { file: string; startTime: number; duration: number }[] = [];

			for (let li = 0; li < lines.length; li++) {
				const line = lines[li].trim();
				if (line.startsWith('#EXTINF:')) {
					const segDur = parseFloat(line.split(':')[1].replace(',', ''));
					const nextLine = lines[li + 1]?.trim();
					if (nextLine && !nextLine.startsWith('#')) {
						const segEnd = segTime + segDur;
						if (segEnd > localStart && segTime < localEnd) {
							const segPath = path.join(info.recordingDir, nextLine);
							relevantSegments.push({ file: segPath, startTime: segTime, duration: segDur });
						}
						segTime = segEnd;
					}
				}
			}

			if (relevantSegments.length === 0) {
				throw new Error(`No segments found for clip ${i + 1} (${info.channel})`);
			}

			// Build concat list for the relevant segments
			const padded = i.toString().padStart(4, '0');
			const clipConcatPath = path.join(tempDir, `clip_${padded}_concat.txt`);
			const clipConcatContent = relevantSegments
				.map((s) => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
				.join('\n');
			fs.writeFileSync(clipConcatPath, clipConcatContent);

			const segGroupStart = relevantSegments[0].startTime;
			const trimStart = Math.max(0, localStart - segGroupStart);
			const clipFile = path.join(tempDir, `clip_${padded}.mp4`);

			// Encode directly from segments → mp4 in one step
			// (Two-step copy-then-encode fails for short clips that lack keyframes)
			const encodeArgs = useNvenc
				? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18']
				: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'];

			try {
				await runFfmpeg([
					'-f', 'concat', '-safe', '0', '-i', clipConcatPath,
					'-ss', trimStart.toFixed(3), '-t', dur.toFixed(3),
					'-map', '0:v:0', '-map', '0:a:0',
					'-vf', 'format=yuv420p',
					...encodeArgs,
					'-c:a', 'aac', '-b:a', '192k',
					'-movflags', '+faststart',
					'-y', clipFile
				]);
			} catch (err) {
				if (useNvenc) {
					console.error(`NVENC failed on clip ${i + 1}, falling back to libx264 ultrafast`);
					broadcastExportProgress(
						`NVENC failed — switching to CPU encoding`,
						i, totalSteps
					);
					useNvenc = false;

					await runFfmpeg([
						'-f', 'concat', '-safe', '0', '-i', clipConcatPath,
						'-ss', trimStart.toFixed(3), '-t', dur.toFixed(3),
						'-map', '0:v:0', '-map', '0:a:0',
						'-vf', 'format=yuv420p',
						'-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
						'-c:a', 'aac', '-b:a', '192k',
						'-movflags', '+faststart',
						'-y', clipFile
					]);
				} else {
					throw err;
				}
			}

			clipFiles.push(clipFile);
		}

		// Create final concat list
		const concatListPath = path.join(tempDir, 'concat.txt');
		const concatContent = clipFiles
			.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
			.join('\n');
		fs.writeFileSync(concatListPath, concatContent);

		const safeName = filename.replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.mp4`);

		broadcastExportProgress(
			`Concatenating ${clipFiles.length} clips into ${safeName}.mp4`,
			sortedClips.length, totalSteps
		);

		// Fast concat — all clips are already encoded mp4s with consistent format
		await runFfmpeg([
			'-f', 'concat', '-safe', '0', '-i', concatListPath,
			'-c', 'copy', '-movflags', '+faststart',
			'-y', outputPath
		]);

		broadcastExportProgress(`Done — saved to ${outputPath}`, totalSteps, totalSteps);
		return { outputPath };
	} finally {
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

/** Run an ffmpeg command and return a promise. Rejects with full stderr on failure. */
function runFfmpeg(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn('ffmpeg', args);
		let stderr = '';
		proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
		proc.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-1000)}`));
		});
		proc.on('error', reject);
	});
}

/** Test if NVENC is available by encoding a tiny synthetic video. */
function detectNvenc(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn('ffmpeg', [
			'-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
			'-f', 'lavfi', '-i', 'anullsrc=d=0.1',
			'-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18',
			'-c:a', 'aac',
			'-f', 'null', '-'
		]);
		proc.on('close', (code) => resolve(code === 0));
		proc.on('error', () => resolve(false));
	});
}

/**
 * Clean up all captures on shutdown.
 */
export function shutdownAll() {
	shutdownTranscriber();
	for (const [id, handle] of captures) {
		handle.kill();
		captures.delete(id);
	}
}

// Cleanup on process exit
process.on('SIGINT', () => {
	shutdownAll();
	process.exit(0);
});
process.on('SIGTERM', () => {
	shutdownAll();
	process.exit(0);
});
