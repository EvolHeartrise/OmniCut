/**
 * Image overlay renderer.
 * Renders uploaded images as PNGs with optional scaling, opacity, and shadow.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ShadowConfig } from './exporterTypes.js';

/**
 * Render an image overlay to a PNG file with optional scale, opacity, and shadow.
 * Returns the rendered PNG path, final dimensions, and shadow padding offsets.
 * Returns null if the source image file doesn't exist.
 */
export async function renderImageOverlay(opts: {
	imageId: string;
	outputPath: string;
	scale?: number;
	opacity?: number;
	naturalWidth?: number;
	naturalHeight?: number;
	shadow?: ShadowConfig;
}): Promise<{ pngPath: string; width: number; height: number; padLeft: number; padTop: number } | null> {
	const imgDir = path.resolve(process.cwd(), 'data', 'overlays');
	const imgFilePath = path.join(imgDir, opts.imageId);
	if (!fs.existsSync(imgFilePath)) {
		console.warn(`[exporter] Image overlay file not found: ${imgFilePath}`);
		return null;
	}

	const { createCanvas, loadImage } = await import('@napi-rs/canvas');
	const img = await loadImage(imgFilePath);
	const scale = opts.scale ?? 1;
	const opacity = opts.opacity ?? 1;
	const naturalW = opts.naturalWidth ?? img.width;
	const naturalH = opts.naturalHeight ?? img.height;
	const scaledW = Math.round(naturalW * scale);
	const scaledH = Math.round(naturalH * scale);

	const shadow = opts.shadow;
	const sp = shadowPadding(shadow);

	if (scale !== 1 || opacity < 1 || shadow || !imgFilePath.toLowerCase().endsWith('.png')) {
		const canvasW = scaledW + sp.left + sp.right;
		const canvasH = scaledH + sp.top + sp.bottom;
		const canvas = createCanvas(canvasW, canvasH);
		const ctx = canvas.getContext('2d');
		if (shadow) {
			ctx.shadowColor = shadow.color;
			ctx.shadowBlur = shadow.blur;
			ctx.shadowOffsetX = shadow.offsetX;
			ctx.shadowOffsetY = shadow.offsetY;
		}
		ctx.globalAlpha = opacity;
		ctx.drawImage(img, sp.left, sp.top, scaledW, scaledH);
		fs.writeFileSync(opts.outputPath, canvas.toBuffer('image/png'));

		return { pngPath: opts.outputPath, width: canvasW, height: canvasH, padLeft: sp.left, padTop: sp.top };
	}

	// Use directly — no transform needed
	fs.copyFileSync(imgFilePath, opts.outputPath);
	return { pngPath: opts.outputPath, width: scaledW, height: scaledH, padLeft: 0, padTop: 0 };
}

function shadowPadding(shadow?: ShadowConfig): { top: number; right: number; bottom: number; left: number } {
	if (!shadow) return { top: 0, right: 0, bottom: 0, left: 0 };
	const b = shadow.blur;
	return {
		top:    Math.max(0, b - shadow.offsetY),
		bottom: Math.max(0, b + shadow.offsetY),
		left:   Math.max(0, b - shadow.offsetX),
		right:  Math.max(0, b + shadow.offsetX),
	};
}
