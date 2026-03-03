/**
 * Shared utilities for video exporters.
 * Consolidates duplicated logic across standard, vertical, and chat overlay exporters.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ClipRegion, ClipEntry, EffectEntry } from '../types.js';
import type { StreamLookup, OtherTrackClip, ShadowConfig } from './exporterTypes.js';
import type { ExtraTrackInput } from './exporterPipeline.js';
import { getRecordingMp4 } from './remuxer.js';
import { runFfmpeg, ffmpegConcatEscape, probeMedia } from './ffmpeg.js';
import { EXPORTS_DIR, AUDIO_DIR } from './paths.js';

export { EXPORTS_DIR };

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
	localStart: number;
	localEnd: number;
	mp4Path: string;
	seekOffset: number; // seek position into recording.mp4
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
	_tempDir: string,
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

	if (effectiveEnd <= effectiveStart) {
		console.warn(`[${tag}] Skipping clip ${index + 1}/${total} — trim makes duration ≤ 0`);
		return null;
	}

	const dur = effectiveEnd - effectiveStart;

	const anchor = stream.startedAt / 1000;
	const localStart = effectiveStart - anchor + stream.offset;
	const localEnd = effectiveEnd - anchor + stream.offset;

	const mp4Path = getRecordingMp4(stream.recordingDir);
	if (!mp4Path) {
		console.warn(`[${tag}] Skipping clip ${index + 1}/${total} — recording.mp4 not found`);
		return null;
	}

	return {
		clip, entry, stream,
		effectiveStart, effectiveEnd, dur,
		localStart, localEnd, mp4Path,
		seekOffset: localStart
	};
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
	const probes = await Promise.all(clipFiles.map(probeMedia));
	const durations = probes.map((p) => p.videoDuration);

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
 * @param clipDur Duration of the clip (seconds)
 * @param trimStart Output -ss seek offset (seconds) — added to adelay so overlay audio
 *                  isn't clipped by the output seek that discards pre-clip content
 */
export function buildAudioMixFilter(
	audioOverlays: ResolvedAudioOverlay[],
	nextInputIdx: number,
	clipDur: number,
	trimStart = 0
): { extraInputs: string[]; audioFilterGraph: string; audioOutLabel: string; totalAudioInputs: number } {
	if (audioOverlays.length === 0) {
		return { extraInputs: [], audioFilterGraph: '', audioOutLabel: '', totalAudioInputs: 0 };
	}

	const extraInputs: string[] = [];
	const filters: string[] = [];
	const mixLabels: string[] = [];

	// Source audio with PTS reset to match video PTS so A/V stays in sync.
	filters.push(`[0:a]asetpts=PTS-STARTPTS[asrc]`);
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
		// Apply volume and delay to align with clip position.
		// trimStart compensates for the output -ss seek that discards the pre-clip
		// portion of the filter graph — without it the overlay audio starts early.
		const delayMs = Math.round((trimStart + ao.clipOffset) * 1000);
		const volFilter = `volume=${ao.volume.toFixed(3)}`;
		const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : '';
		filters.push(`[${inputIdx}:a]${volFilter}${delayFilter}[${label}]`);
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

/**
 * Find other-track clips that overlap a track 0 clip's composition window
 * and resolve them into ExtraTrackInput entries for FFmpeg.
 */
export function resolveExtraTrackInputs(
	otherTrackClips: OtherTrackClip[] | undefined,
	clipCompStart: number,
	clipCompEnd: number,
	streamMap: Map<string, StreamLookup>,
	tempDir: string,
	clipIdx: number,
	tag: string
): ExtraTrackInput[] | undefined {
	if (!otherTrackClips || otherTrackClips.length === 0) return undefined;

	const overlapping = otherTrackClips.filter(
		(o) => o.compStart < clipCompEnd && o.compEnd > clipCompStart
	);
	if (overlapping.length === 0) return undefined;

	const results: ExtraTrackInput[] = [];
	for (const otc of overlapping) {
		const resolved = resolveClip(
			otc.clip, otc.entry, streamMap.get(otc.clip.streamId),
			clipIdx, 1, tempDir, `${tag}-track${otc.track}`
		);
		if (!resolved) continue;

		const overlapStart = Math.max(clipCompStart, otc.compStart);
		const overlapEnd = Math.min(clipCompEnd, otc.compEnd);
		const otcSourceOffset = overlapStart - otc.compStart;
		const seekOffset = resolved.seekOffset + otcSourceOffset;
		const dur = overlapEnd - overlapStart;

		results.push({
			track: otc.track,
			mp4Path: resolved.mp4Path,
			seekOffset,
			dur,
			clipOffset: overlapStart - clipCompStart,
		});
	}

	return results.length > 0 ? results : undefined;
}

/** Compute padding needed around a canvas to accommodate a drop shadow. */
export function shadowPadding(shadow?: ShadowConfig): { top: number; right: number; bottom: number; left: number } {
	if (!shadow) return { top: 0, right: 0, bottom: 0, left: 0 };
	const b = shadow.blur;
	return {
		top:    Math.max(0, b - shadow.offsetY),
		bottom: Math.max(0, b + shadow.offsetY),
		left:   Math.max(0, b - shadow.offsetX),
		right:  Math.max(0, b + shadow.offsetX),
	};
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
