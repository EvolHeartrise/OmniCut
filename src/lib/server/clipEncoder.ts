/**
 * Clip encoding queue module.
 * Encodes clip regions to MP4 eagerly (on create/update) so exports can
 * concat pre-encoded files near-instantly with `-c copy`.
 *
 * Sequential FIFO queue — one FFmpeg encode at a time to avoid GPU contention.
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
let activeEncode: { clipId: string; proc: Subprocess } | null = null;

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

// --- Public API ---

/**
 * Enqueue a clip for encoding. If already queued/encoding, invalidates and re-queues.
 */
export function enqueueClipEncode(clipId: string): void {
	// If already in queue (pending), remove the old entry so we re-queue at the end
	const idx = queue.indexOf(clipId);
	if (idx !== -1) queue.splice(idx, 1);

	// If actively encoding this clip, kill it — it'll be re-queued
	if (activeEncode?.clipId === clipId) {
		activeEncode.proc.kill();
		activeEncode = null;
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
	if (activeEncode?.clipId === clipId) {
		activeEncode.proc.kill();
		activeEncode = null;
		// Kick the queue forward
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
 * Kill the active encode process on shutdown.
 */
export function shutdownEncoder(): void {
	if (activeEncode) {
		activeEncode.proc.kill();
		activeEncode = null;
	}
	queue.length = 0;
}

// --- Internal ---

function processQueue(): void {
	if (activeEncode || queue.length === 0) return;
	const clipId = queue.shift()!;
	encodeClip(clipId);
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

		// Detect encoder
		const useNvenc = await detectNvenc();
		const encodeArgs = useNvenc
			? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18']
			: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'];

		const args = [
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			concatPath,
			'-ss',
			trimStart.toFixed(3),
			'-t',
			dur.toFixed(3),
			'-map',
			'0:v:0',
			'-map',
			'0:a:0',
			'-vf',
			'format=yuv420p',
			...encodeArgs,
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			'-movflags',
			'+faststart',
			'-y',
			outputPath
		];

		let success = false;
		try {
			const proc = Bun.spawn(['ffmpeg', ...args], {
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe'
			});
			activeEncode = { clipId, proc };

			const stderrText = await new Response(proc.stderr).text();
			const code = await proc.exited;
			if (code !== 0) throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-500)}`);
			success = true;
		} catch (err) {
			// NVENC failure — retry with libx264
			if (useNvenc) {
				console.error(`[clip-encoder] NVENC failed for ${clipId}, retrying with libx264`);
				const fallbackArgs = [
					'-f',
					'concat',
					'-safe',
					'0',
					'-i',
					concatPath,
					'-ss',
					trimStart.toFixed(3),
					'-t',
					dur.toFixed(3),
					'-map',
					'0:v:0',
					'-map',
					'0:a:0',
					'-vf',
					'format=yuv420p',
					'-c:v',
					'libx264',
					'-preset',
					'ultrafast',
					'-crf',
					'18',
					'-c:a',
					'aac',
					'-b:a',
					'192k',
					'-movflags',
					'+faststart',
					'-y',
					outputPath
				];
				const proc = Bun.spawn(['ffmpeg', ...fallbackArgs], {
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe'
				});
				activeEncode = { clipId, proc };

				const stderrText = await new Response(proc.stderr).text();
				const code = await proc.exited;
				if (code !== 0) throw new Error(`ffmpeg fallback failed (code ${code}): ${stderrText.slice(-500)}`);
				success = true;
			} else {
				throw err;
			}
		}

		// Clean up concat file
		try {
			fs.unlinkSync(concatPath);
		} catch {
			/* ok */
		}

		if (success) {
			encodeStatus.set(clipId, { status: 'ready', outputPath });
			broadcastClipEncodeStatus(clipId, 'ready');
			console.log(`[clip-encoder] Encoded clip ${clipId} → ${outputPath}`);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		encodeStatus.set(clipId, { status: 'error', error: message });
		broadcastClipEncodeStatus(clipId, 'error', message);
		console.error(`[clip-encoder] Failed to encode clip ${clipId}:`, message);

		// Clean up partial output
		try {
			fs.unlinkSync(outputPath);
		} catch {
			/* ok */
		}
		try {
			fs.unlinkSync(outputPath + '.concat.txt');
		} catch {
			/* ok */
		}
	} finally {
		activeEncode = null;
		processQueue();
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
