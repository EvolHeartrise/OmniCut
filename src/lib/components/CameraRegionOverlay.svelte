<script lang="ts">
	/**
	 * Draggable/resizable rectangle overlay for marking a webcam region on video.
	 * All coordinates are normalized 0-1 relative to the actual video content area
	 * (accounting for object-fit: contain letterboxing).
	 */

	interface Props {
		videoEl: HTMLVideoElement | null;
		camX?: number;
		camY?: number;
		camW?: number;
		camH?: number;
		active: boolean;
		onchange: (region: { camX: number; camY: number; camW: number; camH: number }) => void;
		onsave?: (region: { camX: number; camY: number; camW: number; camH: number }) => void;
	}

	let { videoEl, camX, camY, camW, camH, active, onchange, onsave }: Props = $props();

	let overlayEl = $state<HTMLDivElement | null>(null);

	// Video content rect (the actual displayed pixels, excluding letterbox bars)
	let contentRect = $state({ x: 0, y: 0, w: 0, h: 0 });

	// Interaction state
	let mode = $state<'idle' | 'drawing' | 'moving' | 'resizing'>('idle');
	let resizeHandle = $state<string>('');
	let dragStart = $state({ mx: 0, my: 0, rx: 0, ry: 0, rw: 0, rh: 0 });

	// Compute the actual video content rect (accounting for object-fit: contain).
	// The overlay covers the full parent container (which may include controls),
	// so we base the calculation on the video element's actual rendered rect,
	// then offset relative to the overlay.
	function computeContentRect() {
		if (!videoEl || !overlayEl) return;
		const overlayRect = overlayEl.getBoundingClientRect();
		const videoRect = videoEl.getBoundingClientRect();
		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0) {
			contentRect = { x: 0, y: 0, w: videoRect.width, h: videoRect.height };
			return;
		}
		// Compute where the video content sits within the <video> element (object-fit: contain)
		const videoElAR = videoRect.width / videoRect.height;
		const videoAR = vw / vh;
		let w: number, h: number, cx: number, cy: number;
		if (videoAR > videoElAR) {
			// Video wider than element → bars top/bottom
			w = videoRect.width;
			h = videoRect.width / videoAR;
			cx = 0;
			cy = (videoRect.height - h) / 2;
		} else {
			// Video taller → bars left/right
			h = videoRect.height;
			w = videoRect.height * videoAR;
			cx = (videoRect.width - w) / 2;
			cy = 0;
		}
		// Offset from overlay origin to video element origin
		const offsetX = videoRect.left - overlayRect.left;
		const offsetY = videoRect.top - overlayRect.top;
		contentRect = { x: offsetX + cx, y: offsetY + cy, w, h };
	}

	// Observe layout changes on both overlay and video element
	$effect(() => {
		if (!overlayEl) return;
		const ro = new ResizeObserver(() => computeContentRect());
		ro.observe(overlayEl);
		if (videoEl) ro.observe(videoEl);
		return () => ro.disconnect();
	});

	// Recompute when video metadata loads
	$effect(() => {
		if (!videoEl) return;
		const handler = () => computeContentRect();
		videoEl.addEventListener('loadedmetadata', handler);
		videoEl.addEventListener('resize', handler);
		// Initial compute
		computeContentRect();
		return () => {
			videoEl!.removeEventListener('loadedmetadata', handler);
			videoEl!.removeEventListener('resize', handler);
		};
	});

	// Convert client coords to normalized 0-1 relative to video content
	function clientToNorm(clientX: number, clientY: number): { nx: number; ny: number } {
		if (!overlayEl) return { nx: 0, ny: 0 };
		const elRect = overlayEl.getBoundingClientRect();
		const px = clientX - elRect.left - contentRect.x;
		const py = clientY - elRect.top - contentRect.y;
		return {
			nx: Math.max(0, Math.min(1, px / contentRect.w)),
			ny: Math.max(0, Math.min(1, py / contentRect.h))
		};
	}

	// Region exists?
	let hasRegion = $derived(camX != null && camY != null && camW != null && camH != null);

	// Pixel rect for the region rectangle
	let regionStyle = $derived.by(() => {
		if (!hasRegion) return '';
		const left = contentRect.x + camX! * contentRect.w;
		const top = contentRect.y + camY! * contentRect.h;
		const width = camW! * contentRect.w;
		const height = camH! * contentRect.h;
		return `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
	});

	function handlePointerDown(e: PointerEvent) {
		if (!active || e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

		if (!hasRegion) {
			// Start drawing a new region
			const { nx, ny } = clientToNorm(e.clientX, e.clientY);
			mode = 'drawing';
			dragStart = { mx: nx, my: ny, rx: nx, ry: ny, rw: 0, rh: 0 };
			onchange({ camX: nx, camY: ny, camW: 0, camH: 0 });
		}
	}

	function handleRegionPointerDown(e: PointerEvent, handle: string) {
		if (!active || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

		const { nx, ny } = clientToNorm(e.clientX, e.clientY);
		dragStart = { mx: nx, my: ny, rx: camX!, ry: camY!, rw: camW!, rh: camH! };

		if (handle === 'body') {
			mode = 'moving';
		} else {
			mode = 'resizing';
			resizeHandle = handle;
		}
	}

	function handlePointerMove(e: PointerEvent) {
		if (mode === 'idle') return;
		const { nx, ny } = clientToNorm(e.clientX, e.clientY);

		if (mode === 'drawing') {
			const x1 = Math.min(dragStart.mx, nx);
			const y1 = Math.min(dragStart.my, ny);
			const x2 = Math.max(dragStart.mx, nx);
			const y2 = Math.max(dragStart.my, ny);
			onchange({ camX: x1, camY: y1, camW: x2 - x1, camH: y2 - y1 });
		} else if (mode === 'moving') {
			const dx = nx - dragStart.mx;
			const dy = ny - dragStart.my;
			let newX = dragStart.rx + dx;
			let newY = dragStart.ry + dy;
			// Clamp to bounds
			newX = Math.max(0, Math.min(1 - dragStart.rw, newX));
			newY = Math.max(0, Math.min(1 - dragStart.rh, newY));
			onchange({ camX: newX, camY: newY, camW: dragStart.rw, camH: dragStart.rh });
		} else if (mode === 'resizing') {
			const dx = nx - dragStart.mx;
			const dy = ny - dragStart.my;
			let { rx, ry, rw, rh } = dragStart;

			if (resizeHandle.includes('w')) {
				const newX = Math.max(0, Math.min(rx + rw - 0.02, rx + dx));
				rw = rw + (rx - newX);
				rx = newX;
			}
			if (resizeHandle.includes('e')) {
				rw = Math.max(0.02, Math.min(1 - rx, rw + dx));
			}
			if (resizeHandle.includes('n')) {
				const newY = Math.max(0, Math.min(ry + rh - 0.02, ry + dy));
				rh = rh + (ry - newY);
				ry = newY;
			}
			if (resizeHandle.includes('s')) {
				rh = Math.max(0.02, Math.min(1 - ry, rh + dy));
			}
			onchange({ camX: rx, camY: ry, camW: rw, camH: rh });
		}
	}

	function handlePointerUp() {
		if (mode !== 'idle' && onsave && camX != null && camY != null && camW != null && camH != null) {
			onsave({ camX: camX!, camY: camY!, camW: camW!, camH: camH! });
		}
		mode = 'idle';
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="cam-overlay"
	class:active
	class:drawing={mode === 'drawing'}
	bind:this={overlayEl}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
>
	{#if hasRegion}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="cam-region"
			class:interactive={active}
			style={regionStyle}
			onpointerdown={(e) => handleRegionPointerDown(e, 'body')}
		>
			{#if active}
				<div class="cam-handle nw" onpointerdown={(e) => handleRegionPointerDown(e, 'nw')}></div>
				<div class="cam-handle ne" onpointerdown={(e) => handleRegionPointerDown(e, 'ne')}></div>
				<div class="cam-handle sw" onpointerdown={(e) => handleRegionPointerDown(e, 'sw')}></div>
				<div class="cam-handle se" onpointerdown={(e) => handleRegionPointerDown(e, 'se')}></div>
				<div class="cam-handle n" onpointerdown={(e) => handleRegionPointerDown(e, 'n')}></div>
				<div class="cam-handle s" onpointerdown={(e) => handleRegionPointerDown(e, 's')}></div>
				<div class="cam-handle w" onpointerdown={(e) => handleRegionPointerDown(e, 'w')}></div>
				<div class="cam-handle e" onpointerdown={(e) => handleRegionPointerDown(e, 'e')}></div>
			{/if}
			<span class="cam-label">CAM</span>
		</div>
	{/if}
</div>

<style>
	.cam-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 5;
	}

	.cam-overlay.active {
		pointer-events: auto;
		cursor: crosshair;
	}

	.cam-overlay.drawing {
		cursor: crosshair;
	}

	.cam-region {
		position: absolute;
		border: 2px solid rgba(168, 85, 247, 0.8);
		background: rgba(168, 85, 247, 0.15);
		pointer-events: none;
		box-sizing: border-box;
	}

	.cam-region.interactive {
		pointer-events: auto;
		cursor: move;
	}

	.cam-label {
		position: absolute;
		top: 2px;
		left: 4px;
		font-size: 0.55rem;
		font-weight: 700;
		color: rgba(168, 85, 247, 0.9);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		pointer-events: none;
		user-select: none;
	}

	.cam-handle {
		position: absolute;
		width: 10px;
		height: 10px;
		background: rgba(168, 85, 247, 0.9);
		border: 1px solid #fff;
		border-radius: 2px;
		pointer-events: auto;
	}

	.cam-handle.nw { top: -5px; left: -5px; cursor: nw-resize; }
	.cam-handle.ne { top: -5px; right: -5px; cursor: ne-resize; }
	.cam-handle.sw { bottom: -5px; left: -5px; cursor: sw-resize; }
	.cam-handle.se { bottom: -5px; right: -5px; cursor: se-resize; }
	.cam-handle.n { top: -5px; left: calc(50% - 5px); cursor: n-resize; }
	.cam-handle.s { bottom: -5px; left: calc(50% - 5px); cursor: s-resize; }
	.cam-handle.w { top: calc(50% - 5px); left: -5px; cursor: w-resize; }
	.cam-handle.e { top: calc(50% - 5px); right: -5px; cursor: e-resize; }
</style>
