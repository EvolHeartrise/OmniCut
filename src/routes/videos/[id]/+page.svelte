<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import Hls from 'hls.js';
	import {
		videos,
		clipRegions,
		streams,
		syncOffsets
	} from '$lib/stores/streams.js';
	import {
		getVideoById,
		updateVideoCmd,
		deleteVideoCmd,
		exportVideoFromVideoCmd,
		getMultiStreamTranscriptions
	} from '$lib/streams.remote';
	import { untrack } from 'svelte';
	import { formatDuration, getClipLocalBounds, setupHls } from '$lib/utils.js';
	import type { ClipEntry } from '$lib/types.js';
	import type { ClipRegion } from '$lib/stores/streams.js';
	import { computeTickInterval, handleTimelineWheel, zoomIn as tzZoomIn, zoomOut as tzZoomOut } from '$lib/timeline.js';
	import { TRACK_COLORS } from '$lib/constants.js';

	let videoId = $derived(page.params.id as string);

	// Primary video data — reactively derived from SSE-updated store
	let video = $derived($videos.find((v) => v.id === videoId) ?? null);

	// Local editable state (initialized from video, auto-saved on change)
	let title = $state('');
	let description = $state('');
	let format = $state<'standard' | 'mobile_short' | 'chat_overlay'>('standard');
	let entries = $state<ClipEntry[]>([]);
	let loaded = $state(false);

	// Track whether we've initialized local state from the video
	let initialized = $state(false);

	// Initialize from video on first load or when video changes from server
	$effect(() => {
		if (video && !initialized) {
			title = video.title;
			description = video.description || '';
			format = video.format;
			entries = structuredClone(video.clipEntries);
			initialized = true;
			loaded = true;
		}
	});

	// Load video from server if not in store
	onMount(async () => {
		if (!video) {
			try {
				const fetched = await getVideoById({ id: videoId });
				videos.update((v) => {
					if (v.find((x) => x.id === fetched.id)) return v;
					return [...v, fetched];
				});
			} catch {
				// Video not found
			}
		}
	});

	// --- Auto-save (debounced) ---
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saving = $state(false);
	let lastSavedAt = $state<number | null>(null);

	function scheduleSave() {
		if (!initialized) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(doSave, 600);
	}

	async function doSave() {
		if (!video) return;
		saving = true;
		try {
			await updateVideoCmd({
				id: video.id,
				title: title.trim() || 'Untitled',
				description: description.trim() || undefined,
				clipEntries: entries,
				format
			});
			lastSavedAt = Date.now();
		} catch (err) {
			console.error('Failed to save video:', err);
		} finally {
			saving = false;
		}
	}

	// Trigger auto-save when editable fields change
	$effect(() => {
		void title;
		void description;
		void format;
		void JSON.stringify(entries);
		if (initialized) scheduleSave();
	});

	// --- Clip resolution ---
	let streamMap = $derived(new Map($streams.map((s) => [s.id, s])));

	function resolveClip(clipId: string): ClipRegion | undefined {
		return $clipRegions.find((c) => c.id === clipId);
	}

	function clipChannel(clip: ClipRegion): string {
		return streamMap.get(clip.streamId)?.channel || 'unknown';
	}

	function clipDuration(clip: ClipRegion, entry: ClipEntry): number {
		let dur = clip.endTime - clip.startTime;
		if (entry.trimStart) dur -= entry.trimStart;
		if (entry.trimEnd) dur -= entry.trimEnd;
		if (entry.speed && entry.speed > 0) dur /= entry.speed;
		return Math.max(0, dur);
	}

	function clipRawDuration(clip: ClipRegion): number {
		return clip.endTime - clip.startTime;
	}

	let totalDuration = $derived.by(() => {
		let total = 0;
		for (const entry of entries) {
			const clip = resolveClip(entry.clipId);
			if (clip) total += clipDuration(clip, entry);
		}
		return total;
	});

	// --- Timeline state ---
	const MIN_PPS = 1;
	const MAX_PPS = 200;
	let pixelsPerSecond = $state(50);
	let compositionTime = $state(0);
	let selectedIndex = $state<number | null>(null);

	// Drag state
	let dragMode = $state<'none' | 'reorder' | 'trim-start' | 'trim-end'>('none');
	let dragEntryIndex = $state<number | null>(null);
	let dragStartX = $state(0);
	let dragStartValue = $state(0);
	let dragInsertIndex = $state<number | null>(null);
	let dragPreviewDelta = $state(0);

	// Scroll/viewport
	let scrollAreaEl = $state<HTMLDivElement | null>(null);
	let viewportLeft = $state(0);
	let viewportWidth = $state(2000);
	const CULL_MARGIN = 200;
	let ignoreScrollEvents = false;

	function updateViewport() {
		if (!scrollAreaEl) return;
		viewportLeft = scrollAreaEl.scrollLeft;
		viewportWidth = scrollAreaEl.clientWidth;
	}

	// --- Clip layout (precomputed positions) ---
	interface ClipLayoutEntry {
		index: number;
		entry: ClipEntry;
		clip: ClipRegion | undefined;
		startOffset: number;
		effectiveDuration: number;
		color: string;
	}

	let clipLayout = $derived.by(() => {
		const layout: ClipLayoutEntry[] = [];
		let offset = 0;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const clip = resolveClip(entry.clipId);
			const dur = clip ? clipDuration(clip, entry) : 0;
			layout.push({
				index: i,
				entry,
				clip,
				startOffset: offset,
				effectiveDuration: dur,
				color: TRACK_COLORS[i % TRACK_COLORS.length]
			});
			offset += dur;
		}
		return layout;
	});

	// Content width for timeline
	let contentWidth = $derived(Math.max(totalDuration * pixelsPerSecond + 200, 100));

	// Ruler ticks
	let tickInterval = $derived(computeTickInterval(pixelsPerSecond, 60));

	let ticks = $derived.by(() => {
		const result: { x: number; label: string }[] = [];
		const visMin = viewportLeft - CULL_MARGIN;
		const visMax = viewportLeft + viewportWidth + CULL_MARGIN;
		const tMin = visMin / pixelsPerSecond;
		const start = Math.max(0, Math.ceil(tMin / tickInterval) * tickInterval);
		for (let t = start; t <= totalDuration + tickInterval; t += tickInterval) {
			const x = t * pixelsPerSecond;
			if (x > visMax) break;
			if (x >= 0) {
				result.push({ x, label: formatDuration(t) });
			}
		}
		return result;
	});

	// Playhead X
	let playheadX = $derived(compositionTime * pixelsPerSecond);

	// Auto-select clip under playhead
	$effect(() => {
		const t = compositionTime;
		if (dragMode !== 'none') return;
		let found: number | null = null;
		for (const cl of clipLayout) {
			if (t >= cl.startOffset && t < cl.startOffset + cl.effectiveDuration) {
				found = cl.index;
				break;
			}
		}
		selectedIndex = found;
	});

	// --- Entry management ---
	function updateEntry(index: number, updates: Partial<ClipEntry>) {
		entries = entries.map((e, i) => (i === index ? { ...e, ...updates } : e));
	}

	function removeEntry(index: number) {
		entries = entries.filter((_, i) => i !== index);
		if (selectedIndex === index) selectedIndex = null;
		else if (selectedIndex !== null && selectedIndex > index) selectedIndex--;
	}

	// --- Clip picker ---
	let showClipPicker = $state(false);
	let pickerFilter = $state('');
	let pickerClips = $derived.by(() => {
		const existingIds = new Set(entries.map((e) => e.clipId));
		let available = $clipRegions.filter((c) => !existingIds.has(c.id));
		if (pickerFilter) {
			const q = pickerFilter.toLowerCase();
			available = available.filter((c) => {
				const ch = clipChannel(c);
				return ch.includes(q) || (c.title || '').toLowerCase().includes(q) || (c.notes || '').toLowerCase().includes(q);
			});
		}
		return available.sort((a, b) => a.startTime - b.startTime);
	});

	function addClip(clipId: string) {
		entries = [...entries, { clipId }];
	}

	// --- Preview ---
	let previewVideoEl = $state<HTMLVideoElement | null>(null);
	let previewHls: Hls | null = null;
	let previewPlaying = $state(false);
	let previewProgress = $state(0);
	let previewCurrentTime = $state('0:00');
	let isSeeking = $state(false);
	let currentPreviewIndex = $state(0);
	let previewReady = $state(false);

	// --- Waveform + transcription (per-clip) ---
	const WAVEFORM_BINS = 800;
	let waveformBgCanvas = $state<HTMLCanvasElement | null>(null);
	let waveformFgCanvas = $state<HTMLCanvasElement | null>(null);
	let waveformSeekEl = $state<HTMLElement | null>(null);
	let waveformPeaks = new Float32Array(WAVEFORM_BINS);
	let waveformActive = false;
	let isDraggingWaveform = $state(false);
	let scanAbort: AbortController | null = null;
	let rafId: number | null = null;
	let clipProgress = $state(0);
	let clipDurationText = $state('0:00');
	let transcriptionRegions = $state<Array<{ startFrac: number; endFrac: number; text: string }>>([]);

	/** Trimmed local bounds for a clip entry — accounts for trimStart/trimEnd. */
	function trimmedBounds(entry: ClipEntry, clip: ClipRegion) {
		const bounds = clipBounds(clip);
		if (!bounds) return null;
		const trimmedStart = bounds.localStart + (entry.trimStart || 0);
		const trimmedEnd = bounds.localEnd - (entry.trimEnd || 0);
		const trimmedDur = trimmedEnd - trimmedStart;
		if (trimmedDur <= 0) return null;
		return { trimmedStart, trimmedEnd, trimmedDur };
	}

	function clipBounds(clip: ClipRegion) {
		return getClipLocalBounds(clip, streamMap.get(clip.streamId), $syncOffsets[clip.streamId] || 0);
	}

	// Auto-initialize preview on load
	$effect(() => {
		if (initialized && entries.length > 0 && previewVideoEl && !previewReady) {
			previewReady = true;
			loadPreviewClip(0, false);
		}
	});

	// --- Waveform drawing + scan ---
	function drawStaticWaveform() {
		const bg = waveformBgCanvas;
		const fg = waveformFgCanvas;
		if (!bg || !fg) return;
		const bgCtx = bg.getContext('2d');
		const fgCtx = fg.getContext('2d');
		if (!bgCtx || !fgCtx) return;

		const dpr = window.devicePixelRatio || 1;
		const rect = bg.getBoundingClientRect();
		const w = rect.width;
		const h = rect.height;
		const pw = Math.round(w * dpr);
		const ph = Math.round(h * dpr);

		for (const [canvas, ctx] of [[bg, bgCtx], [fg, fgCtx]] as const) {
			if (canvas.width !== pw || canvas.height !== ph) {
				canvas.width = pw;
				canvas.height = ph;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
		}

		let maxPeak = 0;
		for (let i = 0; i < WAVEFORM_BINS; i++) {
			if (waveformPeaks[i] > maxPeak) maxPeak = waveformPeaks[i];
		}
		if (maxPeak < 0.001) maxPeak = 1;

		const barW = w / WAVEFORM_BINS;
		const halfH = h / 2;

		bgCtx.strokeStyle = '#1a1a2e';
		bgCtx.lineWidth = 1;
		bgCtx.beginPath();
		bgCtx.moveTo(0, halfH);
		bgCtx.lineTo(w, halfH);
		bgCtx.stroke();

		bgCtx.fillStyle = '#2a2a4a';
		fgCtx.fillStyle = '#7c3aed';
		for (let i = 0; i < WAVEFORM_BINS; i++) {
			const amp = waveformPeaks[i] / maxPeak;
			const barH = Math.max(1, amp * (halfH - 2));
			const x = i * barW;
			bgCtx.fillRect(x, halfH - barH, barW - 0.5, barH * 2);
			fgCtx.fillRect(x, halfH - barH, barW - 0.5, barH * 2);
		}
	}

	function stopWaveformScan() {
		if (scanAbort) {
			scanAbort.abort();
			scanAbort = null;
		}
	}

	function startWaveformScan(entry: ClipEntry, clip: ClipRegion) {
		stopWaveformScan();
		const tb = trimmedBounds(entry, clip);
		if (!tb) return;
		const { trimmedStart, trimmedEnd } = tb;

		const abort = new AbortController();
		scanAbort = abort;

		fetch(`/api/waveform/${clip.streamId}?start=${trimmedStart.toFixed(3)}&end=${trimmedEnd.toFixed(3)}`, {
			signal: abort.signal
		})
			.then((r) => {
				if (!r.ok) throw new Error(r.statusText);
				return r.arrayBuffer();
			})
			.then((buf) => {
				if (abort.signal.aborted) return;
				const samples = new Int16Array(buf);
				const samplesPerBin = Math.max(1, Math.floor(samples.length / WAVEFORM_BINS));
				const peaks = new Float32Array(WAVEFORM_BINS);
				for (let bin = 0; bin < WAVEFORM_BINS; bin++) {
					const start = bin * samplesPerBin;
					const end = Math.min(start + samplesPerBin, samples.length);
					let sum = 0;
					for (let i = start; i < end; i++) {
						const s = samples[i] / 32768;
						sum += s * s;
					}
					peaks[bin] = Math.sqrt(sum / (end - start));
				}
				waveformPeaks = peaks;
				drawStaticWaveform();
			})
			.catch(() => {});
	}

	function waveformLoop() {
		rafId = null;
		if (!waveformActive) return;
		if (!isSeeking && previewVideoEl && entries.length > 0) {
			const entry = entries[currentPreviewIndex];
			const clip = entry ? resolveClip(entry.clipId) : undefined;
			if (entry && clip) {
				const tb = trimmedBounds(entry, clip);
				if (tb) {
					const elapsed = previewVideoEl.currentTime - tb.trimmedStart;
					clipProgress = tb.trimmedDur > 0 ? Math.max(0, Math.min(1, elapsed / tb.trimmedDur)) : 0;
				}
			}
		}
		if (previewPlaying || isDraggingWaveform) {
			rafId = requestAnimationFrame(waveformLoop);
		}
	}

	function startWaveformLoop() {
		if (rafId != null) return;
		rafId = requestAnimationFrame(waveformLoop);
	}

	// --- Waveform pointer handlers ---
	function waveformSeekFromEvent(e: PointerEvent) {
		const el = waveformSeekEl;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		clipProgress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
	}

	function handleWaveformPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		isDraggingWaveform = true;
		isSeeking = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		waveformSeekFromEvent(e);
		startWaveformLoop();
	}

	function handleWaveformPointerMove(e: PointerEvent) {
		if (!isDraggingWaveform) return;
		waveformSeekFromEvent(e);
	}

	function handleWaveformPointerUp(e: PointerEvent) {
		if (!isDraggingWaveform) return;
		isDraggingWaveform = false;
		waveformSeekFromEvent(e);
		// Convert clipProgress → composition time and seek
		const entry = entries[currentPreviewIndex];
		const clip = entry ? resolveClip(entry.clipId) : undefined;
		if (previewVideoEl && entry && clip) {
			const tb = trimmedBounds(entry, clip);
			if (tb) {
				const elapsed = clipProgress * tb.trimmedDur;
				const layoutEntry = clipLayout[currentPreviewIndex];
				if (layoutEntry) {
					const compTime = layoutEntry.startOffset + elapsed / (entry.speed || 1);
					seekToCompositionTime(compTime);
				}
			}
		}
		isSeeking = false;
	}

	function loadPreviewClip(index: number, autoPlay = true) {
		if (index < 0 || index >= entries.length) return;
		currentPreviewIndex = index;
		const entry = entries[index];
		const clip = resolveClip(entry.clipId);
		if (!clip || !previewVideoEl) return;
		const stream = streamMap.get(clip.streamId);
		if (!stream) return;

		if (previewHls) { previewHls.destroy(); previewHls = null; }

		const url = `/hls/${clip.streamId}/playlist.m3u8`;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		const localStart = clip.startTime - anchor + offset + (entry.trimStart || 0);

		previewHls = setupHls(Hls, previewVideoEl, url, localStart, () => {
			if (autoPlay) {
				previewVideoEl!.play().then(() => { previewPlaying = true; startWaveformLoop(); }).catch(() => {});
			}
		});
	}

	function handlePreviewTimeUpdate() {
		if (!previewVideoEl || entries.length === 0) return;
		const entry = entries[currentPreviewIndex];
		if (!entry) return;
		const clip = resolveClip(entry.clipId);
		if (!clip) return;
		const bounds = clipBounds(clip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const trimmedStart = localStart + (entry.trimStart || 0);
		const trimmedEnd = localEnd - (entry.trimEnd || 0);

		const trimmedDur = trimmedEnd - trimmedStart;

		if (previewVideoEl.currentTime >= trimmedEnd) {
			if (currentPreviewIndex < entries.length - 1) {
				loadPreviewClip(currentPreviewIndex + 1);
			} else {
				previewVideoEl.pause();
				previewPlaying = false;
				previewProgress = 1;
				previewCurrentTime = formatDuration(totalDuration);
				compositionTime = totalDuration;
				clipProgress = 1;
			}
		} else if (!isSeeking) {
			// elapsed within the trimmed region of this clip
			const elapsed = previewVideoEl.currentTime - trimmedStart;
			clipProgress = trimmedDur > 0 ? Math.max(0, Math.min(1, elapsed / trimmedDur)) : 0;
			// Sync composition time for playhead
			const layoutEntry = clipLayout[currentPreviewIndex];
			if (layoutEntry) {
				compositionTime = layoutEntry.startOffset + Math.max(0, elapsed) / (entry.speed || 1);
			}
			previewProgress = totalDuration > 0 ? Math.max(0, Math.min(1, compositionTime / totalDuration)) : 0;
			previewCurrentTime = formatDuration(compositionTime);
		}
	}

	function seekToCompositionTime(targetTime: number) {
		if (!previewVideoEl || entries.length === 0) return;
		compositionTime = Math.max(0, Math.min(targetTime, totalDuration));

		// Find which clip contains this composition time
		let accumulated = 0;
		let targetIndex = 0;
		let offsetInClip = 0;
		for (let i = 0; i < clipLayout.length; i++) {
			const cl = clipLayout[i];
			if (accumulated + cl.effectiveDuration > compositionTime) {
				targetIndex = i;
				offsetInClip = (compositionTime - accumulated) * (cl.entry.speed || 1);
				break;
			}
			accumulated += cl.effectiveDuration;
			if (i === clipLayout.length - 1) {
				targetIndex = i;
				offsetInClip = cl.effectiveDuration * (cl.entry.speed || 1);
			}
		}

		const entry = entries[targetIndex];
		const clip = resolveClip(entry?.clipId ?? '');
		if (!clip) return;

		if (targetIndex !== currentPreviewIndex) {
			currentPreviewIndex = targetIndex;
			const stream = streamMap.get(clip.streamId);
			if (!stream) return;
			if (previewHls) { previewHls.destroy(); previewHls = null; }
			const url = `/hls/${clip.streamId}/playlist.m3u8`;
			const offset = $syncOffsets[clip.streamId] || 0;
			const anchor = stream.startedAt / 1000;
			const localStart = clip.startTime - anchor + offset + (entry.trimStart || 0) + offsetInClip;
			previewHls = setupHls(Hls, previewVideoEl, url, localStart, () => {
				if (previewPlaying) previewVideoEl!.play().catch(() => {});
			});
		} else {
			const bounds = clipBounds(clip);
			if (bounds) {
				previewVideoEl.currentTime = bounds.localStart + (entry.trimStart || 0) + offsetInClip;
			}
		}
	}

	function togglePreviewPlay() {
		if (!previewVideoEl) return;
		if (previewPlaying) {
			previewVideoEl.pause();
		} else {
			if (compositionTime >= totalDuration && entries.length > 0) {
				compositionTime = 0;
				previewCurrentTime = '0:00';
				clipProgress = 0;
				loadPreviewClip(0);
				return;
			}
			previewVideoEl.play().catch(() => {});
			startWaveformLoop();
		}
		previewPlaying = !previewPlaying;
	}

	// Clip-change detection: reset waveform, start new scan, fetch transcription
	let prevWaveformIndex = -1;
	$effect(() => {
		const idx = currentPreviewIndex;
		if (idx === prevWaveformIndex) return;
		prevWaveformIndex = idx;

		// Reset waveform
		clipProgress = 0;
		waveformPeaks = new Float32Array(WAVEFORM_BINS);
		drawStaticWaveform();
		stopWaveformScan();
		transcriptionRegions = [];

		const entry = entries[idx];
		const clip = entry ? untrack(() => resolveClip(entry.clipId)) : undefined;
		if (!entry || !clip) {
			clipDurationText = '0:00';
			return;
		}

		const tb = untrack(() => trimmedBounds(entry, clip));
		if (!tb) {
			clipDurationText = '0:00';
			return;
		}
		clipDurationText = formatDuration(tb.trimmedDur / (entry.speed || 1));

		// Start waveform scan
		startWaveformScan(entry, clip);

		// Fetch transcription for trimmed range
		getMultiStreamTranscriptions({ ranges: [{ streamId: clip.streamId, from: tb.trimmedStart, to: tb.trimmedEnd }] })
			.then((segments) => {
				transcriptionRegions = segments.map((e) => ({
					startFrac: Math.max(0, (e.startTime - tb.trimmedStart) / tb.trimmedDur),
					endFrac: Math.min(1, (e.endTime - tb.trimmedStart) / tb.trimmedDur),
					text: e.text
				}));
			})
			.catch(() => {
				transcriptionRegions = [];
			});
	});

	// Waveform canvas lifecycle
	$effect(() => {
		if (waveformBgCanvas && waveformFgCanvas) {
			waveformActive = true;
			drawStaticWaveform();
			if (previewPlaying) startWaveformLoop();
			return () => {
				waveformActive = false;
				if (rafId != null) {
					cancelAnimationFrame(rafId);
					rafId = null;
				}
			};
		}
	});

	// Cleanup
	$effect(() => {
		return () => {
			if (previewHls) { previewHls.destroy(); previewHls = null; }
			if (saveTimer) clearTimeout(saveTimer);
			waveformActive = false;
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			stopWaveformScan();
		};
	});

	// --- Export ---
	let exporting = $state(false);
	let exportResult = $state<{ success: boolean; message: string } | null>(null);

	async function handleExport() {
		if (!video) return;
		exporting = true;
		exportResult = null;
		try {
			const result = await exportVideoFromVideoCmd({ videoId: video.id });
			exportResult = { success: true, message: `Export queued (ID: ${result.exportId})` };
		} catch (err) {
			exportResult = { success: false, message: err instanceof Error ? err.message : 'Failed' };
		} finally {
			exporting = false;
		}
	}

	// --- Delete ---
	async function handleDeleteVideo() {
		if (!video || !confirm('Delete this video? This cannot be undone.')) return;
		try {
			await deleteVideoCmd({ id: video.id });
			goto('/videos');
		} catch (err) {
			console.error('Failed to delete video:', err);
		}
	}

	// --- Timeline interactions ---

	// Click-to-seek on timeline background
	function handleTimelineClick(e: MouseEvent) {
		if (e.button !== 0 || dragMode !== 'none') return;
		if (!scrollAreaEl) return;
		// Don't seek if we clicked a clip block
		if ((e.target as HTMLElement).closest('.clip-block, .trim-handle')) return;
		const rect = scrollAreaEl.getBoundingClientRect();
		const x = e.clientX - rect.left + scrollAreaEl.scrollLeft;
		const time = x / pixelsPerSecond;
		seekToCompositionTime(time);
	}

	// Click-to-select clip
	function handleClipClick(e: MouseEvent, index: number) {
		e.stopPropagation();
		selectedIndex = index;
	}

	// --- Drag-edge trim ---
	function handleTrimStart(e: MouseEvent, index: number) {
		e.stopPropagation();
		e.preventDefault();
		dragMode = 'trim-start';
		dragEntryIndex = index;
		dragStartX = e.clientX;
		dragStartValue = entries[index].trimStart ?? 0;
		window.addEventListener('mousemove', handleDragMove);
		window.addEventListener('mouseup', handleDragEnd);
	}

	function handleTrimEnd(e: MouseEvent, index: number) {
		e.stopPropagation();
		e.preventDefault();
		dragMode = 'trim-end';
		dragEntryIndex = index;
		dragStartX = e.clientX;
		dragStartValue = entries[index].trimEnd ?? 0;
		window.addEventListener('mousemove', handleDragMove);
		window.addEventListener('mouseup', handleDragEnd);
	}

	// --- Drag-to-reorder ---
	function handleReorderStart(e: MouseEvent, index: number) {
		// Only start reorder if not on a trim handle
		if ((e.target as HTMLElement).closest('.trim-handle')) return;
		e.stopPropagation();
		e.preventDefault();
		dragMode = 'reorder';
		dragEntryIndex = index;
		dragStartX = e.clientX;
		dragInsertIndex = null;
		dragPreviewDelta = 0;
		selectedIndex = index;
		window.addEventListener('mousemove', handleDragMove);
		window.addEventListener('mouseup', handleDragEnd);
	}

	function handleDragMove(e: MouseEvent) {
		if (dragEntryIndex === null) return;
		const deltaX = e.clientX - dragStartX;

		if (dragMode === 'trim-start') {
			const deltaSec = deltaX / pixelsPerSecond;
			const clip = resolveClip(entries[dragEntryIndex].clipId);
			if (!clip) return;
			const maxTrim = clipRawDuration(clip) - (entries[dragEntryIndex].trimEnd ?? 0) - 0.1;
			const newTrim = Math.max(0, Math.min(maxTrim, dragStartValue + deltaSec));
			updateEntry(dragEntryIndex, { trimStart: newTrim > 0.01 ? newTrim : undefined });
		} else if (dragMode === 'trim-end') {
			const deltaSec = -deltaX / pixelsPerSecond;
			const clip = resolveClip(entries[dragEntryIndex].clipId);
			if (!clip) return;
			const maxTrim = clipRawDuration(clip) - (entries[dragEntryIndex].trimStart ?? 0) - 0.1;
			const newTrim = Math.max(0, Math.min(maxTrim, dragStartValue + deltaSec));
			updateEntry(dragEntryIndex, { trimEnd: newTrim > 0.01 ? newTrim : undefined });
		} else if (dragMode === 'reorder') {
			dragPreviewDelta = deltaX;
			// Compute insert position from cursor X
			if (!scrollAreaEl) return;
			const rect = scrollAreaEl.getBoundingClientRect();
			const x = e.clientX - rect.left + scrollAreaEl.scrollLeft;
			const cursorTime = x / pixelsPerSecond;

			// Find insert position based on clip midpoints
			let insertIdx = clipLayout.length;
			for (let i = 0; i < clipLayout.length; i++) {
				if (i === dragEntryIndex) continue;
				const midpoint = clipLayout[i].startOffset + clipLayout[i].effectiveDuration / 2;
				if (cursorTime < midpoint) {
					insertIdx = i;
					break;
				}
			}
			dragInsertIndex = insertIdx;
		}
	}

	function handleDragEnd() {
		if (dragMode === 'reorder' && dragEntryIndex !== null && dragInsertIndex !== null) {
			const fromIdx = dragEntryIndex;
			let toIdx = dragInsertIndex;
			if (fromIdx !== toIdx && toIdx !== fromIdx + 1) {
				const newEntries = [...entries];
				const [moved] = newEntries.splice(fromIdx, 1);
				if (toIdx > fromIdx) toIdx--;
				newEntries.splice(toIdx, 0, moved);
				entries = newEntries;
				selectedIndex = toIdx;
			}
		}
		dragMode = 'none';
		dragEntryIndex = null;
		dragInsertIndex = null;
		dragPreviewDelta = 0;
		window.removeEventListener('mousemove', handleDragMove);
		window.removeEventListener('mouseup', handleDragEnd);
	}

	// --- Zoom/Pan ---
	function handleWheel(e: WheelEvent) {
		const newPps = handleTimelineWheel(
			e,
			scrollAreaEl,
			pixelsPerSecond,
			0, // timelineStart is 0 for composition timeline
			MIN_PPS,
			MAX_PPS,
			() => { ignoreScrollEvents = true; }
		);
		if (newPps !== null) pixelsPerSecond = newPps;
	}

	function doZoomIn() {
		pixelsPerSecond = tzZoomIn(pixelsPerSecond, MIN_PPS, MAX_PPS);
	}

	function doZoomOut() {
		pixelsPerSecond = tzZoomOut(pixelsPerSecond, MIN_PPS, MAX_PPS);
	}

	// Wheel listener — needs non-passive
	$effect(() => {
		const el = scrollAreaEl;
		if (!el) return;
		el.addEventListener('wheel', handleWheel, { passive: false });
		updateViewport();
		const ro = new ResizeObserver(() => updateViewport());
		ro.observe(el);
		return () => {
			el.removeEventListener('wheel', handleWheel);
			ro.disconnect();
		};
	});

	function handleScroll() {
		updateViewport();
	}

	// --- Keyboard shortcuts ---
	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
		if (e.key === ' ') {
			e.preventDefault();
			togglePreviewPlay();
		} else if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			doZoomIn();
		} else if (e.key === '-') {
			e.preventDefault();
			doZoomOut();
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			if (selectedIndex !== null) {
				removeEntry(selectedIndex);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			selectedIndex = null;
			showClipPicker = false;
		}
	}

	// Auto-scroll playhead into view during playback
	$effect(() => {
		if (previewPlaying && scrollAreaEl) {
			const phX = playheadX;
			const sl = scrollAreaEl.scrollLeft;
			const sw = scrollAreaEl.clientWidth;
			if (phX < sl || phX > sl + sw - 50) {
				ignoreScrollEvents = true;
				scrollAreaEl.scrollLeft = phX - sw / 3;
			}
		}
	});

</script>

<svelte:window onkeydown={handleKeydown} />

{#if !loaded && !video}
	<div class="editor-page main-content">
		<div class="editor-loading">Loading video...</div>
	</div>
{:else if !video}
	<div class="editor-page main-content">
		<div class="editor-loading">
			<p>Video not found</p>
			<a href="/videos" class="btn-back">Back to Videos</a>
		</div>
	</div>
{:else}
	<div class="editor-page main-content">
		<div class="nle-layout">
			<!-- TOP ROW: Preview + Properties -->
			<div class="preview-panel">
				<div class="preview-player-area">
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={previewVideoEl}
						ontimeupdate={handlePreviewTimeUpdate}
						playsinline
						class="preview-video"
					></video>
				</div>
				<div class="video-controls">
					<div class="timeline-row">
						<button class="btn-ctl" onclick={togglePreviewPlay}>
							{previewPlaying ? '\u23F8' : '\u25B6'}
						</button>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="waveform-seek"
							bind:this={waveformSeekEl}
							onpointerdown={handleWaveformPointerDown}
							onpointermove={handleWaveformPointerMove}
							onpointerup={handleWaveformPointerUp}
						>
							<canvas bind:this={waveformBgCanvas} class="waveform-canvas"></canvas>
							<canvas
								bind:this={waveformFgCanvas}
								class="waveform-canvas waveform-fg"
								style="clip-path: inset(0 {(1 - clipProgress) * 100}% 0 0)"
							></canvas>
							{#each transcriptionRegions as region}
								<div
									class="transcript-region"
									style="left: {region.startFrac * 100}%; width: {(region.endFrac - region.startFrac) * 100}%"
									title={region.text}
								></div>
							{/each}
							<div class="waveform-playhead" style="left: {clipProgress * 100}%"></div>
						</div>
					</div>
					<div class="transport-row">
						<span class="vid-time">{previewCurrentTime}</span>
						<span class="vid-time" style="color: #555">/</span>
						<span class="vid-time">{formatDuration(totalDuration)}</span>
						{#if entries.length > 0}
							<span class="transport-clip-info">
								Clip {currentPreviewIndex + 1}/{entries.length}
								{#if resolveClip(entries[currentPreviewIndex]?.clipId ?? '')}
									{@const curClip = resolveClip(entries[currentPreviewIndex]?.clipId ?? '')!}
									— {curClip.title || clipChannel(curClip)}
								{/if}
							</span>
						{/if}
						<span style="flex:1"></span>
						<span class="vid-time">{clipDurationText}</span>
					</div>
				</div>
			</div>

			<div class="properties-panel">
				{#if selectedIndex !== null && entries[selectedIndex]}
					{@const selEntry = entries[selectedIndex]}
					{@const selClip = resolveClip(selEntry.clipId)}
					<div class="props-header">
						<h3 class="props-title">Clip Properties</h3>
						<button class="btn-deselect" onclick={() => selectedIndex = null} title="Deselect">×</button>
					</div>

					{#if selClip}
						<div class="props-info">
							<div class="props-row">
								<span class="props-label">Channel</span>
								<span class="props-value">{clipChannel(selClip)}</span>
							</div>
							<div class="props-row">
								<span class="props-label">Title</span>
								<span class="props-value">{selClip.title || 'Untitled'}</span>
							</div>
							<div class="props-row">
								<span class="props-label">Duration</span>
								<span class="props-value">{formatDuration(clipRawDuration(selClip))}</span>
							</div>
						</div>

						<div class="props-section">
							<div class="prop-field">
								<label class="prop-label">Trim Start (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									max={clipRawDuration(selClip)}
									step="0.1"
									value={selEntry.trimStart ?? 0}
									onchange={(e) => updateEntry(selectedIndex!, { trimStart: +(e.target as HTMLInputElement).value || undefined })}
								/>
							</div>
							<div class="prop-field">
								<label class="prop-label">Trim End (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									max={clipRawDuration(selClip)}
									step="0.1"
									value={selEntry.trimEnd ?? 0}
									onchange={(e) => updateEntry(selectedIndex!, { trimEnd: +(e.target as HTMLInputElement).value || undefined })}
								/>
							</div>
						</div>

						<button class="btn-remove-clip" onclick={() => removeEntry(selectedIndex!)}>
							Remove Clip
						</button>
					{:else}
						<div class="props-info">
							<span class="props-missing">Missing clip: {selEntry.clipId}</span>
						</div>
					{/if}
				{:else}
					<!-- No selection: show video metadata -->
					<div class="props-header">
						<h3 class="props-title">Video</h3>
					</div>

					<div class="props-section">
						<div class="prop-field">
							<label class="prop-label" for="v-title">Title</label>
							<input id="v-title" type="text" class="prop-input" bind:value={title} placeholder="Video title..." />
						</div>
						<div class="prop-field">
							<label class="prop-label" for="v-desc">Description</label>
							<textarea id="v-desc" class="prop-input prop-textarea" bind:value={description} placeholder="Description..." rows="3"></textarea>
						</div>
						<div class="prop-field">
							<label class="prop-label" for="v-format">Format</label>
							<select id="v-format" class="prop-select" bind:value={format}>
								<option value="standard">Standard (16:9)</option>
								<option value="mobile_short">Mobile Short (9:16)</option>
								<option value="chat_overlay">Chat Overlay</option>
							</select>
						</div>
					</div>

					<div class="props-summary">
						<span>{entries.length} clip{entries.length !== 1 ? 's' : ''}</span>
						<span class="props-dot">&middot;</span>
						<span>{formatDuration(totalDuration)}</span>
					</div>

					<div class="props-actions">
						<button class="btn-props btn-export" onclick={handleExport} disabled={exporting || entries.length === 0}>
							{exporting ? 'Queueing...' : 'Export Video'}
						</button>
						<a class="btn-props btn-thumbnail" href="/thumbnail?video={video.id}">Thumbnail</a>
						<button class="btn-props btn-delete" onclick={handleDeleteVideo}>Delete</button>
					</div>

					{#if exportResult}
						<div class="export-result" class:success={exportResult.success} class:error={!exportResult.success}>
							{exportResult.message}
						</div>
					{/if}

					<div class="save-status">
						{#if saving}
							<span class="save-dot saving"></span> Saving...
						{:else if lastSavedAt}
							<span class="save-dot saved"></span> Saved
						{/if}
					</div>
				{/if}
			</div>

			<!-- BOTTOM: Timeline -->
			<div class="timeline-area">
				<!-- Toolbar -->
				<div class="tl-toolbar">
					<button class="btn-tl" onclick={togglePreviewPlay} title={previewPlaying ? 'Pause' : 'Play'}>
						{previewPlaying ? '\u23F8' : '\u25B6'}
					</button>
					<span class="tl-time">{formatDuration(compositionTime)}</span>
					<span class="tl-sep">/</span>
					<span class="tl-time">{formatDuration(totalDuration)}</span>
					<div class="tl-spacer"></div>
					<button class="btn-tl btn-tl-sm" onclick={() => { showClipPicker = !showClipPicker; }} title="Add clips">
						{showClipPicker ? 'Done' : '+ Add Clips'}
					</button>
					<div class="tl-spacer"></div>
					<button class="btn-tl btn-tl-sm" onclick={doZoomOut} title="Zoom out (-)">−</button>
					<span class="tl-zoom">{pixelsPerSecond.toFixed(0)} px/s</span>
					<button class="btn-tl btn-tl-sm" onclick={doZoomIn} title="Zoom in (+)">+</button>
				</div>

				<!-- Clip picker overlay -->
				{#if showClipPicker}
					<div class="clip-picker-overlay">
						<input
							type="text"
							class="picker-search"
							bind:value={pickerFilter}
							placeholder="Search clips..."
						/>
						<div class="picker-list">
							{#each pickerClips as clip (clip.id)}
								<div class="picker-item">
									<span class="picker-channel">{clipChannel(clip)}</span>
									<span class="picker-title">{clip.title || 'Untitled'}</span>
									<span class="picker-dur">{formatDuration(clip.endTime - clip.startTime)}</span>
									<button class="btn-picker-add" onclick={() => addClip(clip.id)}>Add</button>
								</div>
							{/each}
							{#if pickerClips.length === 0}
								<div class="picker-empty">No clips available</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Timeline body -->
				<div class="tl-body">
					<!-- Track labels -->
					<div class="tl-labels">
						<div class="tl-ruler-spacer"></div>
						<div class="tl-label-row" style="height: 40px"><span class="tl-label-icon">[V]</span><span class="tl-label-text">Video</span></div>
					</div>

					<!-- Scrollable timeline area -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="tl-scroll-area"
						bind:this={scrollAreaEl}
						onscroll={handleScroll}
						onmousedown={handleTimelineClick}
					>
						<div class="tl-content" style="width: {contentWidth}px">
							<!-- Time ruler -->
							<div class="tl-ruler">
								{#each ticks as t}
									<div class="tl-tick" style="left: {t.x}px">
										<div class="tl-tick-line"></div>
										<span class="tl-tick-label">{t.label}</span>
									</div>
								{/each}
							</div>

							<!-- [V] Video Track -->
							<div class="tl-track tl-track-video" style="height: 40px">
								{#each clipLayout as cl (cl.entry.clipId + '-' + cl.index)}
									{@const leftPx = cl.startOffset * pixelsPerSecond}
									{@const widthPx = cl.effectiveDuration * pixelsPerSecond}
									{@const isVisible = leftPx + widthPx > viewportLeft - CULL_MARGIN && leftPx < viewportLeft + viewportWidth + CULL_MARGIN}
									{@const isSelected = selectedIndex === cl.index}
									{@const isDragging = dragMode === 'reorder' && dragEntryIndex === cl.index}
									{#if isVisible}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class="clip-block"
											class:selected={isSelected}
											class:dragging={isDragging}
											style="left: {leftPx + (isDragging ? dragPreviewDelta : 0)}px; width: {widthPx}px; background: {cl.color};"
											onclick={(e) => handleClipClick(e, cl.index)}
											onmousedown={(e) => handleReorderStart(e, cl.index)}
										>
											<!-- Trim handles -->
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div class="trim-handle trim-handle-start" onmousedown={(e) => handleTrimStart(e, cl.index)}></div>
											<span class="clip-label">
												{#if cl.clip}
													<span class="clip-ch">{clipChannel(cl.clip)}</span>
													{cl.clip.title || ''}
												{:else}
													Missing
												{/if}
											</span>
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div class="trim-handle trim-handle-end" onmousedown={(e) => handleTrimEnd(e, cl.index)}></div>
										</div>
									{/if}
								{/each}

								<!-- Drop indicator for reorder -->
								{#if dragMode === 'reorder' && dragInsertIndex !== null}
									{@const insertOffset = dragInsertIndex < clipLayout.length ? clipLayout[dragInsertIndex].startOffset : totalDuration}
									<div class="drop-indicator" style="left: {insertOffset * pixelsPerSecond}px"></div>
								{/if}
							</div>

							<!-- Playhead -->
							<div class="tl-playhead" style="left: {playheadX}px"></div>
						</div>
					</div>
				</div>

				{#if entries.length === 0}
					<div class="tl-empty">
						No clips — click "+ Add Clips" to start building your composition
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.editor-page {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.editor-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 12px;
		color: #888;
		font-size: 0.85rem;
	}

	.btn-back {
		color: #a78bfa;
		text-decoration: none;
		font-size: 0.8rem;
	}

	.btn-back:hover {
		color: #c4b5fd;
	}

	/* ============================================================
	   NLE GRID LAYOUT
	   ============================================================ */
	.nle-layout {
		display: grid;
		grid-template-columns: 1fr 320px;
		grid-template-rows: 1fr auto;
		height: 100%;
		overflow: hidden;
	}

	/* ============================================================
	   PREVIEW PANEL (top-left)
	   ============================================================ */
	.preview-panel {
		grid-column: 1;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-right: 1px solid #1a1a2e;
		background: #0a0a1a;
	}

	.preview-player-area {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #000;
		min-height: 0;
	}

	.preview-video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}

	.video-controls {
		display: flex;
		flex-direction: column;
		background: #0a0a1a;
		flex-shrink: 0;
	}

	.timeline-row {
		display: flex;
		align-items: stretch;
		flex-shrink: 0;
	}

	.timeline-row .btn-ctl {
		border-radius: 0;
		padding: 0;
		width: 44px;
		flex-shrink: 0;
		text-align: center;
	}

	.waveform-seek {
		position: relative;
		height: 64px;
		cursor: pointer;
		touch-action: none;
		flex: 1;
		min-width: 0;
	}

	.waveform-canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	.waveform-fg {
		position: absolute;
		top: 0;
		left: 0;
	}

	.waveform-playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		box-shadow: 0 0 6px #7c3aed;
		pointer-events: none;
		transform: translateX(-1px);
	}

	.transcript-region {
		position: absolute;
		top: 0;
		bottom: 0;
		background: rgba(56, 189, 248, 0.15);
		border-left: 1px solid rgba(56, 189, 248, 0.3);
		pointer-events: none;
	}

	.transport-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 16px 6px;
	}

	.vid-time {
		font-size: 0.7rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		min-width: 3em;
		text-align: center;
	}

	.btn-ctl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.btn-ctl:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.transport-clip-info {
		font-size: 0.7rem;
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ============================================================
	   PROPERTIES PANEL (top-right)
	   ============================================================ */
	.properties-panel {
		grid-column: 2;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		padding: 16px;
		background: #0d0d1f;
		border-bottom: 1px solid #1a1a2e;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0d0d1f;
	}

	.props-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.props-title {
		font-size: 0.8rem;
		font-weight: 700;
		color: #e0e0ff;
		margin: 0;
	}

	.btn-deselect {
		background: none;
		border: 1px solid #2a2a4a;
		color: #888;
		width: 22px;
		height: 22px;
		border-radius: 3px;
		cursor: pointer;
		font-size: 0.8rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.btn-deselect:hover {
		background: #2a2a4a;
		color: #fff;
	}

	.props-info {
		margin-bottom: 16px;
	}

	.props-row {
		display: flex;
		justify-content: space-between;
		padding: 4px 0;
		font-size: 0.7rem;
	}

	.props-label {
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 600;
		font-size: 0.6rem;
	}

	.props-value {
		color: #ccc;
		text-align: right;
	}

	.props-missing {
		color: #f87171;
		font-size: 0.7rem;
	}

	.props-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 16px;
	}

	.prop-field {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.prop-label {
		font-size: 0.6rem;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 600;
	}

	.prop-input,
	.prop-select {
		width: 100%;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 5px 8px;
		border-radius: 4px;
		outline: none;
		font-family: inherit;
	}

	.prop-input:focus,
	.prop-select:focus {
		border-color: #7c3aed;
	}

	.prop-textarea {
		resize: vertical;
	}

	.btn-remove-clip {
		margin-top: 12px;
		background: #3a1a1a;
		border: 1px solid #5a2a2a;
		color: #c88;
		font-size: 0.7rem;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		width: 100%;
	}

	.btn-remove-clip:hover {
		background: #5a2a2a;
		color: #faa;
	}

	.props-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.7rem;
		color: #888;
		margin-bottom: 16px;
	}

	.props-dot {
		color: #555;
	}

	.props-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}

	.btn-props {
		font-size: 0.7rem;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		border: none;
		font-weight: 600;
		text-decoration: none;
		text-align: center;
		display: block;
	}

	.btn-export {
		background: #7c3aed;
		color: #fff;
	}

	.btn-export:hover {
		background: #6d28d9;
	}

	.btn-export:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-thumbnail {
		background: rgba(59, 130, 246, 0.15);
		border: 1px solid rgba(59, 130, 246, 0.3);
		color: #93c5fd;
	}

	.btn-thumbnail:hover {
		background: rgba(59, 130, 246, 0.25);
		color: #bfdbfe;
	}

	.btn-delete {
		background: #3a1a1a;
		border: 1px solid #5a2a2a;
		color: #c88;
	}

	.btn-delete:hover {
		background: #5a2a2a;
		color: #faa;
	}

	.export-result {
		margin-top: 8px;
		padding: 6px 10px;
		font-size: 0.7rem;
		border-radius: 4px;
	}

	.export-result.success {
		color: #4ade80;
		background: rgba(22, 163, 74, 0.08);
	}

	.export-result.error {
		color: #f87171;
		background: rgba(220, 38, 38, 0.08);
	}

	.save-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.65rem;
		color: #888;
		margin-top: 8px;
	}

	.save-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.save-dot.saving {
		background: #f59e0b;
	}

	.save-dot.saved {
		background: #4ade80;
	}

	/* ============================================================
	   TIMELINE AREA (bottom, spans both columns)
	   ============================================================ */
	.timeline-area {
		grid-column: 1 / -1;
		grid-row: 2;
		display: flex;
		flex-direction: column;
		height: 280px;
		background: #0a0a1a;
		border-top: 1px solid #2a2a4a;
		user-select: none;
		position: relative;
	}

	/* --- Toolbar --- */
	.tl-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
	}

	.btn-tl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.btn-tl:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.btn-tl-sm {
		padding: 2px 8px;
		font-size: 0.75rem;
	}

	.tl-time {
		font-size: 0.8rem;
		color: #e0e0ff;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
	}

	.tl-sep {
		color: #555;
		font-size: 0.7rem;
	}

	.tl-spacer {
		flex: 1;
	}

	.tl-zoom {
		font-size: 0.65rem;
		color: #666;
		font-variant-numeric: tabular-nums;
		min-width: 4em;
		text-align: center;
	}

	/* --- Clip picker overlay --- */
	.clip-picker-overlay {
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		padding: 8px 12px;
		max-height: 200px;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
	}

	.picker-search {
		width: 100%;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 5px 10px;
		border-radius: 4px;
		outline: none;
		margin-bottom: 6px;
	}

	.picker-search:focus {
		border-color: #7c3aed;
	}

	.picker-list {
		overflow-y: auto;
		flex: 1;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0f0f23;
	}

	.picker-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		border-bottom: 1px solid #1a1a2e;
	}

	.picker-channel {
		font-size: 0.65rem;
		color: #7c3aed;
		font-weight: 600;
		flex-shrink: 0;
	}

	.picker-title {
		font-size: 0.7rem;
		color: #ccc;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.picker-dur {
		font-size: 0.6rem;
		color: #666;
		font-family: monospace;
		flex-shrink: 0;
	}

	.picker-empty {
		text-align: center;
		color: #555;
		font-size: 0.75rem;
		padding: 12px;
	}

	.btn-picker-add {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.6rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		flex-shrink: 0;
	}

	.btn-picker-add:hover {
		background: #3a3a5a;
		color: #fff;
	}

	/* --- Timeline body (labels + scroll area) --- */
	.tl-body {
		flex: 1;
		display: flex;
		min-height: 0;
		overflow: hidden;
	}

	.tl-labels {
		width: 80px;
		flex-shrink: 0;
		background: #0f0f23;
		border-right: 1px solid #1a1a2e;
		overflow: hidden;
	}

	.tl-ruler-spacer {
		height: 24px;
		border-bottom: 1px solid #1a1a2e;
	}

	.tl-label-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 8px;
		border-bottom: 1px solid #111;
	}

	.tl-label-icon {
		font-size: 0.6rem;
		color: #7c3aed;
		font-weight: 700;
		font-family: monospace;
	}

	.tl-label-text {
		font-size: 0.65rem;
		color: #888;
	}

	/* --- Scroll area --- */
	.tl-scroll-area {
		flex: 1;
		overflow-x: auto;
		overflow-y: hidden;
		position: relative;
		cursor: crosshair;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.tl-scroll-area::-webkit-scrollbar {
		height: 6px;
	}

	.tl-scroll-area::-webkit-scrollbar-track {
		background: #0a0a1a;
	}

	.tl-scroll-area::-webkit-scrollbar-thumb {
		background: #2a2a4a;
		border-radius: 3px;
	}

	.tl-content {
		position: relative;
		min-height: 100%;
	}

	/* --- Ruler --- */
	.tl-ruler {
		height: 24px;
		position: sticky;
		top: 0;
		z-index: 5;
		border-bottom: 1px solid #1a1a2e;
		background: #0d0d1f;
	}

	.tl-tick {
		position: absolute;
		top: 0;
		height: 100%;
	}

	.tl-tick-line {
		width: 1px;
		height: 8px;
		background: #444;
		position: absolute;
		bottom: 0;
	}

	.tl-tick-label {
		font-size: 0.6rem;
		color: #666;
		position: absolute;
		top: 2px;
		left: 4px;
		white-space: nowrap;
	}

	/* --- Tracks --- */
	.tl-track {
		position: relative;
		border-bottom: 1px solid #111;
	}

	/* --- Video track: clip blocks --- */
	.clip-block {
		position: absolute;
		top: 3px;
		height: calc(100% - 6px);
		border-radius: 4px;
		cursor: grab;
		overflow: hidden;
		display: flex;
		align-items: center;
		transition: opacity 0.1s;
	}

	.clip-block:hover {
		filter: brightness(1.15);
	}

	.clip-block.selected {
		outline: 2px solid #fff;
		outline-offset: -1px;
		z-index: 2;
	}

	.clip-block.dragging {
		opacity: 0.5;
		cursor: grabbing;
		z-index: 3;
	}

	.clip-label {
		position: relative;
		font-size: 0.6rem;
		color: rgba(255, 255, 255, 0.9);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
		padding: 0 10px;
		line-height: 1.2;
		flex: 1;
		min-width: 0;
	}

	.clip-ch {
		font-weight: 700;
		margin-right: 4px;
	}

	/* --- Trim handles --- */
	.trim-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 4;
		background: rgba(255, 255, 255, 0);
		transition: background 0.15s;
	}

	.trim-handle:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	.trim-handle-start {
		left: 0;
		border-radius: 4px 0 0 4px;
	}

	.trim-handle-end {
		right: 0;
		border-radius: 0 4px 4px 0;
	}

	/* --- Drop indicator --- */
	.drop-indicator {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		z-index: 5;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.5);
	}

	/* --- Playhead --- */
	.tl-playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		pointer-events: none;
		z-index: 10;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
	}

	/* --- Empty state --- */
	.tl-empty {
		position: absolute;
		bottom: 50%;
		left: 50%;
		transform: translate(-50%, 50%);
		color: #555;
		font-size: 0.8rem;
		pointer-events: none;
	}
</style>
