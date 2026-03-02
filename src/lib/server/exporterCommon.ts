/**
 * Shared utilities for video exporters.
 * Consolidates duplicated logic across standard, vertical, and chat overlay exporters.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, ClipEntry, EffectEntry } from '../types.js';
import type { StreamLookup } from './exporterTypes.js';
import { parseRelevantSegments, ffmpegConcatEscape, buildConcatContent } from './hlsUtils.js';
import { runFfmpeg } from './ffmpeg.js';

export const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));

/**
 * Resolved clip info after applying trim offsets and computing local times.
 * Returned by resolveClip() for each clip that passes validation.
 */
export interface ResolvedClip {
	clip: ClipRegion;
	entry: ClipEntry | undefined;
	stream: StreamLookup;
	effectiveStart: number;
	effectiveEnd: number;
	dur: number;
	clipDur: number; // dur / speed
	speed: number;
	localStart: number;
	localEnd: number;
	playlistPath: string;
	trimStart: number; // seek offset within first segment
	segments: Array<{ file: string; duration: number; startTime: number }>;
	concatPath: string; // written concat file path
}

/**
 * Resolve a clip: apply trim offsets, compute local times, parse segments,
 * and write a concat file. Returns null if the clip should be skipped.
 */
export function resolveClip(
	clip: ClipRegion,
	entry: ClipEntry | undefined,
	stream: StreamLookup | undefined,
	index: number,
	total: number,
	tempDir: string,
	tag: string
): ResolvedClip | null {
	if (!stream) {
		console.warn(`[${tag}] Skipping clip ${index + 1}/${total} — stream ${clip.streamId} not found`);
		return null;
	}

	const trimStartOffset = entry?.trimStart ?? 0;
	const trimEndOffset = entry?.trimEnd ?? 0;
	const effectiveStart = clip.startTime + trimStartOffset;
	const effectiveEnd = clip.endTime - trimEndOffset;
	const speed = entry?.speed ?? 1;

	if (effectiveEnd <= effectiveStart) {
		console.warn(`[${tag}] Skipping clip ${index + 1}/${total} — trim makes duration ≤ 0`);
		return null;
	}

	const dur = effectiveEnd - effectiveStart;
	const clipDur = dur / speed;

	const anchor = stream.startedAt / 1000;
	const localStart = effectiveStart - anchor + stream.offset;
	const localEnd = effectiveEnd - anchor + stream.offset;
	const playlistPath = path.join(stream.recordingDir, 'playlist.m3u8');

	const segments = parseRelevantSegments(playlistPath, stream.recordingDir, localStart, localEnd);
	if (segments.length === 0) {
		console.warn(`[${tag}] Skipping clip ${index + 1}/${total} — no segments`);
		return null;
	}

	const concatPath = path.join(tempDir, `clip_${index}.concat.txt`);
	fs.writeFileSync(concatPath, buildConcatContent(segments));

	const trimStart = Math.max(0, localStart - segments[0].startTime);

	return {
		clip, entry, stream,
		effectiveStart, effectiveEnd, dur, clipDur, speed,
		localStart, localEnd, playlistPath,
		trimStart, segments, concatPath
	};
}

/**
 * Build the atempo filter chain for a given speed.
 * atempo only supports 0.5-2.0 range, so we chain multiple for wider ranges.
 */
export function buildAtempoChain(speed: number): string[] {
	if (speed === 1) return [];
	const parts: string[] = [];
	let remaining = speed;
	while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
	while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
	parts.push(`atempo=${remaining.toFixed(4)}`);
	return parts;
}

/**
 * Build the audio encoding args with optional tempo filter.
 */
export function buildAudioArgs(speed: number): string[] {
	const atempoFilters = buildAtempoChain(speed);
	return atempoFilters.length > 0
		? ['-af', atempoFilters.join(','), '-c:a', 'aac', '-ar', '48000', '-b:a', '192k']
		: ['-c:a', 'aac', '-ar', '48000', '-b:a', '192k'];
}

/**
 * Create a temp directory under EXPORTS_DIR. Returns the path.
 * The caller should clean up with cleanupTempDir() in a finally block.
 */
export function createTempDir(prefix: string): string {
	fs.mkdirSync(EXPORTS_DIR, { recursive: true });
	const tempDir = path.join(EXPORTS_DIR, `temp_${prefix}_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Best-effort cleanup of a temp directory.
 */
export function cleanupTempDir(tempDir: string): void {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Probe the video stream duration of a file in seconds. Returns 0 on failure.
 * Uses the video track specifically to avoid AAC encoder priming inflating the duration.
 */
async function probeVideoDuration(filePath: string): Promise<number> {
	try {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
				'-show_entries', 'stream=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		const dur = parseFloat(stdout.trim());
		return isFinite(dur) && dur > 0 ? dur : 0;
	} catch {
		return 0;
	}
}

/**
 * Concatenate multiple clip files into a single output using ffmpeg concat demuxer.
 * If there's only one file, it's renamed instead (no re-encode).
 */
export async function concatClipFiles(
	clipFiles: string[],
	tempDir: string,
	outputPath: string
): Promise<void> {
	if (clipFiles.length === 1) {
		fs.renameSync(clipFiles[0], outputPath);
		return;
	}

	// Probe video stream durations in parallel — use video-track timing for concat
	// rather than container duration (which includes AAC encoder priming, causing gaps).
	const durations = await Promise.all(clipFiles.map(probeVideoDuration));

	const concatListPath = path.join(tempDir, 'final_concat.txt');
	const lines: string[] = [];
	for (let i = 0; i < clipFiles.length; i++) {
		lines.push(ffmpegConcatEscape(clipFiles[i]));
		if (durations[i] > 0) lines.push(`duration ${durations[i].toFixed(6)}`);
	}
	fs.writeFileSync(concatListPath, lines.join('\n'));

	await runFfmpeg([
		'-f', 'concat', '-safe', '0', '-i', concatListPath,
		'-c', 'copy',
		'-movflags', '+faststart',
		'-y', outputPath
	], 1000);
}

/**
 * Build the video encoder args for NVENC or libx264.
 * Optional gop parameter adds keyframe interval flags (used by vertical exporter).
 */
export function buildVideoEncoderArgs(useNvenc: boolean, gop?: number): string[] {
	const args = useNvenc
		? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'high', '-qp', '18', '-rc-lookahead', '32']
		: ['-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-crf', '18'];
	if (gop !== undefined) {
		args.push('-g', `${gop}`, '-flags', '+cgop');
	}
	return args;
}

/**
 * Build a safe output filename from a raw name, placing it in EXPORTS_DIR.
 */
export function buildOutputPath(filename: string, extension: string): string {
	const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
	return path.join(EXPORTS_DIR, `${safeName}.${extension}`);
}

const AUDIO_DIR = path.resolve(process.cwd(), 'data', 'audio');

/** Resolved audio overlay for a single clip. */
export interface ResolvedAudioOverlay {
	filePath: string;
	/** Seek into the audio file (seconds) — for when the clip starts partway through the effect. */
	seekInAudio: number;
	/** How long to use from the audio (seconds) — clamped to clip duration. */
	audioDur: number;
	/** Offset into the clip where this audio starts (seconds). */
	clipOffset: number;
	volume: number;
}

/**
 * Find audio effects overlapping a clip's composition window and resolve their file paths + timing.
 */
export function resolveAudioOverlays(
	effectEntries: EffectEntry[] | undefined,
	clipCompStart: number,
	clipCompEnd: number
): ResolvedAudioOverlay[] {
	if (!effectEntries) return [];
	const results: ResolvedAudioOverlay[] = [];
	for (const eff of effectEntries) {
		if (eff.type !== 'audio' || !eff.audioId) continue;
		const effEnd = eff.startTime + eff.duration;
		if (eff.startTime >= clipCompEnd || effEnd <= clipCompStart) continue;

		const filePath = path.join(AUDIO_DIR, eff.audioId);
		if (!fs.existsSync(filePath)) {
			console.warn(`[export] Audio overlay file not found: ${filePath}`);
			continue;
		}

		// How much of the effect is clipped at the start (audio may start before this clip)
		const overlapStart = Math.max(eff.startTime, clipCompStart);
		const overlapEnd = Math.min(effEnd, clipCompEnd);
		const seekInAudio = (overlapStart - eff.startTime) + (eff.audioOffset ?? 0);
		const audioDur = overlapEnd - overlapStart;
		const clipOffset = overlapStart - clipCompStart;

		results.push({
			filePath,
			seekInAudio,
			audioDur,
			clipOffset,
			volume: eff.audioVolume ?? 1
		});
	}
	return results;
}

/**
 * Build ffmpeg extra inputs + audio filter complex for mixing audio overlays with source audio.
 * Returns the extra input args, the audio filter graph snippet, and the output audio label.
 * If no audio overlays, returns empty arrays and the caller should use default audio mapping.
 *
 * @param audioOverlays Resolved audio overlays for this clip
 * @param nextInputIdx The next available ffmpeg input index (after video overlays)
 * @param speed Playback speed multiplier
 * @param clipDur Duration of the clip in real time (after speed)
 * @param trimStart Output -ss seek offset (seconds) — added to adelay so overlay audio
 *                  isn't clipped by the output seek that discards pre-clip content
 */
export function buildAudioMixFilter(
	audioOverlays: ResolvedAudioOverlay[],
	nextInputIdx: number,
	speed: number,
	clipDur: number,
	trimStart = 0
): { extraInputs: string[]; audioFilterGraph: string; audioOutLabel: string; totalAudioInputs: number } {
	if (audioOverlays.length === 0) {
		return { extraInputs: [], audioFilterGraph: '', audioOutLabel: '', totalAudioInputs: 0 };
	}

	const extraInputs: string[] = [];
	const filters: string[] = [];
	const mixLabels: string[] = [];

	// Source audio with speed adjustment
	const atempoChain = buildAtempoChain(speed);
	if (atempoChain.length > 0) {
		filters.push(`[0:a]${atempoChain.join(',')}[asrc]`);
	} else {
		filters.push(`[0:a]anull[asrc]`);
	}
	mixLabels.push('[asrc]');

	for (let i = 0; i < audioOverlays.length; i++) {
		const ao = audioOverlays[i];
		const inputIdx = nextInputIdx + i;

		// Add input with seek and duration
		extraInputs.push(
			'-ss', ao.seekInAudio.toFixed(3),
			'-t', ao.audioDur.toFixed(3),
			'-i', ao.filePath
		);

		const label = `aov${i}`;
		// Apply volume, atempo for speed, and delay to align with clip position.
		// trimStart compensates for the output -ss seek that discards the pre-clip
		// portion of the filter graph — without it the overlay audio starts early.
		const delayMs = Math.round((trimStart + ao.clipOffset / speed) * 1000);
		const volFilter = `volume=${ao.volume.toFixed(3)}`;
		const atempoFilter = atempoChain.length > 0 ? `,${atempoChain.join(',')}` : '';
		const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : '';
		filters.push(`[${inputIdx}:a]${volFilter}${atempoFilter}${delayFilter}[${label}]`);
		mixLabels.push(`[${label}]`);
	}

	// Mix all audio sources together
	const outLabel = 'amixed';
	const inputCount = mixLabels.length;
	filters.push(`${mixLabels.join('')}amix=inputs=${inputCount}:duration=first:dropout_transition=0[${outLabel}]`);

	return {
		extraInputs,
		audioFilterGraph: filters.join(';'),
		audioOutLabel: outLabel,
		totalAudioInputs: audioOverlays.length
	};
}

/** Probe a video file's width, height, and framerate. */
export async function probeVideo(filePath: string): Promise<{ width: number; height: number; fps: number }> {
	try {
		const proc = Bun.spawn(
			['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
				'-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', filePath],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		if (code !== 0) return { width: 0, height: 0, fps: 0 };
		const data = JSON.parse(stdout);
		const stream = data.streams?.[0];
		const width = parseInt(stream?.width, 10) || 0;
		const height = parseInt(stream?.height, 10) || 0;
		let fps = 0;
		if (stream?.r_frame_rate) {
			const [num, den] = stream.r_frame_rate.split('/').map(Number);
			if (den > 0) fps = Math.round(num / den);
		}
		return { width, height, fps };
	} catch {
		return { width: 0, height: 0, fps: 0 };
	}
}

let nvencCached: boolean | null = null;

/** Test if NVENC is available by encoding a tiny synthetic video (result cached). */
export async function detectNvenc(): Promise<boolean> {
	if (nvencCached !== null) return nvencCached;
	try {
		const proc = Bun.spawn(
			[
				'ffmpeg',
				'-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
				'-f', 'lavfi', '-i', 'anullsrc=d=0.1',
				'-c:v', 'h264_nvenc', '-preset', 'p4', '-qp', '18',
				'-c:a', 'aac',
				'-f', 'null', '-'
			],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
		);

		const code = await proc.exited;
		nvencCached = code === 0;
		return nvencCached;
	} catch {
		nvencCached = false;
		return false;
	}
}
