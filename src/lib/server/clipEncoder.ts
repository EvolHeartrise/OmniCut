/**
 * Clip encoding queue module.
 * Encodes clip regions to MP4 eagerly (on create/update) so exports can
 * concat pre-encoded files near-instantly with `-c copy`.
 *
 * Supports parallel encoding (N-concurrent) and smart-cut to minimize
 * re-encoding by stream-copying GOP-aligned middles.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Subprocess } from 'bun';
import type { ClipRegion, StreamInfo } from './types.js';
import { broadcastClipEncodeStatus } from './sseBroadcaster.js';

// Resolved lazily after first call — depends on EXPORTS_DIR env
let clipsDir: string | null = null;

function getClipsDir(): string {
	if (!clipsDir) {
		const exportsDir = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));
		clipsDir = path.join(exportsDir, 'clips');
		fs.mkdirSync(clipsDir, { recursive: true });
	}
	return clipsDir;
}

export type ClipEncodeStatus = 'pending' | 'encoding' | 'ready' | 'error';

interface EncodeEntry {
	status: ClipEncodeStatus;
	outputPath?: string;
	error?: string;
}

// --- State ---

const encodeStatus = new Map<string, EncodeEntry>();
const queue: string[] = [];
const activeEncodes = new Map<string, { proc: Subprocess | null }>();
const MAX_CONCURRENT_NVENC = 2;
const MAX_CONCURRENT_CPU = 1;
let cachedNvenc: boolean | null = null;

// Injected lookups — set via setLookups() from streamManager init
let lookupClip: (id: string) => ClipRegion | undefined;
let lookupStream: (streamId: string) => StreamInfo | null;
let detectNvenc: () => Promise<boolean>;

/**
 * Inject lookup functions so clipEncoder can resolve clips and streams
 * without circular imports.
 */
export function setLookups(
	clipFn: (id: string) => ClipRegion | undefined,
	streamFn: (streamId: string) => StreamInfo | null,
	nvencFn: () => Promise<boolean>
): void {
	lookupClip = clipFn;
	lookupStream = streamFn;
	detectNvenc = nvencFn;
}

// --- Step 1: ffprobe helper (single call for keyframes + stream params) ---

interface ClipProbeResult {
	firstKF: number | null; // first keyframe >= startTime
	lastKF: number | null; // last keyframe <= endTime
	bitrate: number; // bps (default 6Mbps if unavailable)
}

async function probeClipInfo(
	concatPath: string,
	startTime: number,
	endTime: number
): Promise<ClipProbeResult> {
	const defaultResult: ClipProbeResult = { firstKF: null, lastKF: null, bitrate: 6_000_000 };

	// Single ffprobe call: packets (keyframes) + stream params
	const proc = Bun.spawn(
		[
			'ffprobe',
			'-v', 'quiet',
			'-select_streams', 'v:0',
			'-show_entries', 'packet=pts_time,flags:stream=bit_rate',
			'-read_intervals', `${startTime.toFixed(3)}%${endTime.toFixed(3)}`,
			'-of', 'json',
			'-f', 'concat',
			'-safe', '0',
			'-i', concatPath
		],
		{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
	);

	const stdout = await new Response(proc.stdout).text();
	const code = await proc.exited;
	if (code !== 0) return defaultResult;

	let data: { packets?: Array<{ pts_time: string; flags: string }>; streams?: Array<{ bit_rate: string }> };
	try {
		data = JSON.parse(stdout);
	} catch {
		return defaultResult;
	}

	// Extract keyframes from packets
	let firstKF: number | null = null;
	let lastKF: number | null = null;
	if (data.packets) {
		for (const pkt of data.packets) {
			const pts = parseFloat(pkt.pts_time);
			if (isNaN(pts) || !pkt.flags?.startsWith('K')) continue;
			if (pts >= startTime && firstKF === null) firstKF = pts;
			if (pts <= endTime) lastKF = pts;
		}
	}

	// Extract bitrate from stream info
	let bitrate = 6_000_000;
	if (data.streams?.[0]?.bit_rate) {
		const parsed = parseInt(data.streams[0].bit_rate, 10);
		if (!isNaN(parsed) && parsed > 0) bitrate = parsed;
	}

	return { firstKF, lastKF, bitrate };
}

// --- Step 5: Consolidated ffmpeg arg builder ---

interface EncodeOpts {
	concatPath: string;
	seekStart: number;
	duration: number;
	outputPath: string;
	useNvenc: boolean;
	/** When set, use bitrate mode instead of quality mode (for smart-cut edges) */
	targetBitrate?: number;
}

function buildEncodeArgs(opts: EncodeOpts): string[] {
	const { concatPath, seekStart, duration, outputPath, useNvenc, targetBitrate } = opts;

	const input = [
		...(useNvenc ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
		'-f', 'concat',
		'-safe', '0',
		'-i', concatPath,
		'-ss', seekStart.toFixed(3),
		'-t', duration.toFixed(3),
		'-map', '0:v:0',
		'-map', '0:a:0'
	];

	let videoArgs: string[];
	if (useNvenc) {
		if (targetBitrate) {
			videoArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', `${targetBitrate}`];
		} else {
			videoArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18'];
		}
	} else {
		// CPU fallback — keep format filter for safety
		if (targetBitrate) {
			videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${targetBitrate}`];
		} else {
			videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'];
		}
	}

	return [
		...input,
		...videoArgs,
		'-c:a', 'aac',
		'-b:a', '192k',
		'-movflags', '+faststart',
		'-y',
		outputPath
	];
}

// --- Public API ---

/**
 * Enqueue a clip for encoding. If already queued/encoding, invalidates and re-queues.
 */
export function enqueueClipEncode(clipId: string): void {
	// If already in queue (pending), remove the old entry so we re-queue at the end
	const idx = queue.indexOf(clipId);
	if (idx !== -1) queue.splice(idx, 1);

	// If actively encoding this clip, kill it — it'll be re-queued
	const active = activeEncodes.get(clipId);
	if (active) {
		active.proc?.kill();
		activeEncodes.delete(clipId);
	}

	// Delete stale encoded file if it exists
	const existing = encodeStatus.get(clipId);
	if (existing?.outputPath) {
		try {
			fs.unlinkSync(existing.outputPath);
		} catch {
			/* ok */
		}
	}

	encodeStatus.set(clipId, { status: 'pending' });
	broadcastClipEncodeStatus(clipId, 'pending');
	queue.push(clipId);
	processQueue();
}

/**
 * Cancel a pending/active encode and delete the encoded file.
 */
export function cancelClipEncode(clipId: string): void {
	// Remove from queue
	const idx = queue.indexOf(clipId);
	if (idx !== -1) queue.splice(idx, 1);

	// Kill if actively encoding
	const active = activeEncodes.get(clipId);
	if (active) {
		active.proc?.kill();
		activeEncodes.delete(clipId);
		processQueue();
	}

	// Delete encoded file
	const entry = encodeStatus.get(clipId);
	if (entry?.outputPath) {
		try {
			fs.unlinkSync(entry.outputPath);
		} catch {
			/* ok */
		}
	}

	encodeStatus.delete(clipId);
}

/**
 * Get the encode status for a clip.
 */
export function getClipEncodeStatus(clipId: string): ClipEncodeStatus | null {
	return encodeStatus.get(clipId)?.status ?? null;
}

/**
 * Get the path to the pre-encoded MP4 if ready, null otherwise.
 */
export function getEncodedClipPath(clipId: string): string | null {
	const entry = encodeStatus.get(clipId);
	if (entry?.status === 'ready' && entry.outputPath) return entry.outputPath;
	return null;
}

/**
 * Wait until a specific clip reaches 'ready' or 'error' status.
 * Returns the status when resolved.
 */
export function waitForClipReady(clipId: string): Promise<ClipEncodeStatus> {
	const entry = encodeStatus.get(clipId);
	if (entry?.status === 'ready' || entry?.status === 'error') {
		return Promise.resolve(entry.status);
	}
	return new Promise((resolve) => {
		const check = () => {
			const e = encodeStatus.get(clipId);
			if (!e || e.status === 'ready' || e.status === 'error') {
				resolve(e?.status ?? 'error');
			} else {
				setTimeout(check, 250);
			}
		};
		setTimeout(check, 250);
	});
}

/**
 * Restore encode state on startup by scanning for existing encoded files.
 * Marks clips as 'ready' if a valid MP4 exists, otherwise enqueues them.
 */
export function restoreEncodeState(clipIds: string[]): void {
	const dir = getClipsDir();
	for (const clipId of clipIds) {
		const filePath = path.join(dir, `${clipId}.mp4`);
		if (fs.existsSync(filePath)) {
			const stat = fs.statSync(filePath);
			if (stat.size > 0) {
				encodeStatus.set(clipId, { status: 'ready', outputPath: filePath });
				continue;
			}
			// Empty file — delete and re-encode
			try {
				fs.unlinkSync(filePath);
			} catch {
				/* ok */
			}
		}
		// No valid file — enqueue for encoding
		encodeStatus.set(clipId, { status: 'pending' });
		queue.push(clipId);
	}
	processQueue();
}

/**
 * Kill all active encode processes on shutdown.
 */
export function shutdownEncoder(): void {
	for (const [, { proc }] of activeEncodes) {
		proc?.kill();
	}
	activeEncodes.clear();
	queue.length = 0;
}

// --- Internal ---

function processQueue(): void {
	const maxConcurrent = cachedNvenc === false ? MAX_CONCURRENT_CPU : MAX_CONCURRENT_NVENC;

	while (activeEncodes.size < maxConcurrent && queue.length > 0) {
		const clipId = queue.shift()!;
		// Reserve the slot immediately so the next iteration sees the correct size
		activeEncodes.set(clipId, { proc: null });
		encodeClip(clipId);
	}
}

async function runFfmpeg(args: string[], clipId: string): Promise<void> {
	const proc = Bun.spawn(['ffmpeg', ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	activeEncodes.set(clipId, { proc });

	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-500)}`);
}

function cleanupTempFiles(...paths: string[]): void {
	for (const p of paths) {
		try { fs.unlinkSync(p); } catch { /* ok */ }
	}
}

async function encodeClip(clipId: string): Promise<void> {
	const clip = lookupClip(clipId);
	if (!clip) {
		encodeStatus.delete(clipId);
		processQueue();
		return;
	}

	const info = lookupStream(clip.streamId);
	if (!info) {
		encodeStatus.set(clipId, { status: 'error', error: `Stream ${clip.streamId} not found` });
		broadcastClipEncodeStatus(clipId, 'error', `Stream ${clip.streamId} not found`);
		processQueue();
		return;
	}

	encodeStatus.set(clipId, { status: 'encoding' });
	broadcastClipEncodeStatus(clipId, 'encoding');

	const outputPath = path.join(getClipsDir(), `${clipId}.mp4`);

	try {
		const anchor = info.startedAt / 1000;
		const localStart = clip.startTime - anchor + info.offset;
		const localEnd = clip.endTime - anchor + info.offset;
		const dur = clip.endTime - clip.startTime;
		const playlistPath = path.join(info.recordingDir, 'playlist.m3u8');

		// Parse playlist segments
		const segments = parseRelevantSegments(playlistPath, info.recordingDir, localStart, localEnd);
		if (segments.length === 0) {
			throw new Error(`No segments found for clip ${clipId}`);
		}

		// Write concat list to a temp file next to the output
		const concatPath = outputPath + '.concat.txt';
		const concatContent = segments.map((s) => ffmpegConcatEscape(s.file)).join('\n');
		fs.writeFileSync(concatPath, concatContent);

		const segGroupStart = segments[0].startTime;
		const trimStart = Math.max(0, localStart - segGroupStart);

		const useNvenc = await detectNvenc();
		if (cachedNvenc === null) {
			cachedNvenc = useNvenc;
			// Now that we know the real limit, drain excess slots won't help
			// (already launched), but future processQueue calls will be correct.
		}

		// --- Step 3: Smart cut ---
		// Single ffprobe call for both keyframe positions and stream bitrate
		const probe = await probeClipInfo(concatPath, trimStart, trimStart + dur);

		// Minimum duration for smart cut to be worthwhile (~2 GOPs, ~4s at typical 2s GOP)
		const MIN_SMART_CUT_DURATION = 4.0;
		const canSmartCut =
			probe.firstKF !== null &&
			probe.lastKF !== null &&
			probe.lastKF > probe.firstKF &&
			dur >= MIN_SMART_CUT_DURATION;

		// Check if both cut points land on keyframes (full copy)
		const KF_TOLERANCE = 0.05; // 50ms tolerance for keyframe alignment
		const startOnKF = probe.firstKF !== null && Math.abs(probe.firstKF - trimStart) < KF_TOLERANCE;
		const endOnKF = probe.lastKF !== null && Math.abs(probe.lastKF - (trimStart + dur)) < KF_TOLERANCE;

		if (startOnKF && endOnKF) {
			// Full copy — both cut points on keyframes
			console.log(`[clip-encoder] ${clipId}: full stream copy (both cuts on keyframes)`);
			const args = [
				'-f', 'concat', '-safe', '0', '-i', concatPath,
				'-ss', trimStart.toFixed(3),
				'-t', dur.toFixed(3),
				'-map', '0:v:0', '-map', '0:a:0',
				'-c', 'copy',
				'-movflags', '+faststart',
				'-y', outputPath
			];
			try {
				await runFfmpeg(args, clipId);
			} catch (err) {
				// Stream copy can fail on edge cases — fall back to full encode
				console.warn(`[clip-encoder] ${clipId}: stream copy failed, falling back to full encode`);
				await fullEncode(clipId, concatPath, trimStart, dur, outputPath, useNvenc);
			}
		} else if (canSmartCut) {
			// Smart cut — encode edges, copy middle
			console.log(`[clip-encoder] ${clipId}: smart cut [${trimStart.toFixed(2)} → ${probe.firstKF!.toFixed(2)} | copy → ${probe.lastKF!.toFixed(2)} | → ${(trimStart + dur).toFixed(2)}]`);

			// Edge bitrate = source bitrate × 1.2 to avoid visible seams
			const edgeBitrate = Math.round(probe.bitrate * 1.2);

			const leadPath = path.join(getClipsDir(), `${clipId}_lead.mp4`);
			const bulkPath = path.join(getClipsDir(), `${clipId}_bulk.mp4`);
			const trailPath = path.join(getClipsDir(), `${clipId}_trail.mp4`);
			const tempFiles = [leadPath, bulkPath, trailPath];

			try {
				const hasLeading = probe.firstKF! - trimStart > KF_TOLERANCE;
				const hasTrailing = (trimStart + dur) - probe.lastKF! > KF_TOLERANCE;
				const partFiles: string[] = [];

				// Leading edge: [trimStart → firstKF]
				if (hasLeading) {
					const leadDur = probe.firstKF! - trimStart;
					const leadArgs = buildEncodeArgs({
						concatPath, seekStart: trimStart, duration: leadDur,
						outputPath: leadPath, useNvenc, targetBitrate: edgeBitrate
					});
					await runFfmpeg(leadArgs, clipId);
					partFiles.push(leadPath);
				}

				// Bulk: stream copy [firstKF → lastKF]
				const bulkDur = probe.lastKF! - probe.firstKF!;
				if (bulkDur > 0) {
					const bulkArgs = [
						'-f', 'concat', '-safe', '0', '-i', concatPath,
						'-ss', probe.firstKF!.toFixed(3),
						'-t', bulkDur.toFixed(3),
						'-map', '0:v:0', '-map', '0:a:0',
						'-c', 'copy',
						'-movflags', '+faststart',
						'-y', bulkPath
					];
					await runFfmpeg(bulkArgs, clipId);
					partFiles.push(bulkPath);
				}

				// Trailing edge: [lastKF → trimStart + dur]
				if (hasTrailing) {
					const trailDur = (trimStart + dur) - probe.lastKF!;
					const trailArgs = buildEncodeArgs({
						concatPath, seekStart: probe.lastKF!, duration: trailDur,
						outputPath: trailPath, useNvenc, targetBitrate: edgeBitrate
					});
					await runFfmpeg(trailArgs, clipId);
					partFiles.push(trailPath);
				}

				if (partFiles.length === 1) {
					// Only one part — just rename it
					fs.renameSync(partFiles[0], outputPath);
				} else {
					// Concat the parts
					const partsConcatPath = outputPath + '.parts.txt';
					fs.writeFileSync(partsConcatPath, partFiles.map((f) => ffmpegConcatEscape(f)).join('\n'));
					try {
						const concatArgs = [
							'-f', 'concat', '-safe', '0', '-i', partsConcatPath,
							'-c', 'copy',
							'-movflags', '+faststart',
							'-y', outputPath
						];
						await runFfmpeg(concatArgs, clipId);
					} finally {
						cleanupTempFiles(partsConcatPath);
					}
				}
			} catch (err) {
				// Smart cut failed — fall back to full encode
				console.warn(`[clip-encoder] ${clipId}: smart cut failed, falling back to full encode:`, err);
				cleanupTempFiles(...tempFiles);
				await fullEncode(clipId, concatPath, trimStart, dur, outputPath, useNvenc);
			} finally {
				cleanupTempFiles(...tempFiles);
			}
		} else {
			// Edge-only / short clip — full re-encode
			await fullEncode(clipId, concatPath, trimStart, dur, outputPath, useNvenc);
		}

		// Clean up concat file
		cleanupTempFiles(concatPath);

		encodeStatus.set(clipId, { status: 'ready', outputPath });
		broadcastClipEncodeStatus(clipId, 'ready');
		console.log(`[clip-encoder] Encoded clip ${clipId} → ${outputPath}`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		encodeStatus.set(clipId, { status: 'error', error: message });
		broadcastClipEncodeStatus(clipId, 'error', message);
		console.error(`[clip-encoder] Failed to encode clip ${clipId}:`, message);

		cleanupTempFiles(outputPath, outputPath + '.concat.txt');
	} finally {
		activeEncodes.delete(clipId);
		processQueue();
	}
}

async function fullEncode(
	clipId: string,
	concatPath: string,
	trimStart: number,
	dur: number,
	outputPath: string,
	useNvenc: boolean
): Promise<void> {
	const args = buildEncodeArgs({
		concatPath, seekStart: trimStart, duration: dur,
		outputPath, useNvenc
	});

	try {
		await runFfmpeg(args, clipId);
	} catch (err) {
		if (useNvenc) {
			console.error(`[clip-encoder] NVENC failed for ${clipId}, retrying with libx264`);
			const fallbackArgs = buildEncodeArgs({
				concatPath, seekStart: trimStart, duration: dur,
				outputPath, useNvenc: false
			});
			await runFfmpeg(fallbackArgs, clipId);
		} else {
			throw err;
		}
	}
}

// --- Shared helpers (also used by exporter.ts fallback) ---

export interface SegmentInfo {
	file: string;
	startTime: number;
	duration: number;
}

/**
 * Parse an HLS playlist and return segments covering [localStart, localEnd].
 */
export function parseRelevantSegments(
	playlistPath: string,
	recordingDir: string,
	localStart: number,
	localEnd: number
): SegmentInfo[] {
	const content = fs.readFileSync(playlistPath, 'utf-8');
	const lines = content.split('\n');
	let segTime = 0;
	const segments: SegmentInfo[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.startsWith('#EXTINF:')) {
			const segDur = parseFloat(line.split(':')[1].replace(',', ''));
			const nextLine = lines[i + 1]?.trim();
			if (nextLine && !nextLine.startsWith('#')) {
				const segEnd = segTime + segDur;
				if (segEnd > localStart && segTime < localEnd) {
					segments.push({
						file: path.join(recordingDir, nextLine),
						startTime: segTime,
						duration: segDur
					});
				}
				segTime = segEnd;
			}
		}
	}
	return segments;
}

/**
 * Escape a file path for use in an ffmpeg concat demuxer list file.
 */
export function ffmpegConcatEscape(filePath: string): string {
	const escaped = filePath.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
	return `file '${escaped}'`;
}

/**
 * Extract a single JPEG frame from an HLS recording at a given local timestamp.
 * Returns the raw JPEG bytes as a Buffer.
 */
export async function extractFrame(recordingDir: string, localTimestamp: number): Promise<Buffer> {
	const playlistPath = path.join(recordingDir, 'playlist.m3u8');
	const segments = parseRelevantSegments(playlistPath, recordingDir, localTimestamp, localTimestamp + 0.1);
	if (segments.length === 0) {
		throw new Error(`No segments found at timestamp ${localTimestamp}`);
	}

	const concatPath = path.join(recordingDir, `.frame-${Date.now()}.concat.txt`);
	try {
		const concatContent = segments.map((s) => ffmpegConcatEscape(s.file)).join('\n');
		fs.writeFileSync(concatPath, concatContent);

		const seekPos = Math.max(0, localTimestamp - segments[0].startTime);
		const proc = Bun.spawn(
			[
				'ffmpeg',
				'-f',
				'concat',
				'-safe',
				'0',
				'-i',
				concatPath,
				'-ss',
				seekPos.toFixed(3),
				'-frames:v',
				'1',
				'-f',
				'image2pipe',
				'-c:v',
				'mjpeg',
				'-q:v',
				'3',
				'pipe:1'
			],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);

		const [stdoutBuf, stderrText, exitCode] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).text(),
			proc.exited
		]);

		if (exitCode !== 0) {
			throw new Error(`ffmpeg failed (code ${exitCode}): ${stderrText.slice(-500)}`);
		}

		const buffer = Buffer.from(stdoutBuf);
		if (buffer.length === 0) {
			throw new Error('ffmpeg produced no output — timestamp may be beyond recording duration');
		}

		return buffer;
	} finally {
		try {
			fs.unlinkSync(concatPath);
		} catch {
			/* ok */
		}
	}
}
