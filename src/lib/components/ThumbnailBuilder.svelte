<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ThumbnailFramePicker from './ThumbnailFramePicker.svelte';
	import ThumbnailLayerPanel from './ThumbnailLayerPanel.svelte';
	import ThumbnailAIPanel from './ThumbnailAIPanel.svelte';
	import {
		saveThumbnailCmd,
		getThumbnailByExportCmd,
		isAIConfiguredCmd,
		aiEditImageCmd
	} from '$lib/streams.remote';

	interface TextLayer {
		id: string;
		type: 'text';
		text: string;
		x: number;
		y: number;
		fontSize: number;
		fontFamily: string;
		color: string;
		strokeColor?: string;
		strokeWidth?: number;
		rotation?: number;
		scaleX?: number;
		scaleY?: number;
		locked?: boolean;
		cropX?: number;          // 0-1, crop region left
		cropY?: number;          // 0-1, crop region top
		cropW?: number;          // 0-1, crop region width
		cropH?: number;          // 0-1, crop region height
		shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
	}

	interface ImageLayer {
		id: string;
		type: 'image';
		x: number;
		y: number;
		rotation?: number;
		scaleX?: number;
		scaleY?: number;
		opacity?: number;
		locked?: boolean;
		cropX?: number;
		cropY?: number;
		cropW?: number;
		cropH?: number;
		streamId?: string;
		timestamp?: number;
		dataUrl?: string;
		naturalWidth: number;
		naturalHeight: number;
	}

	interface EffectLayer {
		id: string;
		type: 'effect';
		kind: 'blur' | 'ai';
		blurRadius?: number;
		prompt?: string;
		aiResultBase64?: string;
		locked?: boolean;
	}

	type Layer = TextLayer | ImageLayer | EffectLayer;

	// Canvas dimensions
	const WIDTH = 1280;
	const HEIGHT = 720;
	const GIZMO_HANDLE_RADIUS = 8;
	const GIZMO_STEM_LENGTH = 40;
	const SCALE_HANDLE_SIZE = 7; // half-size of square scale handles

	type ScaleHandleType = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r';

	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let overlayEl = $state<HTMLCanvasElement | null>(null);
	let layers = $state<Layer[]>([]);
	let imageElements = $state(new Map<string, HTMLImageElement>());
	let currentExportId = $state<string | null>(null);
	let saving = $state(false);
	let saveMessage = $state<string | null>(null);
	let existingThumbnailId = $state<string | null>(null);
	let aiConfigured = $state(false);

	// Selection & drag state
	let selectedLayerIndex = $state<number | null>(null);
	let draggingLayerIndex = $state<number | null>(null);
	let dragOffset = { x: 0, y: 0 };
	let rotatingLayerIndex = $state<number | null>(null);
	let rotationStartAngle = 0;
	let rotationStartValue = 0;

	// Scale drag state
	let scalingLayerIndex = $state<number | null>(null);
	let scalingHandle = $state<ScaleHandleType | null>(null);
	let scaleStartMouse = { x: 0, y: 0 };
	let scaleStartValues = { scaleX: 1, scaleY: 1 };
	let cropStartValues = { cropX: 0, cropY: 0, cropW: 1, cropH: 1 };
	let positionStart = { x: 0, y: 0 };

	// AI effect layer cached result images (keyed by layer id)
	let aiEffectImages = $state(new Map<string, HTMLImageElement>());
	let aiEffectGenerating = $state(new Set<string>());

	// AI enhanced image (replaces canvas background when AI result is active)
	let aiImageUrl = $state<string | null>(null);
	let aiImageEl = $state<HTMLImageElement | null>(null);
	let preAiLayers = $state<Layer[] | null>(null);

	let preselectedExportId = $derived(page.url.searchParams.get('export'));

	// Redraw canvas whenever state changes
	$effect(() => {
		// Track dependencies
		const _aiImg = aiImageEl;
		const _layers = layers;
		const _canvas = canvasEl;
		const _overlay = overlayEl;
		const _sel = selectedLayerIndex;
		const _rot = rotatingLayerIndex;
		const _scl = scalingLayerIndex;
		const _imgs = imageElements;
		if (_canvas) drawCanvas();
		if (_overlay) drawOverlay();
	});

	onMount(async () => {
		try {
			const { configured } = await isAIConfiguredCmd();
			aiConfigured = configured;
		} catch { /* ignore */ }
	});

	function drawCanvas() {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		ctx.clearRect(0, 0, WIDTH, HEIGHT);

		// Draw background: AI image > dark fill
		if (aiImageEl && aiImageEl.complete && aiImageEl.naturalWidth > 0) {
			ctx.drawImage(aiImageEl, 0, 0, WIDTH, HEIGHT);
		} else {
			ctx.fillStyle = '#111';
			ctx.fillRect(0, 0, WIDTH, HEIGHT);
			if (layers.length === 0) {
				ctx.fillStyle = '#555';
				ctx.font = '24px Arial';
				ctx.textAlign = 'center';
				ctx.fillText('Add a frame or text layer to get started', WIDTH / 2, HEIGHT / 2);
				ctx.textAlign = 'start';
			}
		}

		// Draw all layers in order
		for (const layer of layers) {
			if (layer.type === 'text') {
				drawTextLayerContent(ctx, layer);
			} else if (layer.type === 'image') {
				drawImageLayerContent(ctx, layer);
			} else if (layer.type === 'effect') {
				applyEffectLayer(ctx, layer);
			}
		}
	}

	function applyEffectLayer(ctx: CanvasRenderingContext2D, layer: EffectLayer) {
		if (layer.kind === 'blur') {
			const radius = layer.blurRadius ?? 8;
			// Snapshot current canvas, clear, redraw with blur filter
			const tempCanvas = new OffscreenCanvas(WIDTH, HEIGHT);
			const tempCtx = tempCanvas.getContext('2d')!;
			tempCtx.drawImage(canvasEl!, 0, 0);
			ctx.clearRect(0, 0, WIDTH, HEIGHT);
			ctx.filter = `blur(${radius}px)`;
			ctx.drawImage(tempCanvas, 0, 0);
			ctx.filter = 'none';
		} else if (layer.kind === 'ai') {
			// Draw cached AI result if available
			const cachedImg = aiEffectImages.get(layer.id);
			if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
				ctx.clearRect(0, 0, WIDTH, HEIGHT);
				ctx.drawImage(cachedImg, 0, 0, WIDTH, HEIGHT);
			}
			// If generating, show a subtle overlay hint
			if (aiEffectGenerating.has(layer.id)) {
				ctx.save();
				ctx.fillStyle = 'rgba(124, 58, 237, 0.15)';
				ctx.fillRect(0, 0, WIDTH, HEIGHT);
				ctx.fillStyle = '#fff';
				ctx.font = '20px Arial';
				ctx.textAlign = 'center';
				ctx.fillText('Generating AI edit...', WIDTH / 2, HEIGHT / 2);
				ctx.textAlign = 'start';
				ctx.restore();
			}
		}
	}

	/** Check if a layer has a non-default crop. */
	function hasCrop(layer: TextLayer | ImageLayer): boolean {
		return (layer.cropX != null && layer.cropX > 0)
			|| (layer.cropY != null && layer.cropY > 0)
			|| (layer.cropW != null && layer.cropW < 1)
			|| (layer.cropH != null && layer.cropH < 1);
	}

	/** Compute the content drawing offset needed to center the crop region at origin. */
	function getCropOffset(halfW: number, halfH: number, layer: TextLayer | ImageLayer): { dx: number; dy: number } {
		const fullW = halfW * 2;
		const fullH = halfH * 2;
		const cx = layer.cropX ?? 0;
		const cy = layer.cropY ?? 0;
		const cw = layer.cropW ?? 1;
		const ch = layer.cropH ?? 1;
		return {
			dx: (0.5 - cx - cw / 2) * fullW,
			dy: (0.5 - cy - ch / 2) * fullH
		};
	}

	/** Apply a layer's crop as a clip region centered at origin in local space. */
	function applyCropClip(ctx: CanvasRenderingContext2D, halfW: number, halfH: number, layer: TextLayer | ImageLayer) {
		const cw = layer.cropW ?? 1;
		const ch = layer.cropH ?? 1;
		const croppedHalfW = halfW * cw;
		const croppedHalfH = halfH * ch;
		ctx.beginPath();
		ctx.rect(-croppedHalfW, -croppedHalfH, croppedHalfW * 2, croppedHalfH * 2);
		ctx.clip();
	}

	function drawTextLayerContent(ctx: CanvasRenderingContext2D, layer: TextLayer) {
		const x = layer.x * WIDTH;
		const y = layer.y * HEIGHT;

		ctx.save();
		ctx.translate(x, y);
		if (layer.rotation) {
			ctx.rotate((layer.rotation * Math.PI) / 180);
		}
		const sx = layer.scaleX ?? 1;
		const sy = layer.scaleY ?? 1;
		if (sx !== 1 || sy !== 1) {
			ctx.scale(sx, sy);
		}

		// Apply crop: clip centered at origin, then offset content
		const cropped = hasCrop(layer);
		let cropDx = 0, cropDy = 0;
		if (cropped) {
			const bounds = getLayerBounds(ctx, layer, false, false); // uncropped
			applyCropClip(ctx, bounds.halfW, bounds.halfH, layer);
			const offset = getCropOffset(bounds.halfW, bounds.halfH, layer);
			cropDx = offset.dx;
			cropDy = offset.dy;
		}

		ctx.font = `bold ${layer.fontSize}px "${layer.fontFamily}"`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		// Shadow
		if (layer.shadow) {
			ctx.shadowColor = layer.shadow.color;
			ctx.shadowBlur = layer.shadow.blur;
			ctx.shadowOffsetX = layer.shadow.offsetX;
			ctx.shadowOffsetY = layer.shadow.offsetY;
		}

		const lines = layer.text.split('\n');
		const lineHeight = layer.fontSize * 1.2;
		const totalH = lineHeight * lines.length;
		const startY = -(totalH - lineHeight) / 2;

		for (let li = 0; li < lines.length; li++) {
			const ly = startY + li * lineHeight;

			// Stroke
			if (layer.strokeWidth && layer.strokeColor) {
				ctx.strokeStyle = layer.strokeColor;
				ctx.lineWidth = layer.strokeWidth;
				ctx.lineJoin = 'round';
				ctx.strokeText(lines[li], cropDx, ly + cropDy);
			}

			// Fill
			ctx.fillStyle = layer.color;
			ctx.fillText(lines[li], cropDx, ly + cropDy);
		}

		ctx.restore();
	}

	function drawImageLayerContent(ctx: CanvasRenderingContext2D, layer: ImageLayer) {
		const img = imageElements.get(layer.id);
		if (!img || !img.complete || img.naturalWidth === 0) return;

		const x = layer.x * WIDTH;
		const y = layer.y * HEIGHT;

		ctx.save();
		ctx.translate(x, y);
		if (layer.rotation) {
			ctx.rotate((layer.rotation * Math.PI) / 180);
		}
		const sx = layer.scaleX ?? 1;
		const sy = layer.scaleY ?? 1;
		if (sx !== 1 || sy !== 1) {
			ctx.scale(sx, sy);
		}
		ctx.globalAlpha = layer.opacity ?? 1;

		// Apply crop: clip centered at origin, then offset content
		let cropDx = 0, cropDy = 0;
		if (hasCrop(layer)) {
			const halfW = layer.naturalWidth / 2;
			const halfH = layer.naturalHeight / 2;
			applyCropClip(ctx, halfW, halfH, layer);
			const offset = getCropOffset(halfW, halfH, layer);
			cropDx = offset.dx;
			cropDy = offset.dy;
		}

		// Draw centered (offset by crop)
		ctx.drawImage(img, -layer.naturalWidth / 2 + cropDx, -layer.naturalHeight / 2 + cropDy, layer.naturalWidth, layer.naturalHeight);

		ctx.restore();
	}

	/** Get the bounding half-sizes for a layer (needs a canvas context for measureText on text layers).
	 *  When scaled=true, returns dimensions with scale applied (for overlay/hit testing).
	 *  When scaled=false, returns unscaled dimensions (for local-space operations). */
	/** Get the bounding half-sizes for a layer.
	 *  scaled=true: with scale applied (for overlay/hit testing).
	 *  scaled=false: unscaled dimensions (for local-space operations).
	 *  cropped=true: dimensions reflect the crop region. */
	function getLayerBounds(ctx: CanvasRenderingContext2D, layer: TextLayer | ImageLayer, scaled = true, cropped = true): { halfW: number; halfH: number } {
		if (layer.type === 'text') {
			ctx.font = `bold ${layer.fontSize}px "${layer.fontFamily}"`;
			const lines = layer.text.split('\n');
			let maxWidth = 0;
			for (const line of lines) {
				const w = ctx.measureText(line).width;
				if (w > maxWidth) maxWidth = w;
			}
			let halfW = maxWidth / 2;
			let halfH = (lines.length * layer.fontSize * 1.2) / 2;
			if (cropped) {
				halfW *= (layer.cropW ?? 1);
				halfH *= (layer.cropH ?? 1);
			}
			if (scaled) {
				halfW *= Math.abs(layer.scaleX ?? 1);
				halfH *= Math.abs(layer.scaleY ?? 1);
			}
			return { halfW, halfH };
		} else {
			let halfW = layer.naturalWidth / 2;
			let halfH = layer.naturalHeight / 2;
			if (cropped) {
				halfW *= (layer.cropW ?? 1);
				halfH *= (layer.cropH ?? 1);
			}
			if (scaled) {
				halfW *= Math.abs(layer.scaleX ?? 1);
				halfH *= Math.abs(layer.scaleY ?? 1);
			}
			return { halfW, halfH };
		}
	}

	/** Get the rotation handle position in canvas-space for a layer. */
	function getRotationHandlePos(layer: TextLayer | ImageLayer, halfH: number): { hx: number; hy: number } {
		const cx = layer.x * WIDTH;
		const cy = layer.y * HEIGHT;
		const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
		const localY = -(halfH + GIZMO_STEM_LENGTH);
		const hx = cx - localY * Math.sin(rad);
		const hy = cy + localY * Math.cos(rad);
		return { hx, hy };
	}

	/** Get scale handle positions in local space (before rotation). */
	function getScaleHandlePositions(halfW: number, halfH: number): { type: ScaleHandleType; lx: number; ly: number }[] {
		const pad = 4;
		const w = halfW + pad;
		const h = halfH + pad;
		return [
			{ type: 'tl', lx: -w, ly: -h },
			{ type: 'tr', lx: w, ly: -h },
			{ type: 'bl', lx: -w, ly: h },
			{ type: 'br', lx: w, ly: h },
			{ type: 't', lx: 0, ly: -h },
			{ type: 'b', lx: 0, ly: h },
			{ type: 'l', lx: -w, ly: 0 },
			{ type: 'r', lx: w, ly: 0 }
		];
	}

	/** Transform a local-space point into canvas-space given layer center + rotation. */
	function localToCanvas(lx: number, ly: number, cx: number, cy: number, rad: number): { x: number; y: number } {
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		return {
			x: cx + lx * cos - ly * sin,
			y: cy + lx * sin + ly * cos
		};
	}

	/** Hit-test scale handles. Returns the handle type or null. */
	function hitTestScaleHandles(px: number, py: number): ScaleHandleType | null {
		if (selectedLayerIndex === null || !canvasEl) return null;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return null;
		const layer = layers[selectedLayerIndex];
		if (!layer || layer.type === 'effect') return null;

		const { halfW, halfH } = getLayerBounds(ctx, layer);
		const cx = layer.x * WIDTH;
		const cy = layer.y * HEIGHT;
		const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
		const handles = getScaleHandlePositions(halfW, halfH);
		const hitDist = SCALE_HANDLE_SIZE + 4;

		for (const h of handles) {
			const { x, y } = localToCanvas(h.lx, h.ly, cx, cy, rad);
			if (Math.abs(px - x) <= hitDist && Math.abs(py - y) <= hitDist) {
				return h.type;
			}
		}
		return null;
	}

	/** Get CSS cursor for a scale handle type, accounting for rotation. */
	function getScaleHandleCursor(handleType: ScaleHandleType, rotationDeg: number): string {
		const baseAngles: Record<ScaleHandleType, number> = {
			'tr': 0, 'r': 45, 'br': 90, 'b': 135,
			'bl': 180, 'l': 225, 'tl': 270, 't': 315
		};
		const cursors = ['nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize'];
		const angle = ((baseAngles[handleType] + rotationDeg) % 360 + 360) % 360;
		const idx = Math.round(angle / 45) % 4;
		return cursors[idx];
	}

	function drawOverlay() {
		if (!overlayEl) return;
		const ctx = overlayEl.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, WIDTH, HEIGHT);

		if (selectedLayerIndex === null || selectedLayerIndex >= layers.length) return;
		const layer = layers[selectedLayerIndex];
		// Effect layers have no spatial gizmo
		if (layer.type === 'effect') return;
		const cx = layer.x * WIDTH;
		const cy = layer.y * HEIGHT;
		const { halfW, halfH } = getLayerBounds(ctx, layer);
		const rad = ((layer.rotation ?? 0) * Math.PI) / 180;

		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate(rad);

		// Bounding box
		ctx.strokeStyle = '#7c3aed';
		ctx.lineWidth = 2;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(-halfW - 4, -halfH - 4, (halfW + 4) * 2, (halfH + 4) * 2);
		ctx.setLineDash([]);

		// Stem line from top-center of box to handle
		ctx.beginPath();
		ctx.moveTo(0, -halfH - 4);
		ctx.lineTo(0, -halfH - GIZMO_STEM_LENGTH);
		ctx.strokeStyle = '#7c3aed';
		ctx.lineWidth = 2;
		ctx.stroke();

		// Rotation handle circle
		ctx.beginPath();
		ctx.arc(0, -halfH - GIZMO_STEM_LENGTH, GIZMO_HANDLE_RADIUS, 0, Math.PI * 2);
		ctx.fillStyle = rotatingLayerIndex !== null ? '#a78bfa' : '#7c3aed';
		ctx.fill();
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 2;
		ctx.stroke();

		// Small rotation icon inside handle
		ctx.beginPath();
		ctx.arc(0, -halfH - GIZMO_STEM_LENGTH, 4, -Math.PI * 0.7, Math.PI * 0.4);
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 1.5;
		ctx.stroke();

		// Scale handles
		const handles = getScaleHandlePositions(halfW, halfH);
		for (const h of handles) {
			const isCorner = ['tl', 'tr', 'bl', 'br'].includes(h.type);
			const isActive = scalingHandle === h.type;
			ctx.fillStyle = isActive ? '#a78bfa' : (isCorner ? '#3b82f6' : '#22d3ee');
			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 1.5;
			ctx.fillRect(h.lx - SCALE_HANDLE_SIZE, h.ly - SCALE_HANDLE_SIZE, SCALE_HANDLE_SIZE * 2, SCALE_HANDLE_SIZE * 2);
			ctx.strokeRect(h.lx - SCALE_HANDLE_SIZE, h.ly - SCALE_HANDLE_SIZE, SCALE_HANDLE_SIZE * 2, SCALE_HANDLE_SIZE * 2);
		}

		ctx.restore();
	}

	async function generateAIEffect(layerIndex: number) {
		const layer = layers[layerIndex];
		if (!layer || layer.type !== 'effect' || layer.kind !== 'ai') return;
		if (!layer.prompt?.trim()) return;
		if (!canvasEl) return;

		// Composite everything below this layer into a PNG
		const tempCanvas = new OffscreenCanvas(WIDTH, HEIGHT);
		const tempCtx = tempCanvas.getContext('2d')!;

		// Draw background
		if (aiImageEl && aiImageEl.complete && aiImageEl.naturalWidth > 0) {
			tempCtx.drawImage(aiImageEl, 0, 0, WIDTH, HEIGHT);
		} else {
			tempCtx.fillStyle = '#111';
			tempCtx.fillRect(0, 0, WIDTH, HEIGHT);
		}

		// Draw all layers below this one
		const ctx2d = tempCtx as unknown as CanvasRenderingContext2D;
		for (let i = 0; i < layerIndex; i++) {
			const l = layers[i];
			if (l.type === 'text') {
				drawTextLayerContent(ctx2d, l);
			} else if (l.type === 'image') {
				drawImageLayerContent(ctx2d, l);
			} else if (l.type === 'effect') {
				if (l.kind === 'blur') {
					const radius = l.blurRadius ?? 8;
					const snap = new OffscreenCanvas(WIDTH, HEIGHT);
					const snapCtx = snap.getContext('2d')!;
					snapCtx.drawImage(tempCanvas, 0, 0);
					tempCtx.clearRect(0, 0, WIDTH, HEIGHT);
					tempCtx.filter = `blur(${radius}px)`;
					tempCtx.drawImage(snap, 0, 0);
					tempCtx.filter = 'none';
				} else if (l.kind === 'ai') {
					const cachedImg = aiEffectImages.get(l.id);
					if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
						tempCtx.clearRect(0, 0, WIDTH, HEIGHT);
						tempCtx.drawImage(cachedImg, 0, 0, WIDTH, HEIGHT);
					}
				}
			}
		}

		// Export to base64 PNG
		const blob = await tempCanvas.convertToBlob({ type: 'image/png' });
		const buffer = await blob.arrayBuffer();
		const pngBase64 = btoa(
			new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), '')
		);

		// Mark as generating
		aiEffectGenerating = new Set([...aiEffectGenerating, layer.id]);

		try {
			const { pngBase64: resultBase64 } = await aiEditImageCmd({
				pngBase64,
				prompt: layer.prompt
			});

			// Cache the result as an HTMLImageElement
			const img = new Image();
			img.onload = () => {
				const newMap = new Map(aiEffectImages);
				newMap.set(layer.id, img);
				aiEffectImages = newMap;
				// Store the base64 on the layer for persistence
				layers = layers.map((l, i) =>
					i === layerIndex ? { ...l, aiResultBase64: resultBase64 } : l
				);
			};
			img.src = `data:image/png;base64,${resultBase64}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error('AI effect generation failed:', msg);
			saveMessage = `AI Error: ${msg}`;
			setTimeout(() => { saveMessage = null; }, 8000);
		} finally {
			const newSet = new Set(aiEffectGenerating);
			newSet.delete(layer.id);
			aiEffectGenerating = newSet;
		}
	}

	function handleFrameSelected(blobUrl: string, streamId: string, timestamp: number) {
		// Load image to get natural dimensions, then create image layer
		const img = new Image();
		img.onload = () => {
			const nw = img.naturalWidth;
			const nh = img.naturalHeight;
			// Default scale to fill the canvas
			const scaleToFill = Math.max(WIDTH / nw, HEIGHT / nh);
			const id = crypto.randomUUID().slice(0, 8);
			const newLayer: ImageLayer = {
				id,
				type: 'image',
				x: 0.5,
				y: 0.5,
				scaleX: Math.round(scaleToFill * 100) / 100,
				scaleY: Math.round(scaleToFill * 100) / 100,
				opacity: 1,
				streamId,
				timestamp,
				naturalWidth: nw,
				naturalHeight: nh
			};
			const newMap = new Map(imageElements);
			newMap.set(id, img);
			imageElements = newMap;
			layers = [...layers, newLayer];
			selectedLayerIndex = layers.length - 1;
		};
		img.src = blobUrl;
	}

	function handleExportSelected(exportId: string) {
		if (exportId !== currentExportId) {
			currentExportId = exportId;
			loadExistingThumbnail(exportId);
		}
	}

	async function loadExistingThumbnail(exportId: string) {
		try {
			const { thumbnail } = await getThumbnailByExportCmd({ exportId });
			if (thumbnail) {
				existingThumbnailId = thumbnail.id;
				if (thumbnail.layers) {
					layers = thumbnail.layers;
					// Re-hydrate image layers and AI effect cached results
					for (const layer of layers) {
						if (layer.type === 'image') {
							rehydrateImageLayer(layer);
						} else if (layer.type === 'effect' && layer.kind === 'ai' && layer.aiResultBase64) {
							rehydrateAIEffect(layer);
						}
					}
				}
			} else {
				existingThumbnailId = null;
			}
		} catch { /* ignore */ }
	}

	async function rehydrateImageLayer(layer: ImageLayer) {
		try {
			let src: string;
			if (layer.dataUrl) {
				// Pasted/imported image — load directly from stored data URL
				src = layer.dataUrl;
			} else if (layer.streamId != null && layer.timestamp != null) {
				// Stream frame — fetch from API
				const res = await fetch(`/api/frame/${layer.streamId}?t=${layer.timestamp.toFixed(3)}`);
				if (!res.ok) return;
				const blob = await res.blob();
				src = URL.createObjectURL(blob);
			} else {
				return;
			}
			const img = new Image();
			img.onload = () => {
				const newMap = new Map(imageElements);
				newMap.set(layer.id, img);
				imageElements = newMap;
			};
			img.src = src;
		} catch {
			console.error(`Failed to rehydrate image layer ${layer.id}`);
		}
	}

	function rehydrateAIEffect(layer: EffectLayer) {
		if (!layer.aiResultBase64) return;
		const img = new Image();
		img.onload = () => {
			const newMap = new Map(aiEffectImages);
			newMap.set(layer.id, img);
			aiEffectImages = newMap;
		};
		img.src = `data:image/png;base64,${layer.aiResultBase64}`;
	}

	function handleLayersChange(newLayers: Layer[]) {
		// Clone image elements for duplicated image layers
		const newImageLayers = newLayers.filter((l): l is ImageLayer => l.type === 'image');
		for (const nl of newImageLayers) {
			if (!imageElements.has(nl.id)) {
				// Find an existing image element from a layer with matching source
				for (const [id, img] of imageElements) {
					const srcLayer = layers.find((l) => l.id === id && l.type === 'image') as ImageLayer | undefined;
					if (srcLayer && (
						(nl.dataUrl && nl.dataUrl === srcLayer.dataUrl) ||
						(nl.streamId != null && nl.streamId === srcLayer.streamId && nl.timestamp === srcLayer.timestamp)
					)) {
						const newMap = new Map(imageElements);
						newMap.set(nl.id, img);
						imageElements = newMap;
						break;
					}
				}
			}
		}

		// Clean up removed image layers
		const newIds = new Set(newImageLayers.map((l) => l.id));
		const oldIds = layers.filter((l) => l.type === 'image').map((l) => l.id);
		for (const id of oldIds) {
			if (!newIds.has(id)) {
				const img = imageElements.get(id);
				if (img?.src?.startsWith('blob:')) {
					URL.revokeObjectURL(img.src);
				}
				const newMap = new Map(imageElements);
				newMap.delete(id);
				imageElements = newMap;
			}
		}

		// Clean up removed AI effect layers
		const newAiIds = new Set(newLayers.filter((l) => l.type === 'effect' && l.kind === 'ai').map((l) => l.id));
		for (const [id] of aiEffectImages) {
			if (!newAiIds.has(id)) {
				const newMap = new Map(aiEffectImages);
				newMap.delete(id);
				aiEffectImages = newMap;
			}
		}

		if (selectedLayerIndex !== null && selectedLayerIndex >= newLayers.length) {
			selectedLayerIndex = null;
		}
		layers = newLayers;
	}

	function handleSelectLayer(index: number | null) {
		selectedLayerIndex = index;
	}

	// --- Canvas mouse interaction ---

	function getCanvasScale(): { scaleX: number; scaleY: number } {
		if (!canvasEl) return { scaleX: 1, scaleY: 1 };
		const rect = canvasEl.getBoundingClientRect();
		return { scaleX: WIDTH / rect.width, scaleY: HEIGHT / rect.height };
	}

	function canvasCoords(e: MouseEvent): { px: number; py: number } {
		const { scaleX, scaleY } = getCanvasScale();
		const rect = canvasEl!.getBoundingClientRect();
		return {
			px: (e.clientX - rect.left) * scaleX,
			py: (e.clientY - rect.top) * scaleY
		};
	}

	function hitTestRotationHandle(px: number, py: number): boolean {
		if (selectedLayerIndex === null || !canvasEl) return false;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return false;
		const layer = layers[selectedLayerIndex];
		if (!layer || layer.type === 'effect') return false;
		const { halfH } = getLayerBounds(ctx, layer);
		const { hx, hy } = getRotationHandlePos(layer, halfH);
		const dx = px - hx;
		const dy = py - hy;
		return dx * dx + dy * dy <= (GIZMO_HANDLE_RADIUS + 4) ** 2;
	}

	function hitTestLayers(px: number, py: number): number | null {
		if (!canvasEl) return null;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return null;

		for (let i = layers.length - 1; i >= 0; i--) {
			const layer = layers[i];
			// Effect layers have no spatial bounds — skip; locked layers are unselectable
			if (layer.type === 'effect') continue;
			if (layer.locked) continue;
			const lCx = layer.x * WIDTH;
			const lCy = layer.y * HEIGHT;
			const { halfW, halfH } = getLayerBounds(ctx, layer, true);

			let lx = px - lCx;
			let ly = py - lCy;
			if (layer.rotation) {
				const rad = -(layer.rotation * Math.PI) / 180;
				const cos = Math.cos(rad);
				const sin = Math.sin(rad);
				const rx = lx * cos - ly * sin;
				const ry = lx * sin + ly * cos;
				lx = rx;
				ly = ry;
			}

			if (lx >= -halfW && lx <= halfW && ly >= -halfH && ly <= halfH) {
				return i;
			}
		}
		return null;
	}

	function handleCanvasMouseDown(e: MouseEvent) {
		if (!canvasEl) return;
		const { px, py } = canvasCoords(e);

		// 1. Check scale handles first (never matches effect layers)
		const scaleHit = hitTestScaleHandles(px, py);
		if (scaleHit) {
			const layer = layers[selectedLayerIndex!] as TextLayer | ImageLayer;
			scalingLayerIndex = selectedLayerIndex;
			scalingHandle = scaleHit;
			scaleStartMouse = { x: px, y: py };
			scaleStartValues = { scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1 };
			cropStartValues = { cropX: layer.cropX ?? 0, cropY: layer.cropY ?? 0, cropW: layer.cropW ?? 1, cropH: layer.cropH ?? 1 };
			positionStart = { x: layer.x, y: layer.y };
			e.preventDefault();
			return;
		}

		// 2. Check rotation handle (never matches effect layers)
		if (hitTestRotationHandle(px, py)) {
			const layer = layers[selectedLayerIndex!] as TextLayer | ImageLayer;
			const cx = layer.x * WIDTH;
			const cy = layer.y * HEIGHT;
			rotatingLayerIndex = selectedLayerIndex;
			rotationStartAngle = Math.atan2(py - cy, px - cx);
			rotationStartValue = layer.rotation ?? 0;
			e.preventDefault();
			return;
		}

		// 3. Check layer hit (never matches effect layers)
		const hitIndex = hitTestLayers(px, py);
		if (hitIndex !== null) {
			const layer = layers[hitIndex] as TextLayer | ImageLayer;
			selectedLayerIndex = hitIndex;
			draggingLayerIndex = hitIndex;
			dragOffset = {
				x: px - layer.x * WIDTH,
				y: py - layer.y * HEIGHT
			};
			e.preventDefault();
		} else {
			selectedLayerIndex = null;
		}
	}

	function handleCanvasMouseMove(e: MouseEvent) {
		if (!canvasEl) return;
		const { px, py } = canvasCoords(e);

		// Scale or crop drag (only for text/image layers)
		if (scalingLayerIndex !== null && scalingHandle !== null) {
			const layer = layers[scalingLayerIndex] as TextLayer | ImageLayer;
			const rad = -((layer.rotation ?? 0) * Math.PI) / 180;
			const cos = Math.cos(rad);
			const sin = Math.sin(rad);

			const dx = px - scaleStartMouse.x;
			const dy = py - scaleStartMouse.y;
			const localDx = dx * cos - dy * sin;
			const localDy = dx * sin + dy * cos;

			const ctx = canvasEl.getContext('2d')!;
			const { halfW, halfH } = getLayerBounds(ctx, layer, false, false); // uncropped, unscaled
			const sensX = Math.max(halfW, 40);
			const sensY = Math.max(halfH, 20);

			if (e.shiftKey) {
				// Shift held: crop mode
				let newCropX = cropStartValues.cropX;
				let newCropY = cropStartValues.cropY;
				let newCropW = cropStartValues.cropW;
				let newCropH = cropStartValues.cropH;

				const sx = layer.scaleX ?? 1;
				const sy = layer.scaleY ?? 1;
				// Convert canvas-space delta to fraction of full content
				const fracDx = localDx / (sensX * 2 * sx);
				const fracDy = localDy / (sensY * 2 * sy);

				const isLeft = scalingHandle === 'l' || scalingHandle === 'tl' || scalingHandle === 'bl';
				const isRight = scalingHandle === 'r' || scalingHandle === 'tr' || scalingHandle === 'br';
				const isTop = scalingHandle === 't' || scalingHandle === 'tl' || scalingHandle === 'tr';
				const isBottom = scalingHandle === 'b' || scalingHandle === 'bl' || scalingHandle === 'br';

				if (isLeft) {
					newCropX = cropStartValues.cropX + fracDx;
					newCropW = cropStartValues.cropW - fracDx;
				} else if (isRight) {
					newCropW = cropStartValues.cropW + fracDx;
				}
				if (isTop) {
					newCropY = cropStartValues.cropY + fracDy;
					newCropH = cropStartValues.cropH - fracDy;
				} else if (isBottom) {
					newCropH = cropStartValues.cropH + fracDy;
				}

				// Clamp values
				newCropX = Math.max(0, Math.min(0.95, Math.round(newCropX * 100) / 100));
				newCropY = Math.max(0, Math.min(0.95, Math.round(newCropY * 100) / 100));
				newCropW = Math.max(0.05, Math.min(1 - newCropX, Math.round(newCropW * 100) / 100));
				newCropH = Math.max(0.05, Math.min(1 - newCropY, Math.round(newCropH * 100) / 100));

				// Compensate layer position so the opposite edge stays fixed.
				// The visible half-size in content pixels changes; we offset the
				// layer center so the anchor edge doesn't move.
				const oldCHW = sensX * cropStartValues.cropW; // old cropped half-width (content px)
				const oldCHH = sensY * cropStartValues.cropH;
				const newCHW = sensX * newCropW;
				const newCHH = sensY * newCropH;
				// dW/dH: change in cropped half-size
				const dW = newCHW - oldCHW;
				const dH = newCHH - oldCHH;

				// Compensation in local space (content px, scaled)
				let compLX = 0, compLY = 0;
				if (isRight) compLX = dW * sx;   // right shrank → move center right to keep left fixed
				if (isLeft)  compLX = -dW * sx;  // left shrank → move center left to keep right fixed
				if (isBottom) compLY = dH * sy;
				if (isTop)    compLY = -dH * sy;

				// Rotate compensation into canvas space
				const rotRad = ((layer.rotation ?? 0) * Math.PI) / 180;
				const cosR = Math.cos(rotRad);
				const sinR = Math.sin(rotRad);
				const compCX = compLX * cosR - compLY * sinR;
				const compCY = compLX * sinR + compLY * cosR;

				const newX = positionStart.x + compCX / WIDTH;
				const newY = positionStart.y + compCY / HEIGHT;

				layers = layers.map((l, i) =>
					i === scalingLayerIndex ? { ...l, cropX: newCropX, cropY: newCropY, cropW: newCropW, cropH: newCropH, x: newX, y: newY } : l
				);
			} else {
				// Normal: scale mode
				let newScaleX = scaleStartValues.scaleX;
				let newScaleY = scaleStartValues.scaleY;

				const isCorner = ['tl', 'tr', 'bl', 'br'].includes(scalingHandle);
				if (isCorner) {
					const signX = (scalingHandle === 'tl' || scalingHandle === 'bl') ? -1 : 1;
					const signY = (scalingHandle === 'tl' || scalingHandle === 'tr') ? -1 : 1;
					const dProp = (localDx * signX / sensX + localDy * signY / sensY) / 2;
					newScaleX = scaleStartValues.scaleX + dProp;
					newScaleY = scaleStartValues.scaleY + dProp;
				} else {
					if (scalingHandle === 'l' || scalingHandle === 'r') {
						const sign = scalingHandle === 'l' ? -1 : 1;
						newScaleX = scaleStartValues.scaleX + (localDx * sign) / sensX;
					} else {
						const sign = scalingHandle === 't' ? -1 : 1;
						newScaleY = scaleStartValues.scaleY + (localDy * sign) / sensY;
					}
				}

				newScaleX = Math.max(0.1, Math.min(10, Math.round(newScaleX * 100) / 100));
				newScaleY = Math.max(0.1, Math.min(10, Math.round(newScaleY * 100) / 100));

				layers = layers.map((l, i) =>
					i === scalingLayerIndex ? { ...l, scaleX: newScaleX, scaleY: newScaleY } : l
				);
			}
			return;
		}

		// Rotation drag (only for text/image layers)
		if (rotatingLayerIndex !== null) {
			const layer = layers[rotatingLayerIndex] as TextLayer | ImageLayer;
			const cx = layer.x * WIDTH;
			const cy = layer.y * HEIGHT;
			const currentAngle = Math.atan2(py - cy, px - cx);
			let delta = ((currentAngle - rotationStartAngle) * 180) / Math.PI;
			let newRotation = rotationStartValue + delta;
			for (const snap of [0, 90, 180, -90, -180, 270, -270]) {
				if (Math.abs(newRotation - snap) < 3) {
					newRotation = snap;
					break;
				}
			}
			while (newRotation > 180) newRotation -= 360;
			while (newRotation < -180) newRotation += 360;
			layers = layers.map((l, i) =>
				i === rotatingLayerIndex ? { ...l, rotation: Math.round(newRotation) } : l
			);
			return;
		}

		// Position drag
		if (draggingLayerIndex !== null) {
			const nx = Math.max(0, Math.min(1, (px - dragOffset.x) / WIDTH));
			const ny = Math.max(0, Math.min(1, (py - dragOffset.y) / HEIGHT));
			layers = layers.map((l, i) =>
				i === draggingLayerIndex ? { ...l, x: nx, y: ny } : l
			);
			return;
		}

		// Cursor feedback
		const scaleHit = hitTestScaleHandles(px, py);
		if (scaleHit) {
			const layer = layers[selectedLayerIndex!] as TextLayer | ImageLayer;
			overlayEl!.style.cursor = getScaleHandleCursor(scaleHit, layer.rotation ?? 0);
		} else if (hitTestRotationHandle(px, py)) {
			overlayEl!.style.cursor = 'grab';
		} else if (hitTestLayers(px, py) !== null) {
			overlayEl!.style.cursor = 'move';
		} else {
			overlayEl!.style.cursor = 'default';
		}
	}

	function handleCanvasMouseUp() {
		draggingLayerIndex = null;
		rotatingLayerIndex = null;
		scalingLayerIndex = null;
		scalingHandle = null;
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape' && selectedLayerIndex !== null) {
			selectedLayerIndex = null;
			e.preventDefault();
			return;
		}
		if (e.key === 'Delete' && selectedLayerIndex !== null && selectedLayerIndex < layers.length) {
			const layer = layers[selectedLayerIndex];
			// Clean up image element if it's an image layer
			if (layer.type === 'image') {
				const img = imageElements.get(layer.id);
				if (img?.src?.startsWith('blob:')) {
					URL.revokeObjectURL(img.src);
				}
				const newMap = new Map(imageElements);
				newMap.delete(layer.id);
				imageElements = newMap;
			}
			// Clean up AI effect cached image
			if (layer.type === 'effect' && layer.kind === 'ai') {
				const newMap = new Map(aiEffectImages);
				newMap.delete(layer.id);
				aiEffectImages = newMap;
			}
			layers = layers.filter((_, i) => i !== selectedLayerIndex);
			selectedLayerIndex = null;
			e.preventDefault();
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (!item.type.startsWith('image/')) continue;
			const blob = item.getAsFile();
			if (!blob) continue;
			e.preventDefault();

			const blobUrl = URL.createObjectURL(blob);
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = reader.result as string;
				const img = new Image();
				img.onload = () => {
					const nw = img.naturalWidth;
					const nh = img.naturalHeight;
					const scaleToFill = Math.max(WIDTH / nw, HEIGHT / nh);
					const id = crypto.randomUUID().slice(0, 8);
					const newLayer: ImageLayer = {
						id,
						type: 'image',
						x: 0.5,
						y: 0.5,
						scaleX: Math.round(scaleToFill * 100) / 100,
						scaleY: Math.round(scaleToFill * 100) / 100,
						opacity: 1,
						dataUrl,
						naturalWidth: nw,
						naturalHeight: nh
					};
					const newMap = new Map(imageElements);
					newMap.set(id, img);
					imageElements = newMap;
					layers = [...layers, newLayer];
					selectedLayerIndex = layers.length - 1;
				};
				img.src = blobUrl;
			};
			reader.readAsDataURL(blob);
			break; // only handle first image
		}
	}

	// --- Save ---

	async function handleSave() {
		if (!canvasEl || !currentExportId) return;
		saving = true;
		saveMessage = null;

		try {
			const blob = await new Promise<Blob | null>((resolve) =>
				canvasEl!.toBlob(resolve, 'image/png')
			);
			if (!blob) throw new Error('Failed to create PNG');

			const buffer = await blob.arrayBuffer();
			const base64 = btoa(
				new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), '')
			);

			// Strip transient aiResultBase64 from AI effect layers before persisting
			const persistLayers = layers.length > 0
				? layers.map((l) => {
					if (l.type === 'effect' && l.kind === 'ai') {
						const { aiResultBase64: _, ...rest } = l;
						return rest;
					}
					return l;
				})
				: undefined;

			await saveThumbnailCmd({
				exportId: currentExportId,
				pngBase64: base64,
				width: WIDTH,
				height: HEIGHT,
				layers: persistLayers
			});

			saveMessage = 'Thumbnail saved!';
			setTimeout(() => { saveMessage = null; }, 3000);
		} catch (err) {
			saveMessage = `Error: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			saving = false;
		}
	}

	// --- AI integration ---

	function handleAIResult(pngBase64: string, thumbnailRecord: { id: string }) {
		existingThumbnailId = thumbnailRecord.id;
		if (!preAiLayers) {
			preAiLayers = [...layers];
		}

		const dataUrl = `data:image/png;base64,${pngBase64}`;
		if (aiImageUrl) URL.revokeObjectURL(aiImageUrl);
		aiImageUrl = dataUrl;
		const img = new Image();
		img.onload = () => {
			aiImageEl = img;
		};
		img.src = dataUrl;
	}

	function handleAIRevert() {
		aiImageUrl = null;
		aiImageEl = null;
		if (preAiLayers) {
			layers = preAiLayers;
			preAiLayers = null;
		}
	}
</script>

<div class="thumbnail-builder">
	<div class="builder-left">
		<ThumbnailFramePicker
			preselectedExportId={preselectedExportId}
			onFrameSelected={handleFrameSelected}
			onExportSelected={handleExportSelected}
		/>
	</div>

	<div class="builder-center">
		<div class="canvas-wrapper">
			<canvas
				bind:this={canvasEl}
				width={WIDTH}
				height={HEIGHT}
				class="thumbnail-canvas"
			></canvas>
			<!-- svelte-ignore a11y_positive_tabindex -->
			<canvas
				bind:this={overlayEl}
				width={WIDTH}
				height={HEIGHT}
				class="thumbnail-overlay"
				tabindex="1"
				onmousedown={handleCanvasMouseDown}
				onmousemove={handleCanvasMouseMove}
				onmouseup={handleCanvasMouseUp}
				onmouseleave={handleCanvasMouseUp}
				onkeydown={handleKeyDown}
				onpaste={handlePaste}
			></canvas>
		</div>
		<div class="canvas-actions">
			<button class="btn-save" onclick={handleSave} disabled={saving || !currentExportId}>
				{saving ? 'Saving...' : 'Save Thumbnail'}
			</button>
			{#if saveMessage}
				<span class="save-message" class:error={saveMessage.startsWith('Error')}>{saveMessage}</span>
			{/if}
		</div>

		{#if currentExportId && existingThumbnailId}
			<ThumbnailAIPanel
				thumbnailId={existingThumbnailId}
				{aiConfigured}
				onResult={handleAIResult}
				onRevert={handleAIRevert}
				hasAIImage={!!aiImageEl}
			/>
		{/if}
	</div>

	<div class="builder-right">
		<ThumbnailLayerPanel
			{layers}
			{selectedLayerIndex}
			onLayersChange={handleLayersChange}
			onSelectLayer={handleSelectLayer}
			onGenerateAI={generateAIEffect}
			aiGeneratingIds={aiEffectGenerating}
		/>
	</div>
</div>

<style>
	.thumbnail-builder {
		display: flex;
		gap: 16px;
		padding: 16px;
		height: 100%;
		overflow: hidden;
	}

	.builder-left {
		width: 220px;
		flex-shrink: 0;
		overflow-y: auto;
		padding-right: 8px;
	}

	.builder-center {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
		overflow-y: auto;
	}

	.builder-right {
		width: 260px;
		flex-shrink: 0;
		overflow-y: auto;
		padding-left: 8px;
	}

	.canvas-wrapper {
		background: #000;
		border-radius: 6px;
		overflow: hidden;
		position: relative;
	}

	.thumbnail-canvas {
		width: 100%;
		height: auto;
		display: block;
	}

	.thumbnail-overlay {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: auto;
		display: block;
		cursor: default;
		outline: none;
	}

	.canvas-actions {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.btn-save {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 8px 20px;
		border-radius: 6px;
		cursor: pointer;
	}

	.btn-save:hover:not(:disabled) {
		background: #6d28d9;
	}

	.btn-save:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.save-message {
		font-size: 0.7rem;
		color: #4ade80;
	}

	.save-message.error {
		color: #f87171;
	}
</style>
