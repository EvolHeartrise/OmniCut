import * as path from 'node:path';
import * as fs from 'node:fs';

const BATCH_SIZE = 15; // segments per batch (~30 seconds at 2s/segment, Whisper's full context window)
const POLL_INTERVAL = 3000; // check for new segments every 3s
const SEGMENT_DURATION = 2; // seconds per HLS segment (matches -hls_time 2)
const POOL_SIZE = 3; // number of concurrent transcription workers

// --- Worker pool ---

interface WorkerProc {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	stdin: { write(data: string): number };
	exited: Promise<number>;
	kill(): void;
}

interface PoolWorker {
	proc: WorkerProc;
	ready: boolean;
	busy: boolean;
	id: number;
}

interface Sentence {
	text: string;
	start: number;
	end: number;
	partial?: boolean;
}

interface QueueItem {
	wavPath: string;
	language: string | null;
	task: string;
	resolve: (sentences: Sentence[]) => void;
	reject: (err: Error) => void;
}

let poolWorkers: PoolWorker[] = [];
let poolInitStarted = false;
let poolFailed = false;
let poolReadyCount = 0;

const requestQueue: QueueItem[] = [];

function getScriptPath(): string {
	return path.join(process.cwd(), 'scripts', 'transcribe_worker.py');
}

function spawnWorker(workerId: number): PoolWorker | null {
	const scriptPath = getScriptPath();
	if (!fs.existsSync(scriptPath)) {
		console.warn('[transcriber] scripts/transcribe_worker.py not found, transcription disabled');
		poolFailed = true;
		return null;
	}

	try {
		const proc = Bun.spawn(['python', scriptPath], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe'
		}) as unknown as WorkerProc;

		const worker: PoolWorker = {
			proc,
			ready: false,
			busy: false,
			id: workerId
		};

		// Read stdout line-by-line for JSON responses
		(async () => {
			const reader = proc.stdout.getReader();
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
								console.log(`[transcriber:w${workerId}] Model loaded, ready for transcription`);
								worker.ready = true;
								poolReadyCount++;
								processQueue();
								continue;
							}
							if (data.error && !worker.ready) {
								console.error(`[transcriber:w${workerId}] Worker error: ${data.error}`);
								removeWorker(worker);
								return;
							}
							// Transcription response — resolve the current item
							if (worker.busy && (worker as any)._currentResolve) {
								const resolve = (worker as any)._currentResolve as (sentences: Sentence[]) => void;
								(worker as any)._currentResolve = null;
								worker.busy = false;
								resolve(data.sentences || []);
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
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const msg = decoder.decode(value).trim();
					if (msg) console.error(`[transcriber:w${workerId}] ${msg}`);
				}
			} catch { /* stream closed */ }
		})();

		// Handle worker exit
		proc.exited.then((code) => {
			console.warn(`[transcriber:w${workerId}] Worker exited with code ${code}`);
			// Resolve any pending request with empty array
			if (worker.busy && (worker as any)._currentResolve) {
				const resolve = (worker as any)._currentResolve as (sentences: Sentence[]) => void;
				(worker as any)._currentResolve = null;
				worker.busy = false;
				resolve([]);
			}
			removeWorker(worker);
			// Try to respawn if the pool is still active
			if (!poolFailed && poolWorkers.length < POOL_SIZE) {
				const newWorker = spawnWorker(workerId);
				if (newWorker) {
					poolWorkers.push(newWorker);
				}
			}
		});

		return worker;
	} catch (err) {
		console.warn(`[transcriber:w${workerId}] Failed to spawn Python worker:`, err);
		return null;
	}
}

function removeWorker(worker: PoolWorker) {
	if (worker.ready) poolReadyCount--;
	worker.ready = false;
	const idx = poolWorkers.indexOf(worker);
	if (idx !== -1) poolWorkers.splice(idx, 1);
}

function ensurePool(): boolean {
	if (poolFailed) return false;
	if (poolReadyCount > 0) return true;
	if (poolInitStarted) return false; // still starting up

	poolInitStarted = true;

	const scriptPath = getScriptPath();
	if (!fs.existsSync(scriptPath)) {
		console.warn('[transcriber] scripts/transcribe_worker.py not found, transcription disabled');
		poolFailed = true;
		return false;
	}

	console.log(`[transcriber] Spawning worker pool (size=${POOL_SIZE})`);
	for (let i = 0; i < POOL_SIZE; i++) {
		const worker = spawnWorker(i);
		if (worker) {
			poolWorkers.push(worker);
		}
	}

	if (poolWorkers.length === 0) {
		poolFailed = true;
		return false;
	}

	return false; // not ready yet, workers are loading models
}

function processQueue() {
	if (requestQueue.length === 0) return;

	// Find an idle, ready worker
	const worker = poolWorkers.find((w) => w.ready && !w.busy);
	if (!worker) return;

	const req = requestQueue.shift()!;
	worker.busy = true;
	(worker as any)._currentResolve = req.resolve;
	const payload: Record<string, unknown> = { wav_path: req.wavPath, task: req.task };
	if (req.language) payload.language = req.language;
	worker.proc.stdin.write(JSON.stringify(payload) + '\n');

	// Process more items if there are more idle workers
	if (requestQueue.length > 0) {
		processQueue();
	}
}

function transcribeAudio(wavPath: string, language: string | null): Promise<Sentence[]> {
	const task = language && language !== 'en' ? 'translate' : 'transcribe';
	return new Promise((resolve, reject) => {
		if (!ensurePool() && poolWorkers.length === 0) {
			resolve([]);
			return;
		}
		requestQueue.push({ wavPath, language, task, resolve, reject });
		processQueue();
	});
}

// --- Audio extraction (ffmpeg via Bun.spawn) ---

async function extractAudio(recordingDir: string, segmentFiles: string[]): Promise<string | null> {
	const listPath = path.join(recordingDir, '_concat.txt');
	const wavPath = path.join(recordingDir, '_transcribe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.wav');

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
		console.warn(`[transcriber] Audio extraction failed (code ${code}) for ${recordingDir}`);
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
	language: string | null;
	lastProcessedIndex: number;
	interval: ReturnType<typeof setInterval>;
	callback: TranscriptionCallback;
	active: boolean;
	pendingPartial: { text: string; startTime: number; endTime: number } | null;
}

const streamTrackers = new Map<string, StreamTracker>();

async function checkForNewSegments(streamId: string) {
	const tracker = streamTrackers.get(streamId);
	if (!tracker || !tracker.active) return;
	if (poolFailed) return;

	// Ensure pool is started (non-blocking)
	ensurePool();
	if (poolReadyCount === 0) return; // model(s) still loading

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

	// Advance lastProcessedIndex immediately so concurrent polls don't double-process
	tracker.lastProcessedIndex = startIdx + batch.length - 1;

	const wavPath = await extractAudio(tracker.recordingDir, batch);
	if (!wavPath) return;

	try {
		const sentences = await transcribeAudio(wavPath, tracker.language);
		const batchOffset = startIdx * SEGMENT_DURATION;

		for (let i = 0; i < sentences.length; i++) {
			const s = sentences[i];
			let text = s.text;
			let startTime = batchOffset + s.start;
			const endTime = batchOffset + s.end;

			// Merge pending partial from previous batch into the first sentence
			if (i === 0 && tracker.pendingPartial) {
				text = tracker.pendingPartial.text + ' ' + text;
				startTime = tracker.pendingPartial.startTime;
				tracker.pendingPartial = null;
			}

			// Hold back partial (incomplete) sentences for merging with next batch
			if (s.partial) {
				tracker.pendingPartial = { text, startTime, endTime };
			} else {
				tracker.callback(streamId, text, startTime, endTime);
			}
		}

		// If no sentences came back, clear any stale partial
		if (sentences.length === 0 && tracker.pendingPartial) {
			tracker.callback(streamId, tracker.pendingPartial.text, tracker.pendingPartial.startTime, tracker.pendingPartial.endTime);
			tracker.pendingPartial = null;
		}
	} finally {
		try {
			fs.unlinkSync(wavPath);
		} catch {}
	}
}

/**
 * Start transcription for a stream. Calls `onResult` with transcription text
 * as new segments are processed.
 */
export function startTranscription(
	streamId: string,
	recordingDir: string,
	onResult: TranscriptionCallback,
	language?: string | null
): void {
	// Don't start if already tracking or worker pool is known to be broken
	if (streamTrackers.has(streamId)) return;
	if (poolFailed) return;

	// Kick off worker pool startup early
	ensurePool();

	const tracker: StreamTracker = {
		recordingDir,
		language: language ?? null,
		lastProcessedIndex: -1,
		interval: setInterval(() => checkForNewSegments(streamId), POLL_INTERVAL),
		callback: onResult,
		active: true,
		pendingPartial: null
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
	// Flush any pending partial sentence before stopping
	if (tracker.pendingPartial) {
		tracker.callback(streamId, tracker.pendingPartial.text, tracker.pendingPartial.startTime, tracker.pendingPartial.endTime);
		tracker.pendingPartial = null;
	}
	tracker.active = false;
	clearInterval(tracker.interval);
	streamTrackers.delete(streamId);
}

/**
 * Transcribe an entire finished recording in one pass.
 * Concatenates all segments into a single WAV and sends to Whisper,
 * which handles cross-window context continuity internally.
 */
export async function transcribeFullRecording(
	streamId: string,
	recordingDir: string,
	onResult: TranscriptionCallback,
	language?: string | null
): Promise<void> {
	// Enumerate all seg*.ts files, sort numerically
	const allFiles = fs.readdirSync(recordingDir);
	const segFiles = allFiles
		.filter((f) => /^seg\d+\.ts$/.test(f))
		.sort((a, b) => {
			const numA = parseInt(a.match(/\d+/)![0], 10);
			const numB = parseInt(b.match(/\d+/)![0], 10);
			return numA - numB;
		});

	if (segFiles.length === 0) {
		console.log(`[transcriber] No segments found in ${recordingDir}, skipping full transcription`);
		return;
	}

	console.log(`[transcriber] Starting full transcription for stream ${streamId} (${segFiles.length} segments)`);

	// Ensure worker pool is started; wait until at least one worker is ready
	ensurePool();
	while (poolReadyCount === 0 && !poolFailed) {
		await new Promise((r) => setTimeout(r, 500));
		ensurePool();
	}
	if (poolFailed) {
		console.warn(`[transcriber] Pool failed, cannot transcribe stream ${streamId}`);
		return;
	}

	const wavPath = await extractAudio(recordingDir, segFiles);
	if (!wavPath) return;

	try {
		const sentences = await transcribeAudio(wavPath, language ?? null);
		for (const s of sentences) {
			onResult(streamId, s.text, s.start, s.end);
		}
		console.log(`[transcriber] Full transcription complete for stream ${streamId}: ${sentences.length} sentences`);
	} finally {
		try {
			fs.unlinkSync(wavPath);
		} catch {}
	}
}

/**
 * Shut down all transcription workers.
 */
export function shutdownTranscriber(): void {
	for (const [id] of streamTrackers) {
		stopTranscription(id);
	}
	for (const worker of poolWorkers) {
		try {
			worker.proc.kill();
		} catch {}
	}
	poolWorkers = [];
	poolReadyCount = 0;
	poolInitStarted = false;
}
