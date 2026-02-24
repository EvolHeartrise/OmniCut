import * as fs from 'node:fs';

/** Delete one or more files, silently ignoring errors (e.g. already deleted). */
export function cleanupFiles(...paths: string[]): void {
	for (const p of paths) {
		try { fs.unlinkSync(p); } catch { /* ok */ }
	}
}
