/**
 * Subtitle effect renderer — renders styled text with outline as a PNG image
 * for compositing onto exported video via FFmpeg overlay filter.
 */

import * as fs from 'node:fs';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { ShadowConfig } from './exporterTypes.js';
import { shadowPadding } from './exporterCommon.js';

const DEFAULT_FONT_SIZE = 48;
const DEFAULT_FONT_COLOR = '#FFFFFF';
const DEFAULT_OUTLINE_COLOR = '#000000';
const DEFAULT_OUTLINE_WIDTH = 4;
const DEFAULT_FONT_WEIGHT = 700;
const DEFAULT_MAX_WIDTH = 900;
const DEFAULT_TEXT_ALIGN = 'center';
const PADDING_X = 16;
const PADDING_Y = 12;
const LINE_HEIGHT_FACTOR = 1.3;

export async function renderSubtitleOverlay(opts: {
	text: string;
	outputPath: string;
	fontSize?: number;
	fontColor?: string;
	outlineColor?: string;
	outlineWidth?: number;
	fontWeight?: number;
	maxWidth?: number;
	textAlign?: 'left' | 'center' | 'right';
	fontFamily?: string;
	shadow?: ShadowConfig;
}): Promise<{ pngPath: string; width: number; height: number }> {
	const {
		text,
		outputPath,
		fontSize = DEFAULT_FONT_SIZE,
		fontColor = DEFAULT_FONT_COLOR,
		outlineColor = DEFAULT_OUTLINE_COLOR,
		outlineWidth = DEFAULT_OUTLINE_WIDTH,
		fontWeight = DEFAULT_FONT_WEIGHT,
		maxWidth = DEFAULT_MAX_WIDTH,
		textAlign = DEFAULT_TEXT_ALIGN,
		fontFamily = 'Inter',
		shadow,
	} = opts;

	const fontFamilyFull = `${fontFamily}, sans-serif`;
	const font = `${fontWeight} ${fontSize}px ${fontFamilyFull}`;
	const lineHeight = Math.ceil(fontSize * LINE_HEIGHT_FACTOR);
	// Account for outline bleed in content width
	const contentWidth = maxWidth - (PADDING_X + outlineWidth) * 2;

	// Measure and word-wrap text
	const measureCanvas = createCanvas(1, 1);
	const measureCtx = measureCanvas.getContext('2d');
	measureCtx.font = font;
	const lines = wrapText(measureCtx, text, contentWidth);

	// Compute actual max line width for tight sizing
	let actualMaxLineWidth = 0;
	for (const line of lines) {
		const w = measureCtx.measureText(line).width;
		if (w > actualMaxLineWidth) actualMaxLineWidth = w;
	}

	const pad = PADDING_X + outlineWidth;
	const canvasWidth = Math.ceil(actualMaxLineWidth + pad * 2);
	const canvasHeight = Math.ceil(lines.length * lineHeight + (PADDING_Y + outlineWidth) * 2);

	// Render text onto content canvas
	const canvas = createCanvas(canvasWidth, canvasHeight);
	const ctx = canvas.getContext('2d');

	ctx.font = font;
	ctx.textBaseline = 'top';

	const topPad = PADDING_Y + outlineWidth;

	for (let i = 0; i < lines.length; i++) {
		const lineWidth = ctx.measureText(lines[i]).width;
		let x: number;
		if (textAlign === 'center') {
			x = (canvasWidth - lineWidth) / 2;
		} else if (textAlign === 'right') {
			x = canvasWidth - pad - lineWidth;
		} else {
			x = pad;
		}
		const y = topPad + i * lineHeight;

		// Draw outline via multi-offset fill at concentric radii to avoid
		// anti-aliasing seam gaps and ensure full coverage on small glyphs
		if (outlineWidth > 0) {
			ctx.fillStyle = outlineColor;
			for (let r = 1; r <= outlineWidth; r++) {
				const steps = Math.ceil(2 * Math.PI * r);
				for (let s = 0; s < steps; s++) {
					const angle = (s / steps) * 2 * Math.PI;
					ctx.fillText(lines[i], x + Math.cos(angle) * r, y + Math.sin(angle) * r);
				}
			}
		}

		ctx.fillStyle = fontColor;
		ctx.fillText(lines[i], x, y);
	}

	// If shadow, use two-pass: draw content canvas onto padded canvas with shadow
	if (shadow) {
		const sp = shadowPadding(shadow);
		const finalW = canvasWidth + sp.left + sp.right;
		const finalH = canvasHeight + sp.top + sp.bottom;
		const finalCanvas = createCanvas(finalW, finalH);
		const finalCtx = finalCanvas.getContext('2d');
		finalCtx.shadowColor = shadow.color;
		finalCtx.shadowBlur = shadow.blur;
		finalCtx.shadowOffsetX = shadow.offsetX;
		finalCtx.shadowOffsetY = shadow.offsetY;
		finalCtx.drawImage(canvas, sp.left, sp.top);
		fs.writeFileSync(outputPath, finalCanvas.toBuffer('image/png'));
		return { pngPath: outputPath, width: finalW, height: finalH };
	}

	// Write PNG
	const pngBuffer = canvas.toBuffer('image/png');
	fs.writeFileSync(outputPath, pngBuffer);

	return { pngPath: outputPath, width: canvasWidth, height: canvasHeight };
}

/** Word-wrap text to fit within maxWidth pixels. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
	const paragraphs = text.split('\n');
	const lines: string[] = [];

	for (const paragraph of paragraphs) {
		if (paragraph === '') {
			lines.push('');
			continue;
		}
		const words = paragraph.split(/\s+/);
		let currentLine = '';

		for (const word of words) {
			const testLine = currentLine ? `${currentLine} ${word}` : word;
			const metrics = ctx.measureText(testLine);
			if (metrics.width > maxWidth && currentLine) {
				lines.push(currentLine);
				currentLine = word;
			} else {
				currentLine = testLine;
			}
		}
		if (currentLine) lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [''];
}
