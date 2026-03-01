/**
 * Shared FFmpeg spawn + await helpers.
 * Centralizes the pattern of running ffmpeg, collecting stderr, and throwing on failure.
 */

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
