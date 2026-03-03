/**
 * Shared FFmpeg spawn + await helpers.
 * Centralizes the pattern of running ffmpeg, collecting stderr, and throwing on failure.
 */

import type { FileSink } from 'bun';

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

/** Handle for an FFmpeg process that accepts piped stdin data. */
export interface FfmpegPipeHandle {
	/** The writable stdin pipe. Write raw data here, flush for backpressure, end when done. */
	stdin: FileSink;
	/** Await FFmpeg exit. Caller must close stdin first or FFmpeg will hang. */
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
	const proc = Bun.spawn(['ffmpeg', ...args], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe'
	});

	// Start consuming stderr immediately to prevent FFmpeg from blocking on a full buffer
	const stderrPromise = new Response(proc.stderr).text();

	return {
		stdin: proc.stdin,
		async waitForExit(maxStderrChars = 500): Promise<void> {
			const stderrText = await stderrPromise;
			const code = await proc.exited;
			if (code !== 0) {
				throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-maxStderrChars)}`);
			}
		}
	};
}
