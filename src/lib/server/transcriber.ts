import * as path from 'node:path';
import * as fs from 'node:fs';

const BATCH_SIZE = 3; // segments per batch (~6 seconds at 2s/segment)
const POLL_INTERVAL = 3000; // check for new segments every 3s
const SEGMENT_DURATION = 2; // seconds per HLS segment (matches -hls_time 2)

// --- Python worker process (shared across all streams) ---

interface WorkerProc {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stdin: { write(data: string): number };
	exited: Promise<number>;
	kill(): void;
}
let workerProc: WorkerProc | null = null;
let workerReady = false;
let workerFailed = false;

interface QueueItem {
	wavPath: string;
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

const requestQueue: QueueItem[] = [];
let currentResolve: ((text: string) => void) | null = null;
let processing = false;

function ensureWorker(): boolean {
	if (workerFailed) return false;
	if (workerReady) return true;
	if (workerProc) return false; // still starting

	const scriptPath = path.join(process.cwd(), 'scripts', 'transcribe_worker.py');
	if (!fs.existsSync(scriptPath)) {
		console.warn('[transcriber] scripts/transcribe_worker.py not found, transcription disabled');
		workerFailed = true;
		return false;
	}

	try {
		const proc = Bun.spawn(['python', scriptPath], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe'
		});
		workerProc = proc as unknown as WorkerProc;

		// Read stdout line-by-line for JSON responses
		(async () => {
			const reader = workerProc!.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					let newlineIdx: number;
					while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
						const line = buffer.slice(0, newlineIdx).trim();
						buffer = buffer.slice(newlineIdx + 1);

						if (!line) continue;
						try {
							const data = JSON.parse(line);
							if (data.ready) {
								console.log('[transcriber] Model loaded, ready for transcription');
								workerReady = true;
								processQueue();
								continue;
							}
							if (data.error && !workerReady) {
								console.error(`[transcriber] Worker error: ${data.error}`);
								workerFailed = true;
								workerProc?.kill();
								workerProc = null;
								return;
							}
							// Transcription response
							if (currentResolve) {
								const resolve = currentResolve;
								currentResolve = null;
								processing = false;
								resolve(data.text || '');
								processQueue();
							}
						} catch {
							// ignore malformed lines
						}
					}
				}
			} catch { /* stream closed */ }
		})();

		// Log stderr
		(async () => {
			const reader = workerProc!.stderr.getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const msg = decoder.decode(value).trim();
					if (msg) console.error(`[transcriber] ${msg}`);
				}
			} catch { /* stream closed */ }
		})();

		// Handle worker exit
		workerProc.exited.then((code) => {
			console.warn(`[transcriber] Worker exited with code ${code}`);
			workerProc = null;
			workerReady = false;
			// Reject any pending request
			if (currentResolve) {
				currentResolve('');
				currentResolve = null;
				processing = false;
			}
		});

		return false; // not ready yet, will be after "ready" message
	} catch (err) {
		console.warn('[transcriber] Failed to spawn Python worker:', err);
		workerFailed = true;
		return false;
	}
}

function processQueue() {
	if (processing || requestQueue.length === 0 || !workerReady || !workerProc) return;
	processing = true;
	const req = requestQueue.shift()!;
	currentResolve = req.resolve;
	workerProc.stdin.write(req.wavPath + '\n');
}

function transcribeAudio(wavPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!ensureWorker() && !workerProc) {
			resolve('');
			return;
		}
		requestQueue.push({ wavPath, resolve, reject });
		processQueue();
	});
}

// --- Audio extraction (ffmpeg via Bun.spawn) ---

async function extractAudio(recordingDir: string, segmentFiles: string[]): Promise<string | null> {
	const listPath = path.join(recordingDir, '_concat.txt');
	const wavPath = path.join(recordingDir, '_transcribe_' + Date.now() + '.wav');

	// Write concat file list (relative filenames, ffmpeg runs with cwd=recordingDir)
	const listContent = segmentFiles.map((s) => `file '${s}'`).join('\n');
	fs.writeFileSync(listPath, listContent);

	const proc = Bun.spawn(
		['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath],
		{
			cwd: recordingDir,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe'
		}
	);

	const code = await proc.exited;

	try {
		fs.unlinkSync(listPath);
	} catch {}

	if (code !== 0) {
		return null;
	}
	return wavPath;
}

// --- Per-stream transcription tracking ---

/** Build the expected filename for a segment index. */
function segmentFilename(index: number): string {
	return `seg${index.toString().padStart(6, '0')}.ts`;
}

export type TranscriptionCallback = (
	streamId: string,
	text: string,
	startTime: number,
	endTime: number
) => void;

interface StreamTracker {
	recordingDir: string;
	lastProcessedIndex: number;
	interval: ReturnType<typeof setInterval>;
	callback: TranscriptionCallback;
	active: boolean;
}

const streamTrackers = new Map<string, StreamTracker>();

async function checkForNewSegments(streamId: string) {
	const tracker = streamTrackers.get(streamId);
	if (!tracker || !tracker.active) return;
	if (workerFailed) return;

	// Ensure worker is started (non-blocking)
	ensureWorker();
	if (!workerReady) return; // model still loading

	// Probe for sequential segment files instead of listing the full directory.
	// Segments are named seg000000.ts, seg000001.ts, ... so we just check
	// if the next expected files exist.
	const startIdx = tracker.lastProcessedIndex + 1;
	const needed = BATCH_SIZE + 1; // need BATCH_SIZE for transcription + 1 buffer
	let availableCount = 0;

	for (let i = 0; i < needed; i++) {
		const segPath = path.join(tracker.recordingDir, segmentFilename(startIdx + i));
		try {
			await fs.promises.access(segPath);
			availableCount++;
		} catch {
			break;
		}
	}

	if (availableCount < needed) return;

	const batch: string[] = [];
	for (let i = 0; i < BATCH_SIZE; i++) {
		batch.push(segmentFilename(startIdx + i));
	}

	const wavPath = await extractAudio(tracker.recordingDir, batch);
	if (!wavPath) return;

	try {
		const text = await transcribeAudio(wavPath);
		if (text.trim()) {
			const startTime = startIdx * SEGMENT_DURATION;
			const endTime = (startIdx + batch.length) * SEGMENT_DURATION;
			tracker.callback(streamId, text.trim(), startTime, endTime);
		}
	} finally {
		try {
			fs.unlinkSync(wavPath);
		} catch {}
	}

	tracker.lastProcessedIndex = startIdx + batch.length - 1;
}

/**
 * Start transcription for a stream. Calls `onResult` with transcription text
 * as new segments are processed.
 */
export function startTranscription(
	streamId: string,
	recordingDir: string,
	onResult: TranscriptionCallback
): void {
	// Don't start if already tracking or worker is known to be broken
	if (streamTrackers.has(streamId)) return;
	if (workerFailed) return;

	// Kick off worker startup early
	ensureWorker();

	const tracker: StreamTracker = {
		recordingDir,
		lastProcessedIndex: -1,
		interval: setInterval(() => checkForNewSegments(streamId), POLL_INTERVAL),
		callback: onResult,
		active: true
	};

	streamTrackers.set(streamId, tracker);
	console.log(`[transcriber] Started transcription for stream ${streamId}`);
}

/**
 * Stop transcription for a stream.
 */
export function stopTranscription(streamId: string): void {
	const tracker = streamTrackers.get(streamId);
	if (!tracker) return;
	tracker.active = false;
	clearInterval(tracker.interval);
	streamTrackers.delete(streamId);
}

/**
 * Shut down the transcription worker process.
 */
export function shutdownTranscriber(): void {
	for (const [id] of streamTrackers) {
		stopTranscription(id);
	}
	if (workerProc) {
		workerProc.kill();
		workerProc = null;
		workerReady = false;
	}
}
