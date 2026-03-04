/**
 * Shared FFmpeg spawn + await helpers.
 * Centralizes the pattern of running ffmpeg, collecting stderr, and throwing on failure.
 */

import type { FrameSink } from './chatEffectRenderer.js';

/** Spawn and await ffmpeg in one call. */
export async function runFfmpeg(args: string[], maxStderrChars = 500): Promise<void> {
	const proc = Bun.spawn(['ffmpeg', ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-maxStderrChars)}`);
}

/** Handle for an FFmpeg process that accepts piped stdin data via ReadableStream. */
export interface FfmpegPipeHandle {
	/** FrameSink backed by a TransformStream writer — avoids Bun FileSink EPIPE crashes. */
	sink: FrameSink;
	/** Close the input stream (signals EOF to FFmpeg). Safe even if pipe is already broken. */
	closeStdin(): Promise<void>;
	/** Await FFmpeg exit. Throws on non-zero exit with stderr tail. */
	waitForExit(maxStderrChars?: number): Promise<void>;
}

/** Spawn ffmpeg, capture stdout as a Buffer. Throws on non-zero exit. */
export async function runFfmpegBuffer(args: string[], maxStderrChars = 500): Promise<Buffer> {
	const proc = Bun.spawn(['ffmpeg', ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdoutBuf, stderrText, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	if (code !== 0) throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-maxStderrChars)}`);
	return Buffer.from(stdoutBuf);
}

/** Escape a file path for use in an ffmpeg concat demuxer list file. */
export function ffmpegConcatEscape(filePath: string): string {
	const escaped = filePath.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
	return `file '${escaped}'`;
}

export interface ProbeResult {
	width: number;
	height: number;
	fps: number;
	/** Format-level duration (seconds). */
	duration: number;
	/** Video stream duration (seconds) — avoids AAC encoder priming inflation. */
	videoDuration: number;
}

/** Probe a media file for dimensions, framerate, and duration in a single ffprobe call. */
export async function probeMedia(filePath: string): Promise<ProbeResult> {
	const zero: ProbeResult = { width: 0, height: 0, fps: 0, duration: 0, videoDuration: 0 };
	try {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
				'-show_entries', 'stream=width,height,r_frame_rate,duration',
				'-show_entries', 'format=duration',
				'-of', 'json', filePath],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return zero;

		const data = JSON.parse(stdout);
		const stream = data.streams?.[0];
		const width = parseInt(stream?.width, 10) || 0;
		const height = parseInt(stream?.height, 10) || 0;
		let fps = 0;
		if (stream?.r_frame_rate) {
			const [num, den] = stream.r_frame_rate.split('/').map(Number);
			if (den > 0) fps = Math.round(num / den);
		}
		const parseDur = (v: unknown) => { const n = parseFloat(v as string); return isFinite(n) && n > 0 ? n : 0; };
		const videoDuration = parseDur(stream?.duration);
		const duration = parseDur(data.format?.duration);

		return { width, height, fps, duration, videoDuration };
	} catch {
		return zero;
	}
}

export function spawnFfmpegWithPipe(args: string[]): FfmpegPipeHandle {
	// Use a TransformStream instead of Bun's FileSink ("pipe") to avoid
	// uncatchable async EPIPE crashes. When FFmpeg closes its stdin early
	// (e.g. after receiving enough frames for -t duration), FileSink
	// triggers a process-level EPIPE that can't be caught with try/catch.
	// ReadableStream-based stdin handles pipe cleanup internally.
	const { readable, writable } = new TransformStream<Uint8Array>();
	const writer = writable.getWriter();

	const proc = Bun.spawn(['ffmpeg', ...args], {
		stdin: readable,
		stdout: 'pipe',
		stderr: 'pipe'
	});

	// Start consuming stderr immediately to prevent FFmpeg from blocking on a full buffer
	const stderrPromise = new Response(proc.stderr).text();

	let broken = false;
	const sink: FrameSink = {
		write(buf: Buffer) {
			// Buffer for the next flush — can't await here (sync interface)
			if (!broken) sinkPending = buf;
		},
		async flush() {
			if (broken || !sinkPending) return;
			try {
				await writer.write(new Uint8Array(sinkPending));
			} catch {
				broken = true;
			}
			sinkPending = null;
		}
	};
	let sinkPending: Buffer | null = null;

	return {
		sink,
		async closeStdin() {
			try { await writer.close(); } catch { /* pipe may already be closed */ }
		},
		async waitForExit(maxStderrChars = 500): Promise<void> {
			const stderrText = await stderrPromise;
			const code = await proc.exited;
			if (code !== 0) {
				throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-maxStderrChars)}`);
			}
		}
	};
}
