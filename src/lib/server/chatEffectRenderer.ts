/**
 * Chat effect renderer — renders a scrolling Twitch chat panel as raw RGBA frames
 * for compositing as an effect overlay on exported video.
 *
 * Reuses layout and image infrastructure from chatRenderer.ts.
 * Frame rendering adapted from chatOverlayExporter.ts renderFrame().
 */

import * as fs from 'node:fs';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { loadChatMessagesInRange, loadAllCensorTerms } from './db/index.js';
import { parseEmotes, getThirdPartyEmotes, type EmoteMap } from '../emoteParser.js';
import { fetchTwitchBadges, resolveBadges, type BadgeMap } from '../badgeParser.js';
import {
	prefetchImages, prepareMessages, getAnimFrame, buildChatFonts,
	CHAT_TEXT_COLOR,
	CHAT_BADGE_SIZE, CHAT_EMOTE_HEIGHT, CHAT_PAD_X, CHAT_PAD_Y,
	type PreparedMessage
} from './chatRenderer.js';
import type { ShadowConfig } from './exporterTypes.js';
import { shadowPadding } from './exporterCommon.js';

const MAX_VISIBLE = 200;
const FPS = 30;

// ---------------------------------------------------------------------------
// Types for the two-phase prepare/render pipeline
// ---------------------------------------------------------------------------

/** Accepts raw RGBA frame buffers. Implemented by pipe-based or file-based sinks. */
export interface FrameSink {
	write(buf: Buffer): void;
	flush(): Promise<void>;
}

/** Result of prepareChatEffect() — metadata plus a deferred render function. */
export interface PreparedChatEffect {
	width: number;
	height: number;
	fps: number;
	/** Render all frames to the provided sink. Caller owns sink lifecycle (end/close). */
	renderFrames(sink: FrameSink): Promise<void>;
}

// ---------------------------------------------------------------------------
// Timestamp jittering for VOD chat (moved from chatOverlayExporter.ts)
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
		const ts = messages[i].timestamp;
		let j = i + 1;
		while (j < messages.length && messages[j].timestamp === ts) j++;
		const groupSize = j - i;

		if (groupSize > 1) {
			const nextTs = j < messages.length ? messages[j].timestamp : ts + 1;
			const gap = Math.min(nextTs - ts, 1);
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
// Frame rendering (adapted from chatOverlayExporter.ts — draws at x=0)
// ---------------------------------------------------------------------------

function renderFrame(
	ctx: SKRSContext2D,
	messages: PreparedMessage[],
	currentTime: number,
	elapsedMs: number,
	canvasW: number,
	canvasH: number,
	chatFont: string,
	chatBoldFont: string
): void {
	ctx.clearRect(0, 0, canvasW, canvasH);

	let lo = 0, hi = messages.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (messages[mid].timestamp <= currentTime) lo = mid + 1;
		else hi = mid;
	}
	const visible = lo > MAX_VISIBLE ? messages.slice(lo - MAX_VISIBLE, lo) : messages.slice(0, lo);
	if (visible.length === 0) return;

	let y = canvasH;
	for (let i = visible.length - 1; i >= 0; i--) {
		const msg = visible[i];
		y -= msg.totalHeight;
		if (y + msg.totalHeight < 0) break;

		let lineY = y + CHAT_PAD_Y;
		for (const line of msg.lines) {
			let x = CHAT_PAD_X;
			const baseline = lineY + line.height * 0.75;

			for (const seg of line.segments) {
				if (seg.type === 'badge') {
					if (seg.image) {
						ctx.imageSmoothingEnabled = false;
						ctx.drawImage(seg.image, x, baseline - CHAT_BADGE_SIZE, CHAT_BADGE_SIZE, CHAT_BADGE_SIZE);
						ctx.imageSmoothingEnabled = true;
					}
					x += seg.width;
				} else if (seg.type === 'emote') {
					if (seg.animated) {
						const frame = getAnimFrame(seg.animated, elapsedMs);
						const ar = frame.width / Math.max(1, frame.height);
						const ew = CHAT_EMOTE_HEIGHT * ar;
						ctx.drawImage(frame, x + 2, baseline - CHAT_EMOTE_HEIGHT + 2, ew, CHAT_EMOTE_HEIGHT);
					} else if (seg.image) {
						const ar = seg.image.width / Math.max(1, seg.image.height);
						const ew = CHAT_EMOTE_HEIGHT * ar;
						ctx.drawImage(seg.image, x + 2, baseline - CHAT_EMOTE_HEIGHT + 2, ew, CHAT_EMOTE_HEIGHT);
					} else if (seg.text) {
						ctx.font = chatFont;
						ctx.fillStyle = CHAT_TEXT_COLOR;
						ctx.fillText(seg.text, x, baseline);
					}
					x += seg.width;
				} else {
					ctx.font = seg.bold ? chatBoldFont : chatFont;
					ctx.fillStyle = seg.color || CHAT_TEXT_COLOR;
					if (seg.censor) {
						ctx.save();
						ctx.filter = 'blur(2.5px)';
						ctx.fillText(seg.text!, x, baseline);
						ctx.restore();
					} else {
						ctx.fillText(seg.text!, x, baseline);
					}
					x += seg.width;
				}
			}
			lineY += line.height;
		}
	}
}

// Channel data cache (reused across calls within the same export)
const channelDataCache = new Map<string, { emotes: EmoteMap; badges: BadgeMap }>();

/** Clear the channel data cache (call between exports). */
export function clearChatEffectCache(): void {
	channelDataCache.clear();
}

// ---------------------------------------------------------------------------
// Two-phase pipeline: prepare (load data + layout) then render (write frames)
// ---------------------------------------------------------------------------

/**
 * Prepare a chat effect: load messages, fetch emotes/badges, compute layout.
 * Returns metadata (width/height/fps) and a deferred renderFrames() function
 * that can write to any FrameSink (pipe or file).
 *
 * This separation allows the exporter to:
 * 1. Get metadata for building FFmpeg args
 * 2. Spawn FFmpeg with stdin: 'pipe'
 * 3. Stream frames directly to FFmpeg without a temp file
 */
export async function prepareChatEffect(opts: {
	streamId: string;
	channel: string;
	localStart: number;
	localEnd: number;
	/** Composition-time duration the FFmpeg overlay needs (seconds).
	 *  When the clip speed != 1, this differs from localEnd - localStart (stream time).
	 *  Defaults to localEnd - localStart. */
	targetDur?: number;
	panelWidth?: number;
	panelHeight?: number;
	chatOffset?: number;
	fontWeight?: number;
	chatScale?: number;
	shadow?: ShadowConfig;
}): Promise<PreparedChatEffect> {
	const {
		streamId, channel,
		localStart, localEnd,
		panelWidth = 340,
		panelHeight = 1080,
		chatOffset = 0,
		fontWeight,
		chatScale = 1,
		shadow,
	} = opts;

	const dur = localEnd - localStart;
	if (dur <= 0) throw new Error('Chat effect duration must be positive');
	// targetDur is the composition-time duration FFmpeg needs (differs from dur when speed != 1).
	// Add a small safety margin to prevent eof_action=repeat freezing the last frames.
	const SAFETY_FRAMES = FPS; // 1 second of safety margin
	const targetDur = opts.targetDur ?? dur;
	const streamRate = dur / targetDur; // how fast to advance through stream time per composition second

	// 1. Load chat messages (with backfill so the panel isn't empty at the start)
	const BACKFILL_SECONDS = 60;
	const chatStart = localStart + chatOffset;
	const chatEnd = localEnd + chatOffset;
	const fetchStart = Math.max(0, chatStart - BACKFILL_SECONDS);
	const chatMessages = loadChatMessagesInRange(streamId, fetchStart, chatEnd);
	for (const msg of chatMessages) {
		msg.timestamp -= chatOffset;
	}
	jitterTimestamps(chatMessages);

	// 2. Fetch emotes + badges (cached)
	let channelData = channelDataCache.get(channel);
	if (!channelData) {
		const [emotes, badges] = await Promise.all([
			getThirdPartyEmotes(channel),
			fetchTwitchBadges(channel)
		]);
		channelData = { emotes, badges };
		channelDataCache.set(channel, channelData);
	}

	// 3. Collect image URLs and prefetch
	const imageUrls = new Set<string>();
	for (const msg of chatMessages) {
		const badges = resolveBadges(msg.badges, channelData.badges);
		for (const b of badges) imageUrls.add(b.imageUrl);
		const segments = parseEmotes(msg.text, msg.emotes, channelData.emotes);
		for (const seg of segments) {
			if (seg.type === 'emote' && seg.emoteUrl) imageUrls.add(seg.emoteUrl);
		}
	}
	const imageCache = await prefetchImages(imageUrls);

	// 4. Load censor terms + prepare messages with layout
	const censorTerms = loadAllCensorTerms();
	const measureCanvas = createCanvas(1, 1);
	const measureCtx = measureCanvas.getContext('2d');
	const { prepared, hasAnimated } = prepareMessages(
		chatMessages,
		channelData.emotes,
		channelData.badges,
		imageCache,
		measureCtx,
		panelWidth - CHAT_PAD_X * 2,
		fontWeight,
		censorTerms
	);
	const { font: chatFont, boldFont: chatBoldFont } = buildChatFonts(fontWeight);

	// 5. Compute pixel dimensions
	const pixelW = Math.round(panelWidth * chatScale) & ~1;
	const pixelH = Math.round(panelHeight * chatScale) & ~1;
	const sp = shadow
		? shadowPadding({ ...shadow, blur: Math.round(shadow.blur * chatScale), offsetX: Math.round(shadow.offsetX * chatScale), offsetY: Math.round(shadow.offsetY * chatScale) })
		: { top: 0, right: 0, bottom: 0, left: 0 };
	const outW = (pixelW + sp.left + sp.right) & ~1;
	const outH = (pixelH + sp.top + sp.bottom) & ~1;
	const totalFrames = Math.ceil(targetDur * FPS) + SAFETY_FRAMES;

	console.log(`[chat-fx] Prepared ${totalFrames} frames (targetDur=${targetDur.toFixed(2)}s, streamDur=${dur.toFixed(2)}s, rate=${streamRate.toFixed(3)}) ${outW}x${outH}`);
	console.log(`[chat-fx]   stream time ${localStart.toFixed(2)}→${localEnd.toFixed(2)}, ${prepared.length} messages loaded (chatOffset=${chatOffset})`);

	return {
		width: outW,
		height: outH,
		fps: FPS,

		async renderFrames(sink: FrameSink): Promise<void> {
			const canvas = createCanvas(pixelW, pixelH);
			const ctx = canvas.getContext('2d');
			const shadowCanvas = shadow ? createCanvas(outW, outH) : null;
			const shadowCtx = shadowCanvas?.getContext('2d') ?? null;

			let lastMsgIds: string | null = null;
			let lastFrameBuf: Buffer | null = null;
			let uniqueFrames = 0;

			for (let frame = 0; frame < totalFrames; frame++) {
				// Advance through stream time at streamRate (matches video speed).
				// Clamp to localEnd so safety-margin frames show the final chat state.
				const compositionSec = frame / FPS;
				const currentTime = Math.min(localStart + compositionSec * streamRate, localEnd);
				const elapsedMs = compositionSec * 1000;

				let lo2 = 0, hi2 = prepared.length;
				while (lo2 < hi2) {
					const mid = (lo2 + hi2) >>> 1;
					if (prepared[mid].timestamp <= currentTime) lo2 = mid + 1;
					else hi2 = mid;
				}
				const startIdx = Math.max(0, lo2 - MAX_VISIBLE);
				const msgIds = `${startIdx}:${lo2}`;

				if (msgIds !== lastMsgIds || hasAnimated || !lastFrameBuf) {
					ctx.save();
					ctx.scale(chatScale, chatScale);
					renderFrame(ctx, prepared, currentTime, elapsedMs, panelWidth, panelHeight, chatFont, chatBoldFont);
					ctx.restore();

					if (shadowCtx && shadow) {
						shadowCtx.clearRect(0, 0, outW, outH);
						shadowCtx.shadowColor = shadow.color;
						shadowCtx.shadowBlur = shadow.blur * chatScale;
						shadowCtx.shadowOffsetX = shadow.offsetX * chatScale;
						shadowCtx.shadowOffsetY = shadow.offsetY * chatScale;
						shadowCtx.drawImage(canvas, sp.left, sp.top);
						const imageData = shadowCtx.getImageData(0, 0, outW, outH);
						lastFrameBuf = Buffer.from(imageData.data);
					} else {
						const imageData = ctx.getImageData(0, 0, pixelW, pixelH);
						lastFrameBuf = Buffer.from(imageData.data);
					}
					lastMsgIds = msgIds;
					uniqueFrames++;
				}

				sink.write(lastFrameBuf);
				await sink.flush();
			}

			console.log(`[chat-fx]   ${uniqueFrames} unique frames rendered`);
		}
	};
}

// ---------------------------------------------------------------------------
// File-based wrapper (backward compat + fallback for multiple raw effects)
// ---------------------------------------------------------------------------

/**
 * Render a scrolling Twitch chat panel as raw RGBA frames written to a file.
 * This is a convenience wrapper around prepareChatEffect() that writes to disk.
 * Used as a fallback when piping to FFmpeg stdin is not possible.
 */
export async function renderChatEffectVideo(opts: {
	streamId: string;
	channel: string;
	localStart: number;
	localEnd: number;
	outputPath: string;
	panelWidth?: number;
	panelHeight?: number;
	chatOffset?: number;
	fontWeight?: number;
	chatScale?: number;
	shadow?: ShadowConfig;
}): Promise<{ videoPath: string; width: number; height: number; raw: true; fps: number }> {
	const prepared = await prepareChatEffect(opts);
	const rawPath = opts.outputPath.replace(/\.\w+$/, '.rgba');

	console.log(`[chat-fx] Writing ${prepared.width}x${prepared.height} to file: ${rawPath}`);
	const fd = fs.openSync(rawPath, 'w');

	try {
		await prepared.renderFrames({
			write(buf: Buffer) { fs.writeSync(fd, buf); },
			async flush() { /* no-op for sync file writes */ }
		});
	} finally {
		fs.closeSync(fd);
	}

	const totalFrameCount = Math.ceil((opts.localEnd - opts.localStart) * FPS) + FPS; // matches totalFrames in prepareChatEffect
	const expectedSize = totalFrameCount * prepared.width * prepared.height * 4;
	const actualSize = fs.statSync(rawPath).size;
	console.log(`[chat-fx]   raw file ${actualSize} bytes (expected ${expectedSize}, ${actualSize === expectedSize ? 'OK' : 'MISMATCH!'})`);

	return { videoPath: rawPath, width: prepared.width, height: prepared.height, raw: true as const, fps: prepared.fps };
}

