/**
 * Shared chat rendering infrastructure — types, image decoding, message layout.
 * Used by chatEffectRenderer.ts (scrolling chat panel video) and effectRenderer.ts (single-message PNG).
 */

import { loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import sharp from 'sharp';
import type { ChatMessage } from './types.js';
import { parseEmotes, type EmoteMap } from '../emoteParser.js';
import { resolveBadges, type BadgeMap } from '../badgeParser.js';
import { usernameColor } from '../utils.js';

// ---------------------------------------------------------------------------
// Layout constants (matching ReviewChatPanel CSS)
// ---------------------------------------------------------------------------

export const CHAT_FONT = '13px Inter, Arial, sans-serif';
export const CHAT_BOLD_FONT = 'bold 13px Inter, Arial, sans-serif';

/** Build font strings for a given weight (default 400 normal / 700 bold). */
export function buildChatFonts(fontWeight?: number): { font: string; boldFont: string } {
	if (!fontWeight || fontWeight === 400) return { font: CHAT_FONT, boldFont: CHAT_BOLD_FONT };
	return {
		font: `${fontWeight} 13px Inter, Arial, sans-serif`,
		boldFont: `${Math.min(900, fontWeight + 300)} 13px Inter, Arial, sans-serif`
	};
}
export const CHAT_LINE_HEIGHT = 1.4;
export const CHAT_TEXT_COLOR = '#efeff1';
export const CHAT_BADGE_SIZE = 11;
export const CHAT_BADGE_MARGIN = 3;
export const CHAT_EMOTE_HEIGHT = 23; // ~1.75em at 13px
export const CHAT_PAD_X = 12;
export const CHAT_PAD_Y = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnimatedImage {
	frames: Image[];
	delays: number[]; // per-frame delay in ms
	totalDuration: number; // sum of delays in ms
}

export type CachedImage = Image | AnimatedImage | null;

export function isAnimated(img: CachedImage): img is AnimatedImage {
	return img !== null && 'frames' in img;
}

export interface PreparedMessage {
	id: number;
	timestamp: number; // stream-local seconds
	lines: PreparedLine[];
	totalHeight: number;
}

export interface PreparedLine {
	segments: LineSegment[];
	height: number;
}

export interface LineSegment {
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
// Image prefetching (with animated frame extraction via sharp)
// ---------------------------------------------------------------------------

export async function decodeImage(buf: Buffer): Promise<CachedImage> {
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
			console.log(`[chat-renderer] Decoded animated image: ${meta.pages} frames, ${totalDuration}ms loop`);
			return { frames, delays, totalDuration };
		}
	} catch (err) {
		console.warn(`[chat-renderer] sharp animated decode failed, falling back to static:`, err instanceof Error ? err.message : err);
	}
	// Static image
	return loadImage(buf);
}

export async function prefetchImages(urls: Set<string>): Promise<Map<string, CachedImage>> {
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
// Animation frame selection
// ---------------------------------------------------------------------------

export function getAnimFrame(anim: AnimatedImage, elapsedMs: number): Image {
	const pos = elapsedMs % anim.totalDuration;
	let acc = 0;
	for (let i = 0; i < anim.delays.length; i++) {
		acc += anim.delays[i];
		if (pos < acc) return anim.frames[i];
	}
	return anim.frames[0];
}

// ---------------------------------------------------------------------------
// Message preparation (word-wrapping + layout)
// ---------------------------------------------------------------------------

export function prepareMessages(
	messages: Array<ChatMessage & { id: number }>,
	emoteMap: EmoteMap,
	badgeMap: BadgeMap,
	imageCache: Map<string, CachedImage>,
	measureCtx: SKRSContext2D,
	overrideMaxWidth?: number,
	fontWeight?: number
): { prepared: PreparedMessage[]; hasAnimated: boolean } {
	const PANEL_W = 340;
	const maxWidth = overrideMaxWidth ?? (PANEL_W - CHAT_PAD_X * 2);
	const { font: chatFont, boldFont: chatBoldFont } = buildChatFonts(fontWeight);
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
				width: CHAT_BADGE_SIZE + CHAT_BADGE_MARGIN,
				height: CHAT_BADGE_SIZE
			});
		}

		// Username
		const userColor = msg.color || usernameColor(msg.username);
		measureCtx.font = chatBoldFont;
		const nameWidth = measureCtx.measureText(msg.username).width;
		flatSegs.push({
			type: 'text',
			text: msg.username,
			color: userColor,
			bold: true,
			width: nameWidth,
			height: 13 * CHAT_LINE_HEIGHT
		});

		// Colon + space
		measureCtx.font = chatFont;
		const colonWidth = measureCtx.measureText(': ').width;
		flatSegs.push({
			type: 'text',
			text: ': ',
			color: CHAT_TEXT_COLOR,
			width: colonWidth,
			height: 13 * CHAT_LINE_HEIGHT
		});

		// Message content
		for (const seg of segments) {
			if (seg.type === 'emote' && seg.emoteUrl) {
				const cached = imageCache.get(seg.emoteUrl) ?? null;
				if (isAnimated(cached)) {
					hasAnimated = true;
					const first = cached.frames[0];
					const ar = first.width / Math.max(1, first.height);
					const w = CHAT_EMOTE_HEIGHT * ar;
					flatSegs.push({
						type: 'emote',
						animated: cached,
						text: seg.text,
						width: w + 4,
						height: CHAT_EMOTE_HEIGHT
					});
				} else if (cached) {
					const ar = cached.width / Math.max(1, cached.height);
					const w = CHAT_EMOTE_HEIGHT * ar;
					flatSegs.push({
						type: 'emote',
						image: cached,
						text: seg.text,
						width: w + 4,
						height: CHAT_EMOTE_HEIGHT
					});
				} else {
					// Fallback: render emote name as text
					measureCtx.font = chatFont;
					const tw = measureCtx.measureText(seg.text).width;
					flatSegs.push({
						type: 'text',
						text: seg.text,
						color: CHAT_TEXT_COLOR,
						width: tw,
						height: 13 * CHAT_LINE_HEIGHT
					});
				}
			} else {
				// Split text by words for wrapping
				const words = seg.text.split(/(\s+)/);
				for (const word of words) {
					if (!word) continue;
					measureCtx.font = chatFont;
					const tw = measureCtx.measureText(word).width;
					flatSegs.push({
						type: 'text',
						text: word,
						color: CHAT_TEXT_COLOR,
						width: tw,
						height: 13 * CHAT_LINE_HEIGHT
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

		const totalHeight = lines.reduce((sum, l) => sum + l.height, 0) + CHAT_PAD_Y * 2;

		return {
			id: msg.id,
			timestamp: msg.timestamp,
			lines,
			totalHeight
		};
	});

	return { prepared, hasAnimated };
}
