/**
 * Thumbnail storage and AI enhancement module.
 * Handles saving/loading PNG thumbnails to disk, CRUD via persistence layer,
 * and optional Gemini-based AI image enhancement.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { newThumbnailId } from '../ids.js';
import * as db from './db/index.js';
import type { ThumbnailRecord, LayerConfig } from './db/index.js';

const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(process.cwd(), 'exports'));
const THUMBNAILS_DIR = path.join(EXPORTS_DIR, 'thumbnails');

function ensureThumbnailsDir(): void {
	fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

/**
 * Save a PNG thumbnail. One thumbnail per video — overwrites existing.
 */
export function saveThumbnailFromPng(
	videoId: string,
	pngBuffer: Buffer,
	metadata?: {
		width?: number;
		height?: number;
		layers?: LayerConfig[];
		exportId?: string;
	}
): ThumbnailRecord {
	ensureThumbnailsDir();

	// Check for existing thumbnail by video
	const existing = db.loadThumbnailByVideo(videoId);
	if (existing) {
		try {
			if (fs.existsSync(existing.filePath)) fs.unlinkSync(existing.filePath);
		} catch { /* ignore cleanup errors */ }
	}

	const id = existing?.id ?? newThumbnailId();
	const filePath = path.join(THUMBNAILS_DIR, `${id}.png`);
	fs.writeFileSync(filePath, pngBuffer);

	const now = Math.floor(Date.now() / 1000);
	const record: ThumbnailRecord = {
		id,
		videoId,
		exportId: metadata?.exportId,
		filePath,
		width: metadata?.width ?? 1280,
		height: metadata?.height ?? 720,
		...(metadata?.layers && { layers: metadata.layers }),
		aiEnhanced: false,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};

	db.saveThumbnail(record);
	return record;
}

/**
 * Delete a thumbnail by ID (file + DB record).
 */
export function deleteThumbnailById(id: string): void {
	const record = db.loadThumbnail(id);
	if (record) {
		try {
			if (fs.existsSync(record.filePath)) fs.unlinkSync(record.filePath);
		} catch { /* ignore */ }
	}
	db.deleteThumbnail(id);
}

/**
 * Check if the Google Generative AI API key is configured.
 */
export function isAIConfigured(): boolean {
	return !!process.env.GOOGLE_GENAI_API_KEY;
}

/**
 * Enhance a thumbnail using Google Gemini image generation.
 * Requires GOOGLE_GENAI_API_KEY env var.
 * Returns the updated record and base64-encoded PNG.
 */
export async function enhanceWithAI(
	thumbnailId: string,
	prompt: string,
	conversationHistory?: Array<{ role: 'user' | 'model'; text?: string; imageBase64?: string }>
): Promise<{ pngBase64: string; thumbnailRecord: ThumbnailRecord }> {
	const apiKey = process.env.GOOGLE_GENAI_API_KEY;
	if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY not configured');

	const record = db.loadThumbnail(thumbnailId);
	if (!record) throw new Error(`Thumbnail not found: ${thumbnailId}`);

	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey });

	// Read current thumbnail image
	const imageBytes = fs.readFileSync(record.filePath);
	const imageBase64 = imageBytes.toString('base64');

	// Build content parts
	const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

	// Add conversation history if provided
	if (conversationHistory) {
		for (const entry of conversationHistory) {
			const parts: Array<Record<string, unknown>> = [];
			if (entry.imageBase64) {
				parts.push({ inlineData: { mimeType: 'image/png', data: entry.imageBase64 } });
			}
			if (entry.text) {
				parts.push({ text: entry.text });
			}
			contents.push({ role: entry.role, parts });
		}
	}

	// Add current request
	contents.push({
		role: 'user',
		parts: [
			{ inlineData: { mimeType: 'image/png', data: imageBase64 } },
			{ text: prompt }
		]
	});

	const response = await ai.models.generateContent({
		model: 'gemini-2.0-flash-exp',
		contents,
		config: {
			responseModalities: ['TEXT', 'IMAGE']
		}
	});

	// Extract image from response
	const candidate = response.candidates?.[0];
	if (!candidate?.content?.parts) {
		throw new Error('No response from Gemini');
	}

	let resultBase64: string | null = null;
	for (const part of candidate.content.parts) {
		if ((part as any).inlineData?.mimeType?.startsWith('image/')) {
			resultBase64 = (part as any).inlineData.data;
			break;
		}
	}

	if (!resultBase64) {
		throw new Error('Gemini did not return an image');
	}

	// Save enhanced image to disk
	const enhancedBuffer = Buffer.from(resultBase64, 'base64');
	fs.writeFileSync(record.filePath, enhancedBuffer);

	// Update DB record
	db.updateThumbnail(thumbnailId, { aiEnhanced: true });
	const updated = db.loadThumbnail(thumbnailId)!;

	return { pngBase64: resultBase64, thumbnailRecord: updated };
}

/**
 * Run a Nano Banana 2 (Gemini 3.1 Flash Image) edit pass on a raw PNG.
 * Takes a base64 PNG + prompt, returns a base64 PNG result.
 * This is stateless — does not read/write thumbnails on disk.
 */
export async function aiEditImage(
	pngBase64: string,
	prompt: string
): Promise<string> {
	const apiKey = process.env.GOOGLE_GENAI_API_KEY;
	if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY not configured');

	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey });

	console.log('[aiEditImage] Sending request to gemini-3.1-flash-image-preview, prompt:', prompt.slice(0, 80));

	const response = await ai.models.generateContent({
		model: 'gemini-3.1-flash-image-preview',
		contents: [
			{
				role: 'user',
				parts: [
					{ text: prompt },
					{ inlineData: { mimeType: 'image/png', data: pngBase64 } }
				]
			}
		],
		config: {
			responseModalities: ['TEXT', 'IMAGE']
		}
	});

	console.log('[aiEditImage] Got response, candidates:', response.candidates?.length);

	const candidate = response.candidates?.[0];
	if (!candidate?.content?.parts) {
		console.error('[aiEditImage] No parts in response. Candidate:', JSON.stringify(candidate, null, 2).slice(0, 500));
		throw new Error('No response from Nano Banana 2');
	}

	console.log('[aiEditImage] Parts count:', candidate.content.parts.length,
		'types:', candidate.content.parts.map((p: any) => p.text ? 'text' : p.inlineData?.mimeType ?? 'unknown'));

	for (const part of candidate.content.parts) {
		if ((part as any).inlineData?.mimeType?.startsWith('image/')) {
			const data = (part as any).inlineData.data;
			console.log('[aiEditImage] Got image, base64 length:', data.length);
			return data;
		}
	}

	throw new Error('Nano Banana 2 did not return an image');
}
