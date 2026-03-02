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

/**
 * Spawn FFmpeg with stdin set to 'pipe', allowing raw data to be streamed
 * into an input (typically `-i pipe:0`).
 *
 * The caller is responsible for writing to stdin, calling stdin.end(),
 * then awaiting waitForExit().
 */
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
