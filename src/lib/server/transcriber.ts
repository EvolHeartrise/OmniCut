import * as path from 'node:path';
import * as fs from 'node:fs';

const BATCH_SIZE = 15; // segments per batch (~30 seconds at 2s/segment, Whisper's full context window)
const VOD_BATCH_SIZE = 3600; // segments per VOD batch (~2 hours at 2s/segment)
const POLL_INTERVAL = 3000; // check for new segments every 3s
const SEGMENT_DURATION = 2; // seconds per HLS segment (matches -hls_time 2)
const LIVE_POOL_SIZE = 2; // number of concurrent live transcription workers
const VOD_POOL_SIZE = 1; // number of concurrent VOD transcription workers
const MAX_RESPAWN_ATTEMPTS = 3; // max consecutive respawn attempts per worker slot
const RESPAWN_BACKOFF_MS = 5000; // delay between respawn attempts
const QUEUE_ITEM_TIMEOUT_MS = 120_000; // 2 minutes max wait per live transcription request
const VOD_QUEUE_ITEM_TIMEOUT_MS = 0; // no timeout for VOD (full recordings can take hours)
const POOL_READY_TIMEOUT_MS = 60_000; // 1 minute max wait for pool readiness

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

export interface WordTimestamp {
	word: string;
	start: number;
	end: number;
}

interface Sentence {
	text: string;
	start: number;
	end: number;
	partial?: boolean;
	words?: WordTimestamp[];
}

/** Remove consecutive duplicate/near-duplicate sentences (Whisper hallucination loops). */
function deduplicateSentences(sentences: Sentence[]): Sentence[] {
	if (sentences.length <= 1) return sentences;
	const result: Sentence[] = [sentences[0]];
	for (let i = 1; i < sentences.length; i++) {
		const prev = result[result.length - 1];
		const curr = sentences[i];
		// Skip if identical text and timestamps overlap or are adjacent (within 1s)
		if (curr.text.trim() === prev.text.trim() && curr.start < prev.end + 1) {
			continue;
		}
		result.push(curr);
	}
	return result;
}

interface QueueItem {
	wavPath: string;
	language: string | null;
	task: string;
	beamSize: number;
	resolve: (sentences: Sentence[]) => void;
	reject: (err: Error) => void;
}

interface Pool {
	workers: PoolWorker[];
	queue: QueueItem[];
	readyCount: number;
	initStarted: boolean;
	failed: boolean;
	size: number;
	label: string;
}

const livePool: Pool = {
	workers: [],
	queue: [],
	readyCount: 0,
	initStarted: false,
	failed: false,
	size: LIVE_POOL_SIZE,
	label: 'live'
};
const vodPool: Pool = {
	workers: [],
	queue: [],
	readyCount: 0,
	initStarted: false,
	failed: false,
	size: VOD_POOL_SIZE,
	label: 'vod'
};

// Map worker → pending resolve/reject callbacks
const workerResolvers = new Map<
	PoolWorker,
	{ resolve: (sentences: Sentence[]) => void; reject: (err: Error) => void }
>();

// Track consecutive respawn failures per worker slot to prevent infinite loops
const respawnAttempts = new Map<string, number>(); // key: `${pool.label}:${workerId}`

function getScriptPath(): string {
	return path.join(process.cwd(), 'scripts', 'transcribe_worker.py');
}

function spawnWorker(pool: Pool, workerId: number): PoolWorker | null {
	const scriptPath = getScriptPath();
	if (!fs.existsSync(scriptPath)) {
		console.warn(`[transcriber:${pool.label}] scripts/transcribe_worker.py not found, transcription disabled`);
		pool.failed = true;
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
								console.log(`[transcriber:${pool.label}:w${workerId}] Model loaded, ready for transcription`);
								worker.ready = true;
								pool.readyCount++;
								processQueue(pool);
								continue;
							}
							if (data.error && !worker.ready) {
								console.error(`[transcriber:${pool.label}:w${workerId}] Worker error: ${data.error}`);
								removeWorker(pool, worker);
								return;
							}
							// Transcription response — resolve the current item
							if (worker.busy && workerResolvers.has(worker)) {
								const { resolve } = workerResolvers.get(worker)!;
								workerResolvers.delete(worker);
								worker.busy = false;
								if (data.error) {
									console.warn(`[transcriber:${pool.label}:w${workerId}] Transcription error: ${data.error}`);
								}
								resolve(data.sentences || []);
								processQueue(pool);
							}
						} catch {
							// ignore malformed lines
						}
					}
				}
			} catch {
				/* stream closed */
			}
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
					if (msg) console.error(`[transcriber:${pool.label}:w${workerId}] ${msg}`);
				}
			} catch {
				/* stream closed */
			}
		})();

		// Handle worker exit with backoff to prevent infinite respawn loops
		proc.exited.then((code) => {
			console.warn(`[transcriber:${pool.label}:w${workerId}] Worker exited with code ${code}`);
			// Reject any pending request
			if (worker.busy && workerResolvers.has(worker)) {
				const { reject } = workerResolvers.get(worker)!;
				workerResolvers.delete(worker);
				worker.busy = false;
				reject(new Error(`Worker exited with code ${code}`));
			}
			const wasReady = worker.ready;
			removeWorker(pool, worker);

			// Try to respawn with backoff if the pool is still active
			if (!pool.failed && pool.workers.length < pool.size) {
				const slotKey = `${pool.label}:${workerId}`;
				// Reset counter if the worker was previously ready (healthy exit, not a startup crash)
				if (wasReady) {
					respawnAttempts.delete(slotKey);
				}
				const attempts = (respawnAttempts.get(slotKey) ?? 0) + 1;
				respawnAttempts.set(slotKey, attempts);

				if (attempts > MAX_RESPAWN_ATTEMPTS) {
					console.error(
						`[transcriber:${pool.label}:w${workerId}] Max respawn attempts (${MAX_RESPAWN_ATTEMPTS}) reached — giving up`
					);
					if (pool.workers.length === 0) {
						pool.failed = true;
					}
					return;
				}

				const delay = RESPAWN_BACKOFF_MS * attempts;
				console.log(
					`[transcriber:${pool.label}:w${workerId}] Respawning in ${delay}ms (attempt ${attempts}/${MAX_RESPAWN_ATTEMPTS})`
				);
				setTimeout(() => {
					if (pool.failed) return;
					const newWorker = spawnWorker(pool, workerId);
					if (newWorker) {
						pool.workers.push(newWorker);
					}
				}, delay);
			}
		});

		return worker;
	} catch (err) {
		console.warn(`[transcriber:${pool.label}:w${workerId}] Failed to spawn Python worker:`, err);
		return null;
	}
}

function removeWorker(pool: Pool, worker: PoolWorker) {
	if (worker.ready) pool.readyCount--;
	worker.ready = false;
	workerResolvers.delete(worker);
	const idx = pool.workers.indexOf(worker);
	if (idx !== -1) pool.workers.splice(idx, 1);

	// If the pool is now empty and failed, drain and reject all pending queue items
	if (pool.workers.length === 0 && pool.failed) {
		drainQueue(pool);
	}
}

/** Reject all pending items in the queue (e.g., when pool has failed permanently). */
function drainQueue(pool: Pool) {
	while (pool.queue.length > 0) {
		const item = pool.queue.shift()!;
		item.reject(new Error(`Transcription pool '${pool.label}' has failed — no workers available`));
	}
}

function ensurePool(pool: Pool): boolean {
	if (pool.failed) {
		drainQueue(pool);
		return false;
	}
	if (pool.readyCount > 0) return true;
	if (pool.initStarted) return false; // still starting up

	pool.initStarted = true;

	const scriptPath = getScriptPath();
	if (!fs.existsSync(scriptPath)) {
		console.warn(`[transcriber:${pool.label}] scripts/transcribe_worker.py not found, transcription disabled`);
		pool.failed = true;
		drainQueue(pool);
		return false;
	}

	console.log(`[transcriber] Spawning ${pool.label} worker pool (size=${pool.size})`);
	for (let i = 0; i < pool.size; i++) {
		const worker = spawnWorker(pool, i);
		if (worker) {
			pool.workers.push(worker);
		}
	}

	if (pool.workers.length === 0) {
		pool.failed = true;
		drainQueue(pool);
		return false;
	}

	return false; // not ready yet, workers are loading models
}

function processQueue(pool: Pool) {
	if (pool.queue.length === 0) return;

	// Find an idle, ready worker
	const worker = pool.workers.find((w) => w.ready && !w.busy);
	if (!worker) return;

	const req = pool.queue.shift()!;
	worker.busy = true;
	workerResolvers.set(worker, { resolve: req.resolve, reject: req.reject });
	const payload: Record<string, unknown> = { wav_path: req.wavPath, task: req.task, beam_size: req.beamSize };
	if (req.language) payload.language = req.language;
	worker.proc.stdin.write(JSON.stringify(payload) + '\n');

	// Process more items if there are more idle workers
	if (pool.queue.length > 0) {
		processQueue(pool);
	}
}

function transcribeAudio(
	pool: Pool,
	wavPath: string,
	language: string | null,
	beamSize: number = 1,
	timeoutMs: number = QUEUE_ITEM_TIMEOUT_MS
): Promise<Sentence[]> {
	const task = language && language !== 'en' ? 'translate' : 'transcribe';
	return new Promise((resolve, reject) => {
		if (!ensurePool(pool) && pool.workers.length === 0) {
			resolve([]);
			return;
		}

		// Timeout: reject if the request sits in the queue or is processing too long
		// A timeout of 0 means no timeout (for long-running VOD transcriptions)
		let settled = false;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						if (settled) return;
						settled = true;
						// Remove from queue if still pending
						const idx = pool.queue.findIndex((q) => q.resolve === wrappedResolve);
						if (idx !== -1) pool.queue.splice(idx, 1);
						reject(new Error(`Transcription timed out after ${timeoutMs / 1000}s`));
					}, timeoutMs)
				: null;

		const wrappedResolve = (sentences: Sentence[]) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(sentences);
		};
		const wrappedReject = (err: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(err);
		};

		pool.queue.push({ wavPath, language, task, beamSize, resolve: wrappedResolve, reject: wrappedReject });
		processQueue(pool);
	});
}

// --- Audio extraction (ffmpeg via Bun.spawn) ---

async function extractAudio(recordingDir: string, segmentFiles: string[]): Promise<string | null> {
	const listPath = path.join(recordingDir, '_concat.txt');
	const wavPath = path.join(
		recordingDir,
		'_transcribe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.wav'
	);

	// Write concat file list (relative filenames, ffmpeg runs with cwd=recordingDir)
	const listContent = segmentFiles.map((s) => `file '${s}'`).join('\n');
	fs.writeFileSync(listPath, listContent);

	const proc = Bun.spawn(
		[
			'ffmpeg',
			'-y',
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listPath,
			'-vn',
			'-ar',
			'16000',
			'-ac',
			'1',
			'-f',
			'wav',
			wavPath
		],
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
	endTime: number,
	words?: WordTimestamp[]
) => void;

interface StreamTracker {
	recordingDir: string;
	language: string | null;
	lastProcessedIndex: number;
	interval: ReturnType<typeof setInterval>;
	callback: TranscriptionCallback;
	active: boolean;
	pendingPartial: { text: string; startTime: number; endTime: number; words?: WordTimestamp[] } | null;
}

const streamTrackers = new Map<string, StreamTracker>();

async function checkForNewSegments(streamId: string) {
	const tracker = streamTrackers.get(streamId);
	if (!tracker || !tracker.active) return;
	if (livePool.failed) return;

	// Ensure pool is started (non-blocking)
	ensurePool(livePool);
	if (livePool.readyCount === 0) return; // model(s) still loading

	// Probe for sequential segment files in parallel instead of one-by-one.
	// Segments are named seg000000.ts, seg000001.ts, ... so we check
	// if the next expected files exist concurrently.
	const startIdx = tracker.lastProcessedIndex + 1;
	const needed = BATCH_SIZE + 1; // need BATCH_SIZE for transcription + 1 buffer

	const probes = Array.from({ length: needed }, (_, i) =>
		fs.promises.access(path.join(tracker.recordingDir, segmentFilename(startIdx + i))).then(
			() => true,
			() => false
		)
	);
	const results = await Promise.all(probes);
	// Count consecutive available segments from the start
	let availableCount = 0;
	for (const ok of results) {
		if (!ok) break;
		availableCount++;
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
		let sentences: Sentence[];
		try {
			sentences = deduplicateSentences(await transcribeAudio(livePool, wavPath, tracker.language));
		} catch (err) {
			console.warn(
				`[transcriber:live] Transcription failed for stream ${streamId} batch at index ${startIdx}: ${err instanceof Error ? err.message : err}`
			);
			return;
		}
		const batchOffset = startIdx * SEGMENT_DURATION;

		for (let i = 0; i < sentences.length; i++) {
			const s = sentences[i];
			let text = s.text;
			let startTime = batchOffset + s.start;
			const endTime = batchOffset + s.end;
			let words = s.words?.map((w) => ({ ...w, start: batchOffset + w.start, end: batchOffset + w.end }));

			// Merge pending partial from previous batch into the first sentence
			if (i === 0 && tracker.pendingPartial) {
				text = tracker.pendingPartial.text + ' ' + text;
				startTime = tracker.pendingPartial.startTime;
				words = [...(tracker.pendingPartial.words ?? []), ...(words ?? [])];
				tracker.pendingPartial = null;
			}

			// Hold back partial (incomplete) sentences for merging with next batch
			if (s.partial) {
				tracker.pendingPartial = { text, startTime, endTime, words };
			} else {
				tracker.callback(streamId, text, startTime, endTime, words);
			}
		}

		// If no sentences came back, clear any stale partial
		if (sentences.length === 0 && tracker.pendingPartial) {
			tracker.callback(
				streamId,
				tracker.pendingPartial.text,
				tracker.pendingPartial.startTime,
				tracker.pendingPartial.endTime,
				tracker.pendingPartial.words
			);
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
	if (livePool.failed) return;

	// Kick off worker pool startup early
	ensurePool(livePool);

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
		tracker.callback(
			streamId,
			tracker.pendingPartial.text,
			tracker.pendingPartial.startTime,
			tracker.pendingPartial.endTime,
			tracker.pendingPartial.words
		);
		tracker.pendingPartial = null;
	}
	tracker.active = false;
	clearInterval(tracker.interval);
	streamTrackers.delete(streamId);
}

// --- VOD job queue ---

interface VodJob {
	streamId: string;
	recordingDir: string;
	onResult: TranscriptionCallback;
	language: string | null;
	resolve: () => void;
}

const vodJobQueue: VodJob[] = [];
let vodJobActive = false;

async function processVodJobQueue() {
	if (vodJobActive || vodJobQueue.length === 0) return;
	vodJobActive = true;
	const job = vodJobQueue.shift()!;
	try {
		await doFullTranscription(job);
	} finally {
		job.resolve();
		vodJobActive = false;
		processVodJobQueue();
	}
}

async function doFullTranscription(job: VodJob): Promise<void> {
	const { streamId, recordingDir, onResult, language } = job;

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
		console.log(`[transcriber:vod] No segments found in ${recordingDir}, skipping full transcription`);
		return;
	}

	const totalBatches = Math.ceil(segFiles.length / VOD_BATCH_SIZE);
	console.log(
		`[transcriber:vod] Starting full transcription for stream ${streamId} (${segFiles.length} segments, ${totalBatches} batches)`
	);

	// Ensure VOD worker pool is started; wait until at least one worker is ready (with timeout)
	ensurePool(vodPool);
	const poolWaitStart = Date.now();
	while (vodPool.readyCount === 0 && !vodPool.failed) {
		if (Date.now() - poolWaitStart > POOL_READY_TIMEOUT_MS) {
			console.error(
				`[transcriber:vod] Pool not ready after ${POOL_READY_TIMEOUT_MS / 1000}s, giving up on stream ${streamId}`
			);
			return;
		}
		await new Promise((r) => setTimeout(r, 500));
		ensurePool(vodPool);
	}
	if (vodPool.failed) {
		console.warn(`[transcriber:vod] Pool failed, cannot transcribe stream ${streamId}`);
		return;
	}

	// Process in batches to avoid creating enormous WAV files (a 35-hour recording
	// would be ~3.76 GB as a single WAV, which can fail in ffmpeg or Whisper)
	let totalSentences = 0;
	let totalDuplicates = 0;
	let pendingPartial: { text: string; startTime: number; endTime: number; words?: WordTimestamp[] } | null =
		null;

	for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
		const batchStart = batchIdx * VOD_BATCH_SIZE;
		const batchEnd = Math.min(batchStart + VOD_BATCH_SIZE, segFiles.length);
		const batchFiles = segFiles.slice(batchStart, batchEnd);

		// Compute time offset from the first segment's index
		const firstSegIndex = parseInt(batchFiles[0].match(/\d+/)![0], 10);
		const batchOffset = firstSegIndex * SEGMENT_DURATION;

		const wavPath = await extractAudio(recordingDir, batchFiles);
		if (!wavPath) {
			console.warn(
				`[transcriber:vod] Audio extraction failed for batch ${batchIdx + 1}/${totalBatches}, skipping`
			);
			continue;
		}

		try {
			const raw = await transcribeAudio(vodPool, wavPath, language, 5, VOD_QUEUE_ITEM_TIMEOUT_MS);
			const sentences = deduplicateSentences(raw);
			totalDuplicates += raw.length - sentences.length;

			for (let i = 0; i < sentences.length; i++) {
				const s = sentences[i];
				let text = s.text;
				let startTime = batchOffset + s.start;
				const endTime = batchOffset + s.end;
				let words = s.words?.map((w) => ({
					...w,
					start: batchOffset + w.start,
					end: batchOffset + w.end
				}));

				// Merge pending partial from previous batch into the first sentence
				if (i === 0 && pendingPartial) {
					text = pendingPartial.text + ' ' + text;
					startTime = pendingPartial.startTime;
					words = [...(pendingPartial.words ?? []), ...(words ?? [])];
					pendingPartial = null;
				}

				// Hold back partial (incomplete) sentences for merging with next batch
				if (s.partial) {
					pendingPartial = { text, startTime, endTime, words };
				} else {
					onResult(streamId, text, startTime, endTime, words);
					totalSentences++;
				}
			}

			// If no sentences came back, clear any stale partial
			if (sentences.length === 0 && pendingPartial) {
				onResult(
					streamId,
					pendingPartial.text,
					pendingPartial.startTime,
					pendingPartial.endTime,
					pendingPartial.words
				);
				totalSentences++;
				pendingPartial = null;
			}

			if ((batchIdx + 1) % 10 === 0 || batchIdx === totalBatches - 1) {
				console.log(
					`[transcriber:vod] Stream ${streamId}: batch ${batchIdx + 1}/${totalBatches} (${totalSentences} sentences so far)`
				);
			}
		} catch (err) {
			console.warn(
				`[transcriber:vod] Batch ${batchIdx + 1}/${totalBatches} failed for stream ${streamId}: ${err instanceof Error ? err.message : err}`
			);
		} finally {
			try {
				fs.unlinkSync(wavPath);
			} catch {}
		}
	}

	// Flush any remaining partial sentence
	if (pendingPartial) {
		onResult(
			streamId,
			pendingPartial.text,
			pendingPartial.startTime,
			pendingPartial.endTime,
			pendingPartial.words
		);
		totalSentences++;
	}

	console.log(
		`[transcriber:vod] Full transcription complete for stream ${streamId}: ${totalSentences} sentences${totalDuplicates > 0 ? ` (${totalDuplicates} duplicates removed)` : ''}`
	);
}

/**
 * Transcribe an entire finished recording in one pass.
 * Concatenates all segments into a single WAV and sends to Whisper,
 * which handles cross-window context continuity internally.
 * VOD jobs are serialized so only one runs at a time.
 */
export function transcribeFullRecording(
	streamId: string,
	recordingDir: string,
	onResult: TranscriptionCallback,
	language?: string | null
): Promise<void> {
	return new Promise<void>((resolve) => {
		vodJobQueue.push({ streamId, recordingDir, onResult, language: language ?? null, resolve });
		const pending = vodJobQueue.length;
		if (pending > 1) {
			console.log(`[transcriber:vod] Queued transcription for ${streamId} (${pending - 1} ahead)`);
		}
		processVodJobQueue();
	});
}

/**
 * Shut down all transcription workers.
 */
export function shutdownTranscriber(): void {
	// Stop live trackers
	for (const [id] of streamTrackers) {
		stopTranscription(id);
	}
	// Kill both pools
	for (const pool of [livePool, vodPool]) {
		for (const w of pool.workers) {
			try {
				w.proc.kill();
			} catch {}
		}
		pool.workers = [];
		pool.readyCount = 0;
		pool.initStarted = false;
	}
	workerResolvers.clear();
}
