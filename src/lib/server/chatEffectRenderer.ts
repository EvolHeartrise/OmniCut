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
import type { ShadowConfig } from './exporter.js';

const MAX_VISIBLE = 200;
const FPS = 30;

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
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render a scrolling Twitch chat panel as raw RGBA frames written to a file.
 * The output is a raw video file (no container/codec) — the exporter reads it
 * with `-f rawvideo -pix_fmt rgba -s WxH -r fps`.
 * This bypasses VP9 encoding entirely, guaranteeing alpha is preserved.
 */
export async function renderChatEffectVideo(opts: {
	streamId: string;
	channel: string;
	localStart: number;   // stream-local seconds
	localEnd: number;
	outputPath: string;
	panelWidth?: number;  // default 340
	panelHeight?: number; // default 1080
	chatOffset?: number;  // shift chat timeline in seconds (default 0)
	fontWeight?: number;  // CSS font-weight for chat text (default 400)
	chatScale?: number;   // render at scaled resolution for crisp output (default 1)
	shadow?: ShadowConfig;
}): Promise<{ videoPath: string; width: number; height: number; raw: true; fps: number }> {
	const {
		streamId, channel,
		localStart, localEnd,
		outputPath,
		panelWidth = 340,
		panelHeight = 1080,
		chatOffset = 0,
		fontWeight,
		chatScale = 1,
		shadow,
	} = opts;

	const dur = localEnd - localStart;
	if (dur <= 0) throw new Error('Chat effect duration must be positive');

	// 1. Load chat messages (with backfill so the panel isn't empty at the start)
	//    chatOffset shifts which chat messages are shown: positive = pull from later in the stream
	const BACKFILL_SECONDS = 60;
	const chatStart = localStart + chatOffset;
	const chatEnd = localEnd + chatOffset;
	const fetchStart = Math.max(0, chatStart - BACKFILL_SECONDS);
	const chatMessages = loadChatMessagesInRange(streamId, fetchStart, chatEnd);
	// Shift timestamps back by chatOffset so they align with the video timeline
	for (const msg of chatMessages) {
		msg.timestamp -= chatOffset;
	}
	// Don't clamp backfilled messages — keep their original timestamps so they're
	// already visible at frame 0 (timestamp < localStart ≤ currentTime from the start).
	// This avoids the "catching up" effect where all backfilled messages appear rapidly.
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

	// 5. Render frames → raw RGBA file (no container, no codec)
	// The exporter reads this with explicit rawvideo format, guaranteeing alpha.
	// Render at scaled resolution so text/emotes are crisp (no blurry FFmpeg upscale).
	const pixelW = Math.round(panelWidth * chatScale) & ~1;   // even width
	const pixelH = Math.round(panelHeight * chatScale) & ~1;  // even height

	// Shadow padding (scaled to match render resolution)
	const sp = shadow ? shadowPad(shadow, chatScale) : { top: 0, right: 0, bottom: 0, left: 0 };
	const outW = (pixelW + sp.left + sp.right) & ~1;  // keep even
	const outH = (pixelH + sp.top + sp.bottom) & ~1;

	const rawPath = outputPath.replace(/\.\w+$/, '.rgba');
	const totalFrames = Math.ceil(dur * FPS);

	console.log(`[chat-fx] Rendering ${totalFrames} frames (${dur.toFixed(2)}s) ${outW}x${outH} → ${rawPath}`);
	console.log(`[chat-fx]   stream time ${localStart.toFixed(2)}→${localEnd.toFixed(2)}, ${prepared.length} messages loaded (chatOffset=${chatOffset})`);

	const fd = fs.openSync(rawPath, 'w');

	const canvas = createCanvas(pixelW, pixelH);
	const ctx = canvas.getContext('2d');

	// Shadow canvas (only created if shadow is present)
	const shadowCanvas = shadow ? createCanvas(outW, outH) : null;
	const shadowCtx = shadowCanvas?.getContext('2d') ?? null;

	let lastMsgIds: string | null = null;
	let lastFrameBuf: Buffer | null = null;
	let uniqueFrames = 0;

	for (let frame = 0; frame < totalFrames; frame++) {
		const currentTime = localStart + frame / FPS;
		const elapsedMs = (frame / FPS) * 1000;

		// Binary search for visible message range
		let lo2 = 0, hi2 = prepared.length;
		while (lo2 < hi2) {
			const mid = (lo2 + hi2) >>> 1;
			if (prepared[mid].timestamp <= currentTime) lo2 = mid + 1;
			else hi2 = mid;
		}
		const startIdx = Math.max(0, lo2 - MAX_VISIBLE);
		const msgIds = `${startIdx}:${lo2}`;

		if (msgIds !== lastMsgIds || hasAnimated || !lastFrameBuf) {
			// Scale the canvas context so all drawing (text, emotes, badges) is
			// rendered natively at the target resolution — no post-render upscale.
			ctx.save();
			ctx.scale(chatScale, chatScale);
			renderFrame(ctx, prepared, currentTime, elapsedMs, panelWidth, panelHeight, chatFont, chatBoldFont);
			ctx.restore();

			if (shadowCtx && shadow) {
				// Two-pass: draw content canvas onto shadow canvas with shadow applied
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

		fs.writeSync(fd, lastFrameBuf);
	}

	fs.closeSync(fd);

	const expectedSize = totalFrames * outW * outH * 4;
	const actualSize = fs.statSync(rawPath).size;
	console.log(`[chat-fx]   ${uniqueFrames} unique frames, raw file ${actualSize} bytes (expected ${expectedSize}, ${actualSize === expectedSize ? 'OK' : 'MISMATCH!'})`);

	return { videoPath: rawPath, width: outW, height: outH, raw: true as const, fps: FPS };
}

function shadowPad(shadow: ShadowConfig, scale: number): { top: number; right: number; bottom: number; left: number } {
	const b = Math.round(shadow.blur * scale);
	const ox = Math.round(shadow.offsetX * scale);
	const oy = Math.round(shadow.offsetY * scale);
	return {
		top:    Math.max(0, b - oy),
		bottom: Math.max(0, b + oy),
		left:   Math.max(0, b - ox),
		right:  Math.max(0, b + ox),
	};
}
