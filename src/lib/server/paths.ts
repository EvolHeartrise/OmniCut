import * as path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const OVERLAYS_DIR = path.join(DATA_DIR, 'overlays');
export const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));
export const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings'));
