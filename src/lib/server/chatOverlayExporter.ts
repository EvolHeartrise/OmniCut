/**
 * Chat overlay exporter — renders Twitch chat (badges, colored usernames, emotes)
 * as a standalone transparent VP9+alpha WebM at 1920x1080 with a ~340px panel
 * on the right edge, matching ReviewChatPanel styling.
 *
 * Animated emotes (GIF/WebP) are decoded into individual frames via sharp and
 * cycled at their native frame rate during rendering.
 *
 * Users can composite this overlay onto gameplay footage in their editor.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createCanvas, loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import sharp from 'sharp';
import type { ClipRegion, ClipEntry } from '../types.js';
import type { ChatMessage } from './types.js';
import type { StreamLookup } from './exporter.js';
import { loadChatMessagesInRange } from './persistence.js';
import { parseEmotes, getThirdPartyEmotes, type EmoteMap } from '../emoteParser.js';
import { fetchTwitchBadges, resolveBadges, type BadgeMap } from '../badgeParser.js';
import { usernameColor } from '../utils.js';
import { ffmpegConcatEscape } from './hlsUtils.js';

const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));

// Layout constants (matching ReviewChatPanel CSS)
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const PANEL_W = 340;
const PANEL_X = CANVAS_W - PANEL_W;
const FONT = '13px Inter, Arial, sans-serif';
const BOLD_FONT = 'bold 13px Inter, Arial, sans-serif';
const LINE_HEIGHT = 1.4;
const TEXT_COLOR = '#efeff1';
const BADGE_SIZE = 18;
const BADGE_MARGIN = 3;
const EMOTE_HEIGHT = 23; // ~1.75em at 13px
const PAD_X = 12;
const PAD_Y = 2;
const MAX_VISIBLE = 200;
const FPS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnimatedImage {
	frames: Image[];
	delays: number[]; // per-frame delay in ms
	totalDuration: number; // sum of delays in ms
}

type CachedImage = Image | AnimatedImage | null;

function isAnimated(img: CachedImage): img is AnimatedImage {
	return img !== null && 'frames' in img;
}

interface PreparedMessage {
	id: number;
	timestamp: number; // stream-local seconds
	lines: PreparedLine[];
	totalHeight: number;
}

interface PreparedLine {
	segments: LineSegment[];
	height: number;
}

interface LineSegment {
	type: 'badge' | 'text' | 'emote';
	text?: string;
	color?: string;
	bold?: boolean;
	image?: Image | null;
	animated?: AnimatedImage;
	width: number;
	height: number;
}

// ---------------------------------------------------------------------------
// Animation frame selection
// ---------------------------------------------------------------------------

function getAnimFrame(anim: AnimatedImage, elapsedMs: number): Image {
	const pos = elapsedMs % anim.totalDuration;
	let acc = 0;
	for (let i = 0; i < anim.delays.length; i++) {
		acc += anim.delays[i];
		if (pos < acc) return anim.frames[i];
	}
	return anim.frames[0];
}

// ---------------------------------------------------------------------------
// Timestamp jittering for VOD chat
// ---------------------------------------------------------------------------

/**
 * VOD chat timestamps are rounded to the nearest second, so many messages
 * share the same timestamp. This spreads each group of identical timestamps
 * evenly across the gap to the next distinct timestamp (capped at 1s),
 * with a random offset per message so they don't appear in lockstep.
 * Mutates the array in place. Messages must already be sorted by timestamp.
 */
function jitterTimestamps(messages: Array<{ timestamp: number }>): void {
	let i = 0;
	while (i < messages.length) {
		// Find the run of messages with the same timestamp
		const ts = messages[i].timestamp;
		let j = i + 1;
		while (j < messages.length && messages[j].timestamp === ts) j++;
		const groupSize = j - i;

		if (groupSize > 1) {
			// Gap to the next distinct timestamp, capped at 1 second
			const nextTs = j < messages.length ? messages[j].timestamp : ts + 1;
			const gap = Math.min(nextTs - ts, 1);

			// Assign random offsets within [0, gap), then sort to preserve ordering
			const offsets: number[] = [];
			for (let k = 0; k < groupSize; k++) {
				offsets.push(Math.random() * gap);
			}
			offsets.sort((a, b) => a - b);

			for (let k = 0; k < groupSize; k++) {
				messages[i + k].timestamp = ts + offsets[k];
			}
		}

		i = j;
	}
}

// ---------------------------------------------------------------------------
// Image prefetching (with animated frame extraction via sharp)
// ---------------------------------------------------------------------------

async function decodeImage(buf: Buffer): Promise<CachedImage> {
	try {
		// Probe with animated mode to get page count and per-frame delays
		const meta = await sharp(buf, { animated: true, pages: -1 }).metadata();
		if (meta.pages && meta.pages > 1) {
			// Animated — extract each frame using the page option (more reliable than extract)
			const frames: Image[] = [];
			const delays: number[] = meta.delay ?? [];
			for (let i = 0; i < meta.pages; i++) {
				const frameBuf = await sharp(buf, { page: i }).png().toBuffer();
				frames.push(await loadImage(frameBuf));
				// Default 100ms if delay not specified for this frame
				if (delays.length <= i) delays.push(100);
			}
			// Clamp zero-delay frames (some GIFs use 0 or 10ms which means "use default")
			for (let i = 0; i < delays.length; i++) {
				if (delays[i] < 20) delays[i] = 100;
			}
			const totalDuration = delays.reduce((s, d) => s + d, 0);
			console.log(`[chat-overlay] Decoded animated image: ${meta.pages} frames, ${totalDuration}ms loop`);
			return { frames, delays, totalDuration };
		}
	} catch (err) {
		console.warn(`[chat-overlay] sharp animated decode failed, falling back to static:`, err instanceof Error ? err.message : err);
	}
	// Static image
	return loadImage(buf);
}

async function prefetchImages(urls: Set<string>): Promise<Map<string, CachedImage>> {
	const cache = new Map<string, CachedImage>();
	const urlList = [...urls];

	// Process in batches of 20
	for (let i = 0; i < urlList.length; i += 20) {
		const batch = urlList.slice(i, i + 20);
		const results = await Promise.allSettled(
			batch.map(async (url) => {
				const res = await fetch(url);
				if (!res.ok) return null;
				const buf = Buffer.from(await res.arrayBuffer());
				return decodeImage(buf);
			})
		);
		for (let j = 0; j < batch.length; j++) {
			const r = results[j];
			cache.set(batch[j], r.status === 'fulfilled' ? r.value : null);
		}
	}
	return cache;
}

// ---------------------------------------------------------------------------
// Message preparation (word-wrapping + layout)
// ---------------------------------------------------------------------------

function prepareMessages(
	messages: Array<ChatMessage & { id: number }>,
	emoteMap: EmoteMap,
	badgeMap: BadgeMap,
	imageCache: Map<string, CachedImage>,
	measureCtx: SKRSContext2D
): { prepared: PreparedMessage[]; hasAnimated: boolean } {
	const maxWidth = PANEL_W - PAD_X * 2;
	let hasAnimated = false;

	const prepared = messages.map((msg) => {
		const badges = resolveBadges(msg.badges, badgeMap);
		const segments = parseEmotes(msg.text, msg.emotes, emoteMap);

		// Build flat segment list: badges, username, colon, then message segments
		const flatSegs: LineSegment[] = [];

		// Badges
		for (const badge of badges) {
			const cached = imageCache.get(badge.imageUrl) ?? null;
			flatSegs.push({
				type: 'badge',
				image: isAnimated(cached) ? cached.frames[0] : cached,
				width: BADGE_SIZE + BADGE_MARGIN,
				height: BADGE_SIZE
			});
		}

		// Username
		const userColor = msg.color || usernameColor(msg.username);
		measureCtx.font = BOLD_FONT;
		const nameWidth = measureCtx.measureText(msg.username).width;
		flatSegs.push({
			type: 'text',
			text: msg.username,
			color: userColor,
			bold: true,
			width: nameWidth,
			height: 13 * LINE_HEIGHT
		});

		// Colon + space
		measureCtx.font = FONT;
		const colonWidth = measureCtx.measureText(': ').width;
		flatSegs.push({
			type: 'text',
			text: ': ',
			color: TEXT_COLOR,
			width: colonWidth,
			height: 13 * LINE_HEIGHT
		});

		// Message content
		for (const seg of segments) {
			if (seg.type === 'emote' && seg.emoteUrl) {
				const cached = imageCache.get(seg.emoteUrl) ?? null;
				if (isAnimated(cached)) {
					hasAnimated = true;
					const first = cached.frames[0];
					const ar = first.width / Math.max(1, first.height);
					const w = EMOTE_HEIGHT * ar;
					flatSegs.push({
						type: 'emote',
						animated: cached,
						text: seg.text,
						width: w + 4,
						height: EMOTE_HEIGHT
					});
				} else if (cached) {
					const ar = cached.width / Math.max(1, cached.height);
					const w = EMOTE_HEIGHT * ar;
					flatSegs.push({
						type: 'emote',
						image: cached,
						text: seg.text,
						width: w + 4,
						height: EMOTE_HEIGHT
					});
				} else {
					// Fallback: render emote name as text
					measureCtx.font = FONT;
					const tw = measureCtx.measureText(seg.text).width;
					flatSegs.push({
						type: 'text',
						text: seg.text,
						color: TEXT_COLOR,
						width: tw,
						height: 13 * LINE_HEIGHT
					});
				}
			} else {
				// Split text by words for wrapping
				const words = seg.text.split(/(\s+)/);
				for (const word of words) {
					if (!word) continue;
					measureCtx.font = FONT;
					const tw = measureCtx.measureText(word).width;
					flatSegs.push({
						type: 'text',
						text: word,
						color: TEXT_COLOR,
						width: tw,
						height: 13 * LINE_HEIGHT
					});
				}
			}
		}

		// Word-wrap into lines
		const lines: PreparedLine[] = [];
		let currentLine: LineSegment[] = [];
		let lineWidth = 0;

		for (const seg of flatSegs) {
			if (lineWidth + seg.width > maxWidth && currentLine.length > 0) {
				const lineH = Math.max(...currentLine.map((s) => s.height));
				lines.push({ segments: currentLine, height: lineH });
				currentLine = [];
				lineWidth = 0;
			}
			currentLine.push(seg);
			lineWidth += seg.width;
		}
		if (currentLine.length > 0) {
			const lineH = Math.max(...currentLine.map((s) => s.height));
			lines.push({ segments: currentLine, height: lineH });
		}

		const totalHeight = lines.reduce((sum, l) => sum + l.height, 0) + PAD_Y * 2;

		return {
			id: msg.id,
			timestamp: msg.timestamp,
			lines,
			totalHeight
		};
	});

	return { prepared, hasAnimated };
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

function renderFrame(
	ctx: SKRSContext2D,
	messages: PreparedMessage[],
	currentTime: number,
	elapsedMs: number
): void {
	// Clear entire canvas (transparent)
	ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

	// Binary search for messages at or before currentTime
	let lo = 0, hi = messages.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (messages[mid].timestamp <= currentTime) lo = mid + 1;
		else hi = mid;
	}
	const visible = lo > MAX_VISIBLE ? messages.slice(lo - MAX_VISIBLE, lo) : messages.slice(0, lo);

	if (visible.length === 0) return;

	// Draw messages bottom-up: last message at bottom
	let y = CANVAS_H;
	for (let i = visible.length - 1; i >= 0; i--) {
		const msg = visible[i];
		y -= msg.totalHeight;
		if (y + msg.totalHeight < 0) break; // off-screen above

		let lineY = y + PAD_Y;
		for (const line of msg.lines) {
			let x = PANEL_X + PAD_X;
			const baseline = lineY + line.height * 0.75;

			for (const seg of line.segments) {
				if (seg.type === 'badge') {
					if (seg.image) {
						const imgY = baseline - BADGE_SIZE + 2;
						ctx.drawImage(seg.image, x, imgY, BADGE_SIZE, BADGE_SIZE);
					}
					x += seg.width;
				} else if (seg.type === 'emote') {
					if (seg.animated) {
						const frame = getAnimFrame(seg.animated, elapsedMs);
						const ar = frame.width / Math.max(1, frame.height);
						const ew = EMOTE_HEIGHT * ar;
						const imgY = baseline - EMOTE_HEIGHT + 2;
						ctx.drawImage(frame, x + 2, imgY, ew, EMOTE_HEIGHT);
					} else if (seg.image) {
						const ar = seg.image.width / Math.max(1, seg.image.height);
						const ew = EMOTE_HEIGHT * ar;
						const imgY = baseline - EMOTE_HEIGHT + 2;
						ctx.drawImage(seg.image, x + 2, imgY, ew, EMOTE_HEIGHT);
					} else if (seg.text) {
						ctx.font = FONT;
						ctx.fillStyle = TEXT_COLOR;
						ctx.fillText(seg.text, x, baseline);
					}
					x += seg.width;
				} else {
					ctx.font = seg.bold ? BOLD_FONT : FONT;
					ctx.fillStyle = seg.color || TEXT_COLOR;
					ctx.fillText(seg.text!, x, baseline);
					x += seg.width;
				}
			}
			lineY += line.height;
		}
	}
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportChatOverlay(
	clips: ClipRegion[],
	streamMap: Map<string, StreamLookup>,
	channelMap: Map<string, string>,
	filename: string,
	onProgress: (msg: string, step: number, total: number) => void,
	clipEntries?: (ClipEntry | undefined)[]
): Promise<{ outputPath: string }> {
	if (clips.length === 0) throw new Error('No clips to export');

	fs.mkdirSync(EXPORTS_DIR, { recursive: true });
	const tempDir = path.join(EXPORTS_DIR, `temp_chat_${Date.now()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	const totalSteps = clips.length + 1;
	onProgress(`Starting chat overlay export: ${clips.length} clips`, 0, totalSteps);

	try {
		// Fetch emote/badge maps per unique channel
		const channelDataCache = new Map<string, { emotes: EmoteMap; badges: BadgeMap }>();

		const channelSet = new Set<string>(channelMap.values());

		await Promise.all(
			[...channelSet].map(async (channel) => {
				const [emotes, badges] = await Promise.all([
					getThirdPartyEmotes(channel),
					fetchTwitchBadges(channel)
				]);
				channelDataCache.set(channel, { emotes, badges });
			})
		);

		const clipFiles: string[] = [];
		const measureCanvas = createCanvas(1, 1);
		const measureCtx = measureCanvas.getContext('2d');

		for (let ci = 0; ci < clips.length; ci++) {
			const clip = clips[ci];
			const entry = clipEntries?.[ci];
			const stream = streamMap.get(clip.streamId);
			if (!stream) {
				console.warn(`[chat-overlay] Skipping clip ${ci + 1} — stream ${clip.streamId} not found`);
				continue;
			}

			const channel = channelMap.get(clip.streamId);
			if (!channel) {
				console.warn(`[chat-overlay] Skipping clip ${ci + 1} — channel not found`);
				continue;
			}

			// Apply trim offsets from clip entry
			const trimStartOffset = entry?.trimStart ?? 0;
			const trimEndOffset = entry?.trimEnd ?? 0;
			const effectiveStart = clip.startTime + trimStartOffset;
			const effectiveEnd = clip.endTime - trimEndOffset;

			if (effectiveEnd <= effectiveStart) {
				console.warn(`[chat-overlay] Skipping clip ${ci + 1} — trim makes duration ≤ 0`);
				continue;
			}

			const dur = effectiveEnd - effectiveStart;
			onProgress(`Rendering clip ${ci + 1}/${clips.length} chat overlay (${dur.toFixed(1)}s)`, ci, totalSteps);

			// Convert epoch times to stream-local
			const anchor = stream.startedAt / 1000;
			const localStart = effectiveStart - anchor + stream.offset;
			const localEnd = effectiveEnd - anchor + stream.offset;

			// Load chat messages and jitter identical timestamps.
			// VOD chat timestamps are rounded to the nearest second, so many messages
			// share the exact same timestamp. We spread each group evenly across the
			// gap to the next distinct timestamp (or 1s if it's the last group) with
			// a small random shuffle so they don't appear in a predictable order.
			const chatMessages = loadChatMessagesInRange(clip.streamId, localStart, localEnd);
			jitterTimestamps(chatMessages);

			// Get channel data
			const channelData = channelDataCache.get(channel) ?? {
				emotes: new Map() as EmoteMap,
				badges: new Map() as BadgeMap
			};

			// Collect all image URLs for prefetching
			const imageUrls = new Set<string>();
			for (const msg of chatMessages) {
				const badges = resolveBadges(msg.badges, channelData.badges);
				for (const b of badges) imageUrls.add(b.imageUrl);
				const segments = parseEmotes(msg.text, msg.emotes, channelData.emotes);
				for (const seg of segments) {
					if (seg.type === 'emote' && seg.emoteUrl) imageUrls.add(seg.emoteUrl);
				}
			}

			// Prefetch all images (decodes animated GIF/WebP into frames)
			const imageCache = await prefetchImages(imageUrls);

			// Prepare messages with word-wrapping
			const { prepared, hasAnimated } = prepareMessages(
				chatMessages,
				channelData.emotes,
				channelData.badges,
				imageCache,
				measureCtx
			);

			// Render frames and pipe to FFmpeg
			const totalFrames = Math.ceil(dur * FPS);
			const outFile = path.join(tempDir, `clip_${ci}.webm`);

			const proc = Bun.spawn(
				[
					'ffmpeg',
					'-f', 'image2pipe',
					'-framerate', `${FPS}`,
					'-i', 'pipe:0',
					'-c:v', 'libvpx-vp9',
					'-pix_fmt', 'yuva420p',
					'-auto-alt-ref', '0',
					'-b:v', '0',
					'-crf', '30',
					'-row-mt', '1',
					'-cpu-used', '4',
					'-y', outFile
				],
				{
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: 'pipe'
				}
			);

			const canvas = createCanvas(CANVAS_W, CANVAS_H);
			const ctx = canvas.getContext('2d');
			let lastMsgIds: string | null = null;
			let lastPngBuf: Buffer | null = null;

			for (let frame = 0; frame < totalFrames; frame++) {
				const currentTime = localStart + frame / FPS;
				const elapsedMs = (frame / FPS) * 1000;

				// Compute visible message range for frame-skip optimization
				let lo2 = 0, hi2 = prepared.length;
				while (lo2 < hi2) {
					const mid = (lo2 + hi2) >>> 1;
					if (prepared[mid].timestamp <= currentTime) lo2 = mid + 1;
					else hi2 = mid;
				}
				const startIdx = Math.max(0, lo2 - MAX_VISIBLE);
				const msgIds = `${startIdx}:${lo2}`;

				// Re-render if messages changed OR animated emotes need frame updates
				if (msgIds !== lastMsgIds || hasAnimated || !lastPngBuf) {
					renderFrame(ctx, prepared, currentTime, elapsedMs);
					lastPngBuf = canvas.toBuffer('image/png') as Buffer;
					lastMsgIds = msgIds;
				}

				proc.stdin!.write(lastPngBuf);
			}

			proc.stdin!.end();

			const stderrText = await new Response(proc.stderr).text();
			const code = await proc.exited;
			if (code !== 0) {
				throw new Error(`ffmpeg chat overlay failed (code ${code}): ${stderrText.slice(-1000)}`);
			}

			clipFiles.push(outFile);
		}

		if (clipFiles.length === 0) {
			throw new Error('All clips failed to render — nothing to export');
		}

		// Final output
		onProgress(`Finalizing ${clipFiles.length} clips`, clips.length, totalSteps);
		const safeName = path.basename(filename).replace(/[<>:"/\\|?*]/g, '_');
		const outputPath = path.join(EXPORTS_DIR, `${safeName}.webm`);

		if (clipFiles.length === 1) {
			fs.renameSync(clipFiles[0], outputPath);
		} else {
			const concatListPath = path.join(tempDir, 'concat.txt');
			const concatContent = clipFiles.map((f) => ffmpegConcatEscape(f)).join('\n');
			fs.writeFileSync(concatListPath, concatContent);

			const concatProc = Bun.spawn(
				[
					'ffmpeg',
					'-fflags', '+genpts',
					'-f', 'concat', '-safe', '0', '-i', concatListPath,
					'-c', 'copy',
					'-y', outputPath
				],
				{
					stdin: 'ignore',
					stdout: 'pipe',
					stderr: 'pipe'
				}
			);

			const concatStderr = await new Response(concatProc.stderr).text();
			const concatCode = await concatProc.exited;
			if (concatCode !== 0) {
				throw new Error(`ffmpeg concat failed (code ${concatCode}): ${concatStderr.slice(-500)}`);
			}
		}

		onProgress(`Done — saved to ${outputPath}`, totalSteps, totalSteps);
		return { outputPath };
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch { /* best effort */ }
	}
}
