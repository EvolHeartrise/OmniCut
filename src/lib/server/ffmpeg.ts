/**
 * Shared FFmpeg spawn + await helpers.
 * Centralizes the pattern of running ffmpeg, collecting stderr, and throwing on failure.
 */

/** Spawn an ffmpeg process with standard stdio config. */
export function spawnFfmpeg(args: string[]) {
	return Bun.spawn(['ffmpeg', ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
}

/** Await an already-spawned ffmpeg process; throws with stderr tail on non-zero exit. */
export async function awaitFfmpeg(proc: ReturnType<typeof spawnFfmpeg>, maxStderrChars = 500): Promise<void> {
	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`ffmpeg failed (code ${code}): ${stderrText.slice(-maxStderrChars)}`);
}

/** Spawn and await ffmpeg in one call. */
export async function runFfmpeg(args: string[], maxStderrChars = 500): Promise<void> {
	await awaitFfmpeg(spawnFfmpeg(args), maxStderrChars);
}
