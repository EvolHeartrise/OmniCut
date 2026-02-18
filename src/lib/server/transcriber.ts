import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import * as fs from 'node:fs';

const BATCH_SIZE = 3; // segments per batch (~6 seconds at 2s/segment)
const POLL_INTERVAL = 3000; // check for new segments every 3s
const SEGMENT_DURATION = 2; // seconds per HLS segment (matches -hls_time 2)

// --- Python worker process (shared across all streams) ---

let workerProc: ReturnType<typeof spawn> | null = null;
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
		workerProc = spawn('python', [scriptPath], {
			stdio: ['pipe', 'pipe', 'pipe']
		});

		const rl = createInterface({ input: workerProc.stdout! });
		rl.on('line', (line) => {
			try {
				const data = JSON.parse(line);
				if (data.ready) {
					console.log('[transcriber] Model loaded, ready for transcription');
					workerReady = true;
					processQueue();
					return;
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
		});

		workerProc.stderr?.on('data', (data: Buffer) => {
			const msg = data.toString().trim();
			if (msg) console.error(`[transcriber] ${msg}`);
		});

		workerProc.on('close', (code) => {
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
	workerProc.stdin!.write(req.wavPath + '\n');
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

// --- Audio extraction (ffmpeg) ---

function extractAudio(recordingDir: string, segmentFiles: string[]): Promise<string | null> {
	const listPath = path.join(recordingDir, '_concat.txt');
	const wavPath = path.join(recordingDir, '_transcribe_' + Date.now() + '.wav');

	// Write concat file list (relative filenames, ffmpeg runs with cwd=recordingDir)
	const listContent = segmentFiles.map((s) => `file '${s}'`).join('\n');
	fs.writeFileSync(listPath, listContent);

	return new Promise((resolve) => {
		execFile(
			'ffmpeg',
			['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath],
			{ cwd: recordingDir },
			(err) => {
				try {
					fs.unlinkSync(listPath);
				} catch {}
				if (err) {
					resolve(null);
				} else {
					resolve(wavPath);
				}
			}
		);
	});
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
