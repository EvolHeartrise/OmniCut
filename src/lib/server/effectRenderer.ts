/**
 * Effect overlay renderer — renders a single chat message as a PNG image
 * for compositing onto exported video via FFmpeg overlay filter.
 *
 * Reuses rendering infrastructure from chatRenderer.ts:
 * prepareMessages, prefetchImages, font constants, and drawing logic.
 */

import * as fs from 'node:fs';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { ChatMessage } from './types.js';
import { loadChatMessageByTwitchId } from './db/index.js';
import { getStream } from './streamManager.js';
import { parseEmotes, getThirdPartyEmotes, type EmoteMap } from '../emoteParser.js';
import { fetchTwitchBadges, resolveBadges, type BadgeMap } from '../badgeParser.js';
import {
	prepareMessages,
	prefetchImages,
	CHAT_FONT,
	CHAT_BOLD_FONT,
	CHAT_TEXT_COLOR,
	CHAT_BADGE_SIZE,
	CHAT_EMOTE_HEIGHT,
	CHAT_PAD_X,
	CHAT_PAD_Y,
} from './chatRenderer.js';

// Default max width for effect overlays (pixels at 1920-wide resolution)
const DEFAULT_MAX_WIDTH = 400;
const BG_COLOR = 'rgba(24, 24, 27, 0.8)'; // #18181b at 80% opacity
const BORDER_RADIUS = 6;

// Channel data cache (reused across effects within the same export)
const channelCache = new Map<string, { emotes: EmoteMap; badges: BadgeMap }>();

/**
 * Render a single chat message effect as a PNG file.
 * Returns the PNG path and dimensions, or null if the message can't be found.
 */
export async function renderEffectOverlay(opts: {
	twitchId: string;
	outputPath: string;
	maxWidth?: number;
}): Promise<{ pngPath: string; width: number; height: number } | null> {
	const { twitchId, outputPath, maxWidth = DEFAULT_MAX_WIDTH } = opts;

	// Load the chat message from DB
	const msg = loadChatMessageByTwitchId(twitchId);
	if (!msg) {
		console.warn(`[effect-renderer] Chat message not found for twitchId: ${twitchId}`);
		return null;
	}

	// Get channel for emote/badge resolution
	const stream = getStream(msg.streamId);
	const channel = stream?.channel;
	if (!channel) {
		console.warn(`[effect-renderer] Stream/channel not found for streamId: ${msg.streamId}`);
		return null;
	}

	// Fetch emotes/badges (cached across calls)
	let channelData = channelCache.get(channel);
	if (!channelData) {
		const [emotes, badges] = await Promise.all([
			getThirdPartyEmotes(channel),
			fetchTwitchBadges(channel)
		]);
		channelData = { emotes, badges };
		channelCache.set(channel, channelData);
	}

	// Collect image URLs for badges + emotes
	const imageUrls = new Set<string>();
	const badges = resolveBadges(msg.badges, channelData.badges);
	for (const b of badges) imageUrls.add(b.imageUrl);
	const segments = parseEmotes(msg.text, msg.emotes, channelData.emotes);
	for (const seg of segments) {
		if (seg.type === 'emote' && seg.emoteUrl) imageUrls.add(seg.emoteUrl);
	}

	// Prefetch images
	const imageCache = await prefetchImages(imageUrls);

	// Prepare the message using shared layout logic
	const measureCanvas = createCanvas(1, 1);
	const measureCtx = measureCanvas.getContext('2d');
	const contentWidth = maxWidth - CHAT_PAD_X * 2;

	const { prepared } = prepareMessages(
		[msg as ChatMessage & { id: number }],
		channelData.emotes,
		channelData.badges,
		imageCache,
		measureCtx,
		contentWidth
	);

	if (prepared.length === 0) {
		console.warn(`[effect-renderer] No prepared message for twitchId: ${twitchId}`);
		return null;
	}

	const pm = prepared[0];

	// Compute tight canvas size
	const canvasHeight = pm.totalHeight + CHAT_PAD_Y * 2;
	let actualMaxWidth = 0;
	for (const line of pm.lines) {
		let lineW = 0;
		for (const seg of line.segments) lineW += seg.width;
		if (lineW > actualMaxWidth) actualMaxWidth = lineW;
	}
	const canvasWidth = Math.ceil(actualMaxWidth + CHAT_PAD_X * 2);

	// Create canvas and draw
	const canvas = createCanvas(canvasWidth, canvasHeight);
	const ctx = canvas.getContext('2d');

	// Draw rounded background
	drawRoundedRect(ctx, 0, 0, canvasWidth, canvasHeight, BORDER_RADIUS, BG_COLOR);

	// Draw message lines
	let lineY = CHAT_PAD_Y;
	for (const line of pm.lines) {
		let x = CHAT_PAD_X;
		const baseline = lineY + line.height * 0.75;

		for (const seg of line.segments) {
			if (seg.type === 'badge') {
				if (seg.image) {
					ctx.drawImage(seg.image, x, baseline - CHAT_BADGE_SIZE + 2, CHAT_BADGE_SIZE, CHAT_BADGE_SIZE);
				}
				x += seg.width;
			} else if (seg.type === 'emote') {
				const img = seg.animated ? seg.animated.frames[0] : seg.image;
				if (img) {
					const ar = img.width / Math.max(1, img.height);
					const ew = CHAT_EMOTE_HEIGHT * ar;
					ctx.drawImage(img, x + 2, baseline - CHAT_EMOTE_HEIGHT + 2, ew, CHAT_EMOTE_HEIGHT);
				} else if (seg.text) {
					ctx.font = CHAT_FONT;
					ctx.fillStyle = CHAT_TEXT_COLOR;
					ctx.fillText(seg.text, x, baseline);
				}
				x += seg.width;
			} else {
				ctx.font = seg.bold ? CHAT_BOLD_FONT : CHAT_FONT;
				ctx.fillStyle = seg.color || CHAT_TEXT_COLOR;
				ctx.fillText(seg.text!, x, baseline);
				x += seg.width;
			}
		}
		lineY += line.height;
	}

	// Write PNG
	const pngBuffer = canvas.toBuffer('image/png');
	fs.writeFileSync(outputPath, pngBuffer);

	return { pngPath: outputPath, width: canvasWidth, height: canvasHeight };
}

/** Clear the channel data cache (call between exports if needed). */
export function clearEffectRendererCache(): void {
	channelCache.clear();
}

function drawRoundedRect(
	ctx: SKRSContext2D,
	x: number, y: number, w: number, h: number,
	r: number, fill: string
): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
	ctx.fillStyle = fill;
	ctx.fill();
}
