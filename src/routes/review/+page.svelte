<script lang="ts">
	import Hls from 'hls.js';
	import {
		streams,
		syncOffsets,
		clipRegions,
		saveClipRegion,
		deleteClipRegion,
		saveCameraBounds,
		getCameraBounds,
		removeCameraBounds,
		type ClipRegion
	} from '$lib/stores/streams.js';
	import type { CameraBoundsEntry } from '$lib/types.js';
	import { formatDuration, setupHls } from '$lib/utils.js';
	import { getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { splitClipRegion } from '$lib/clipActions.js';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import CameraRegionOverlay from '$lib/components/CameraRegionOverlay.svelte';
	import ReviewTranscriptPanel from '$lib/components/ReviewTranscriptPanel.svelte';
	import ClipChatPanel from '$lib/components/ClipChatPanel.svelte';

	// --- URL-targeted clip (e.g. /review?clip=123) ---
	let urlClipId = $derived(page.url.searchParams.get('clip'));
	let urlClip = $derived<ClipRegion | null>(
		urlClipId ? $clipRegions.find((c) => c.id === urlClipId) ?? null : null
	);

	// --- AI review queue (oldest AI clip first) ---
	let aiClips = $derived(
		[...$clipRegions].filter((c) => c.createdBy === 'ai').sort((a, b) => a.startTime - b.startTime)
	);

	// URL clip takes priority, otherwise fall back to AI queue
	let currentClip = $derived<ClipRegion | null>(urlClip ?? aiClips[0] ?? null);
	let isUrlMode = $derived(urlClip !== null);

	// --- Delete confirmation ---
	let deleteConfirmId = $state<string | null>(null);
	let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Undo stack ---
	type ReviewUndoEntry =
		| { type: 'update-region'; before: ClipRegion }
		| { type: 'delete-region'; region: ClipRegion }
		| { type: 'split-region'; original: ClipRegion; createdIds: [string, string] }
		| { type: 'set-cam-bounds'; before: CameraBoundsEntry | null }
		| { type: 'delete-cam-bounds'; before: CameraBoundsEntry };

	let undoStack = $state<ReviewUndoEntry[]>([]);
	function pushUndo(entry: ReviewUndoEntry) {
		undoStack = [...undoStack, entry];
	}

	function applyUndo() {
		if (undoStack.length === 0) return;
		const entry = undoStack[undoStack.length - 1];
		undoStack = undoStack.slice(0, -1);

		switch (entry.type) {
			case 'delete-region':
				// Undo deletion → re-add the clip
				clipRegions.update((regions) => [...regions, entry.region]);
				saveClipRegion(entry.region);
				break;
			case 'update-region':
				// Undo edit/approve/boundary change → restore old snapshot
				clipRegions.update((regions) => regions.map((r) => (r.id === entry.before.id ? { ...entry.before } : r)));
				saveClipRegion(entry.before);
				break;
			case 'split-region':
				// Undo split → remove the two halves, restore original
				clipRegions.update((regions) => regions.filter((r) => !entry.createdIds.includes(r.id)));
				deleteClipRegion(entry.createdIds[0]);
				deleteClipRegion(entry.createdIds[1]);
				clipRegions.update((regions) => [...regions, entry.original]);
				saveClipRegion(entry.original);
				break;
			case 'set-cam-bounds':
				// Undo cam bounds set → restore previous bounds (or delete if none)
				if (entry.before) {
					saveCameraBounds(entry.before.channel, entry.before.timestamp, entry.before.camX, entry.before.camY, entry.before.camW, entry.before.camH);
					resolvedCamBounds = entry.before;
				} else if (resolvedCamBounds) {
					removeCameraBounds(resolvedCamBounds.id);
					resolvedCamBounds = null;
				}
				break;
			case 'delete-cam-bounds':
				// Undo cam bounds delete → restore
				saveCameraBounds(entry.before.channel, entry.before.timestamp, entry.before.camX, entry.before.camY, entry.before.camW, entry.before.camH);
				resolvedCamBounds = entry.before;
				break;
		}
	}

	// --- Editing ---
	let editingId = $state<string | null>(null);
	let editTitle = $state('');
	let editNotes = $state('');

	// --- Preview player ---
	let videoEl = $state<HTMLVideoElement | null>(null);
	let hls: Hls | null = null;
	let playing = $state(false);
	let progress = $state(0);
	let currentTime = $state('0:00');
	let currentLocalTime = $state(0);
	let durationText = $state('0:00');
	let isSeeking = $state(false);
	let loadedClipId = $state<string | null>(null);
	let playbackRate = $state(1);

	// --- Transcription regions ---
	let transcriptionRegions = $state<Array<{ startFrac: number; endFrac: number; text: string }>>([]);

	// --- Side panels ---
	let transcriptPanelOpen = $state(false);
	let chatPanelOpen = $state(false);

	// --- Camera region ---
	let camRegionActive = $state(false);
	let resolvedCamBounds = $state<CameraBoundsEntry | null>(null);

	// --- Waveform ---
	const WAVEFORM_BINS = 2000;
	let waveformBgCanvas = $state<HTMLCanvasElement | null>(null);
	let waveformFgCanvas = $state<HTMLCanvasElement | null>(null);
	let waveformSeekEl = $state<HTMLElement | null>(null);
	let waveformPeaks = new Float32Array(WAVEFORM_BINS);
	let waveformActive = false;
	let isDraggingWaveform = $state(false);

	// --- Waveform background scan ---
	let scanAbort: AbortController | null = null;

	// --- Helpers ---
	function clipChannel(clip: ClipRegion): string {
		return $streams.find((s) => s.id === clip.streamId)?.channel || 'unknown';
	}

	function clipDate(epoch: number): string {
		return new Date(epoch * 1000).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}


	function getClipLocalBounds(clip: ClipRegion): { localStart: number; localEnd: number } | null {
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return { localStart: clip.startTime - anchor + offset, localEnd: clip.endTime - anchor + offset };
	}


	// --- Player setup ---
	function setupPlayer(clip: ClipRegion) {
		if (!videoEl) return;
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return;

		if (hls) {
			hls.destroy();
			hls = null;
		}

		const url = `/hls/${clip.streamId}/playlist.m3u8`;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		const localStart = clip.startTime - anchor + offset;

		hls = setupHls(Hls, videoEl, url, localStart, () => {
			videoEl!.playbackRate = playbackRate;
			videoEl!.play().then(() => { playing = true; startWaveformLoop(); }).catch(() => {});
		});

		loadedClipId = clip.id;
		startWaveformScan(clip);
	}

	// Auto-load player when currentClip changes
	$effect(() => {
		const clip = currentClip;
		if (!clip) {
			if (hls) {
				hls.destroy();
				hls = null;
			}
			stopWaveformScan();
			loadedClipId = null;
			playing = false;
			return;
		}
		if (clip.id === loadedClipId) return;
		// Reset state for new clip
		stopWaveformScan();
		playing = false;
		progress = 0;
		currentTime = '0:00';
		durationText = formatDuration(clip.endTime - clip.startTime);
		waveformPeaks = new Float32Array(WAVEFORM_BINS);
		editingId = null;
		deleteConfirmId = null;
		camRegionActive = false;
		// Wait for DOM
		requestAnimationFrame(() => setupPlayer(clip));
	});

	// Fetch transcription regions for current clip
	$effect(() => {
		const clip = currentClip;
		if (!clip) {
			transcriptionRegions = [];
			return;
		}
		// untrack store reads so SSE stream-update events don't re-trigger this effect
		const bounds = untrack(() => getClipLocalBounds(clip));
		if (!bounds) {
			transcriptionRegions = [];
			return;
		}
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;
		if (clipDur <= 0) {
			transcriptionRegions = [];
			return;
		}
		getMultiStreamTranscriptions({ ranges: [{ streamId: clip.streamId, from: localStart, to: localEnd }] })
			.then((entries) => {
				transcriptionRegions = entries.map((e) => ({
					startFrac: Math.max(0, (e.startTime - localStart) / clipDur),
					endFrac: Math.min(1, (e.endTime - localStart) / clipDur),
					text: e.text
				}));
			})
			.catch(() => {
				transcriptionRegions = [];
			});
	});

	// Fetch camera bounds when clip changes
	$effect(() => {
		const clip = currentClip;
		if (!clip) {
			resolvedCamBounds = null;
			return;
		}
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) {
			resolvedCamBounds = null;
			return;
		}
		getCameraBounds(stream.channel, clip.startTime)
			.then((bounds) => {
				resolvedCamBounds = bounds;
			})
			.catch(() => {
				resolvedCamBounds = null;
			});
	});

	// Clamp playback to clip bounds
	function handleTimeUpdate() {
		if (!videoEl || !currentClip) return;
		const bounds = getClipLocalBounds(currentClip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;

		currentLocalTime = videoEl.currentTime;

		if (videoEl.currentTime >= localEnd) {
			videoEl.pause();
			playing = false;
			videoEl.currentTime = localStart;
			currentLocalTime = localStart;
			progress = 0;
			currentTime = '0:00';
		} else if (!isSeeking) {
			const elapsed = videoEl.currentTime - localStart;
			progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			currentTime = formatDuration(elapsed);
		}
		durationText = formatDuration(clipDur);
	}

	function handleSeekInput(e: Event) {
		isSeeking = true;
		const value = +(e.target as HTMLInputElement).value;
		progress = value;
		if (currentClip) {
			const bounds = getClipLocalBounds(currentClip);
			if (bounds) currentTime = formatDuration(value * (bounds.localEnd - bounds.localStart));
		}
	}

	function handleSeekCommit() {
		if (!videoEl || !currentClip) {
			isSeeking = false;
			return;
		}
		const bounds = getClipLocalBounds(currentClip);
		if (!bounds) {
			isSeeking = false;
			return;
		}
		videoEl.currentTime = bounds.localStart + progress * (bounds.localEnd - bounds.localStart);
		isSeeking = false;
	}

	function togglePlay() {
		if (!videoEl) return;
		if (playing) {
			videoEl.pause();
			playing = false;
		} else {
			videoEl.play().catch(() => {});
			playing = true;
			startWaveformLoop();
		}
	}

	// --- Actions ---
	function approveClip(clip: ClipRegion) {
		pushUndo({ type: 'update-region', before: { ...clip } });
		saveClipRegion({ ...clip, createdBy: 'human' as const });
	}

	function toggleFavourite(clip: ClipRegion) {
		pushUndo({ type: 'update-region', before: { ...clip } });
		const updated = { ...clip, favourite: !clip.favourite };
		clipRegions.update((regions) => regions.map((r) => (r.id === updated.id ? updated : r)));
		saveClipRegion(updated);
	}

	function handleDelete(id: string) {
		if (deleteConfirmId === id) {
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmTimer = null;
			deleteConfirmId = null;
			// Snapshot the clip before deleting for undo
			const clip = $clipRegions.find((c) => c.id === id);
			if (clip) pushUndo({ type: 'delete-region', region: { ...clip } });
			if (hls) {
				hls.destroy();
				hls = null;
			}
			loadedClipId = null;
			playing = false;
			deleteClipRegion(id);
		} else {
			if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
			deleteConfirmId = id;
			deleteConfirmTimer = setTimeout(() => {
				deleteConfirmId = null;
				deleteConfirmTimer = null;
			}, 3000);
		}
	}

	function copyClipId(id: string) {
		navigator.clipboard.writeText(id);
	}

	function startEdit(clip: ClipRegion) {
		editingId = clip.id;
		editTitle = clip.title || '';
		editNotes = clip.notes || '';
	}

	function cancelEdit() {
		editingId = null;
	}

	function saveEdit() {
		if (!editingId) return;
		const clip = $clipRegions.find((c) => c.id === editingId);
		if (!clip) return;
		pushUndo({ type: 'update-region', before: { ...clip } });
		const updated = { ...clip, title: editTitle || undefined, notes: editNotes || undefined };
		clipRegions.update((regions) => regions.map((r) => (r.id === updated.id ? updated : r)));
		saveClipRegion(updated);
		editingId = null;
	}

	// --- Playback rate sync ---
	function setRate(rate: number) {
		playbackRate = Math.max(0.25, Math.min(4, rate));
		if (videoEl) videoEl.playbackRate = playbackRate;
	}

	/** Draw static waveform bars on both canvases (called only when peaks change). */
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

		// Draw bars: peaks upward from bottom
		bgCtx.fillStyle = '#2a2a4a';
		fgCtx.fillStyle = '#7c3aed';
		for (let i = 0; i < WAVEFORM_BINS; i++) {
			const amp = waveformPeaks[i] / maxPeak;
			const barH = Math.max(0.5, amp * (h - 2));
			const x = i * barW;
			bgCtx.fillRect(x, h - barH, Math.max(barW - 0.5, 0.5), barH);
			fgCtx.fillRect(x, h - barH, Math.max(barW - 0.5, 0.5), barH);
		}
	}

	let rafId: number | null = null;

	/** rAF loop: only updates progress/currentTime (no canvas drawing). */
	function waveformLoop() {
		rafId = null;
		if (!waveformActive) return;
		if (!isSeeking && videoEl && currentClip) {
			const bounds = getClipLocalBounds(currentClip);
			if (bounds) {
				const clipDur = bounds.localEnd - bounds.localStart;
				const elapsed = videoEl.currentTime - bounds.localStart;
				progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
				currentTime = formatDuration(elapsed);
				currentLocalTime = videoEl.currentTime;
			}
		}
		if (playing || isDraggingWaveform) {
			rafId = requestAnimationFrame(waveformLoop);
		}
	}

	/** Start the continuous rAF loop (playing / dragging). */
	function startWaveformLoop() {
		if (rafId != null) return;
		rafId = requestAnimationFrame(waveformLoop);
	}

	// --- Waveform pointer handlers ---
	function waveformSeekFromEvent(e: PointerEvent) {
		const el = waveformSeekEl;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		progress = x;
		if (currentClip) {
			const bounds = getClipLocalBounds(currentClip);
			if (bounds) currentTime = formatDuration(x * (bounds.localEnd - bounds.localStart));
		}
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
		if (videoEl && currentClip) {
			const bounds = getClipLocalBounds(currentClip);
			if (bounds) {
				videoEl.currentTime = bounds.localStart + progress * (bounds.localEnd - bounds.localStart);
			}
		}
		isSeeking = false;
	}

	// --- Waveform background scan ---
	function stopWaveformScan() {
		if (scanAbort) {
			scanAbort.abort();
			scanAbort = null;
		}
	}

	function startWaveformScan(clip: ClipRegion) {
		stopWaveformScan();

		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return;

		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		const localStart = clip.startTime - anchor + offset;
		const localEnd = clip.endTime - anchor + offset;
		if (localEnd <= localStart) return;

		const abort = new AbortController();
		scanAbort = abort;

		fetch(`/api/waveform/${clip.streamId}?start=${localStart.toFixed(3)}&end=${localEnd.toFixed(3)}`, {
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

	// --- Clip boundary adjustment ---
	function updateClipBounds(clip: ClipRegion, newStart: number, newEnd: number) {
		if (newEnd <= newStart) return;
		pushUndo({ type: 'update-region', before: { ...clip } });
		const updated = { ...clip, startTime: newStart, endTime: newEnd };
		clipRegions.update((regions) => regions.map((r) => (r.id === updated.id ? updated : r)));
		saveClipRegion(updated);

		// Immediately refresh display for the new bounds
		const clipDur = newEnd - newStart;
		durationText = formatDuration(clipDur);
		if (videoEl) {
			const bounds = getClipLocalBounds(updated);
			if (bounds) {
				const elapsed = videoEl.currentTime - bounds.localStart;
				progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
				currentTime = formatDuration(Math.max(0, elapsed));
			}
		}

		// Rescan waveform for new boundaries
		waveformPeaks = new Float32Array(WAVEFORM_BINS);
		drawStaticWaveform();
		stopWaveformScan();
		startWaveformScan(updated);
	}

	function getMasterTimeAtPlayhead(): number | null {
		if (!currentClip) return null;
		// Derive from progress (the visual playhead position) rather than
		// videoEl.currentTime, which lags behind after HLS keyframe seeks.
		const clipDur = currentClip.endTime - currentClip.startTime;
		return currentClip.startTime + progress * clipDur;
	}

	// Live update during drag (local state only, no server save)
	let preDragCamSnapshot: CameraBoundsEntry | null | undefined = undefined;

	function handleCamRegionChange(region: { camX: number; camY: number; camW: number; camH: number }) {
		if (!currentClip) return;
		// Capture pre-drag state on first change of a drag gesture
		if (preDragCamSnapshot === undefined) preDragCamSnapshot = resolvedCamBounds ? { ...resolvedCamBounds } : null;
		// Update local state for immediate visual feedback
		const stream = $streams.find((s) => s.id === currentClip!.streamId);
		resolvedCamBounds = {
			id: resolvedCamBounds?.id ?? 0,
			channel: stream?.channel ?? '',
			timestamp: currentClip!.startTime,
			camX: region.camX,
			camY: region.camY,
			camW: region.camW,
			camH: region.camH
		};
	}

	// Persist on drag end
	function handleCamRegionSave(region: { camX: number; camY: number; camW: number; camH: number }) {
		if (!currentClip) return;
		const stream = $streams.find((s) => s.id === currentClip!.streamId);
		if (!stream) return;
		if (preDragCamSnapshot !== undefined) {
			pushUndo({ type: 'set-cam-bounds', before: preDragCamSnapshot });
			preDragCamSnapshot = undefined;
		}
		saveCameraBounds(stream.channel, currentClip!.startTime, region.camX, region.camY, region.camW, region.camH)
			.then((entry) => {
				resolvedCamBounds = entry;
			});
	}

	function clearCamRegion() {
		if (!currentClip || !resolvedCamBounds) return;
		pushUndo({ type: 'delete-cam-bounds', before: { ...resolvedCamBounds } });
		removeCameraBounds(resolvedCamBounds.id);
		resolvedCamBounds = null;
	}

	async function splitAtPlayhead() {
		if (!currentClip) return;
		const mt = getMasterTimeAtPlayhead();
		if (mt == null) return;
		const snapshot = { ...currentClip };
		const result = await splitClipRegion(currentClip, mt);
		if (!result) return;
		pushUndo({
			type: 'split-region',
			original: snapshot,
			createdIds: [result.firstHalf.id, result.secondHalf.id]
		});
		loadedClipId = null;
	}

	// --- Keyboard shortcuts ---
	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		// Ctrl/Cmd+Z: Undo (works even without a current clip)
		if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
			e.preventDefault();
			applyUndo();
			return;
		}

		if (!currentClip || editingId) return;

		switch (e.key) {
			case ' ':
				e.preventDefault();
				togglePlay();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				if (videoEl) videoEl.currentTime -= 3;
				break;
			case 'ArrowRight':
				e.preventDefault();
				if (videoEl) videoEl.currentTime += 3;
				break;
			case 'ArrowUp':
				e.preventDefault();
				setRate(playbackRate + 0.25);
				break;
			case 'ArrowDown':
				e.preventDefault();
				setRate(playbackRate - 0.25);
				break;
			case 'a': {
				// a: extend start by 1s
				const clip = currentClip;
				updateClipBounds(clip, clip.startTime - 1, clip.endTime);
				break;
			}
			case 'A': {
				// Shift+A: move start to playhead, then seek to new start
				const mt = getMasterTimeAtPlayhead();
				if (mt != null && mt < currentClip.endTime) {
					updateClipBounds(currentClip, mt, currentClip.endTime);
					if (videoEl) videoEl.currentTime = videoEl.currentTime; // trigger timeupdate
					// Seek to the new clip start
					const stream = $streams.find((s) => s.id === currentClip.streamId);
					if (stream && videoEl) {
						const offset = $syncOffsets[currentClip.streamId] || 0;
						const anchor = stream.startedAt / 1000;
						videoEl.currentTime = mt - anchor + offset;
					}
				}
				break;
			}
			case 'd': {
				// d: extend end by 1s
				const clip = currentClip;
				updateClipBounds(clip, clip.startTime, clip.endTime + 1);
				break;
			}
			case 'D': {
				// Shift+D: move end to playhead
				const mt = getMasterTimeAtPlayhead();
				if (mt != null && mt > currentClip.startTime) {
					updateClipBounds(currentClip, currentClip.startTime, mt);
				}
				break;
			}
			case 's':
			case 'S':
				splitAtPlayhead();
				break;
			case 'f':
				toggleFavourite(currentClip);
				break;
			case 'c':
				camRegionActive = !camRegionActive;
				break;
			case 'p':
			case 'P':
				transcriptPanelOpen = !transcriptPanelOpen;
				break;
			case 'C':
				chatPanelOpen = !chatPanelOpen;
				break;
		}
	}

	// Waveform lifecycle
	$effect(() => {
		if (waveformBgCanvas && waveformFgCanvas) {
			waveformActive = true;
			drawStaticWaveform();
			if (playing) startWaveformLoop();
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
			if (hls) {
				hls.destroy();
				hls = null;
			}
			waveformActive = false;
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			stopWaveformScan();
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="review-page">
	{#if !currentClip}
		<div class="empty-state">
			{#if urlClipId}
				<div class="empty-icon">?</div>
				<p>Clip not found</p>
				<p class="empty-hint">No clip with ID "{urlClipId}"</p>
			{:else}
				<div class="empty-icon">&#10003;</div>
				<p>No AI clips to review</p>
				<p class="empty-hint">AI-created clips will appear here for your review</p>
			{/if}
			{#if undoStack.length > 0}
				<button class="btn-action btn-undo empty-undo" onclick={applyUndo} title="Undo (Ctrl+Z)">
					&#8630; Undo<span class="undo-count">{undoStack.length}</span>
				</button>
			{/if}
		</div>
	{:else}
		{@const clip = currentClip}
		{@const dur = clip.endTime - clip.startTime}
		{@const isEditing = editingId === clip.id}

		<div class="review-counter">
			{#if isUrlMode}
				Editing clip {clip.id}
			{:else}
				{aiClips.length} clip{aiClips.length !== 1 ? 's' : ''} to review
			{/if}
			<div class="panel-toggles">
				<button
					class="panel-toggle"
					class:active={transcriptPanelOpen}
					onclick={() => (transcriptPanelOpen = !transcriptPanelOpen)}
					title="Toggle transcript panel (P)"
				>T</button>
				<button
					class="panel-toggle"
					class:active={chatPanelOpen}
					onclick={() => (chatPanelOpen = !chatPanelOpen)}
					title="Toggle chat panel (Shift+C)"
				>C</button>
			</div>
		</div>

		<div class="review-body">
			<div class="review-card">
				<!-- Video preview -->
				<div class="video-container">
					<!-- svelte-ignore a11y_media_has_caption -->
					<video bind:this={videoEl} ontimeupdate={handleTimeUpdate} playsinline class="review-video"></video>
					<CameraRegionOverlay
						{videoEl}
						camX={resolvedCamBounds?.camX}
						camY={resolvedCamBounds?.camY}
						camW={resolvedCamBounds?.camW}
						camH={resolvedCamBounds?.camH}
						active={camRegionActive}
						onchange={handleCamRegionChange}
						onsave={handleCamRegionSave}
					/>
					<div class="video-controls">
						<div class="timeline-row">
							<button class="btn-ctl" onclick={togglePlay}>
								{playing ? '⏸' : '▶'}
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
									style="clip-path: inset(0 {(1 - progress) * 100}% 0 0)"
								></canvas>
								{#each transcriptionRegions as region}
									<div
										class="transcript-region"
										style="left: {region.startFrac * 100}%; width: {(region.endFrac - region.startFrac) * 100}%"
										title={region.text}
									></div>
								{/each}
								<div class="waveform-playhead" style="left: {progress * 100}%"></div>
							</div>
						</div>
						<div class="transport-row">
							<span class="vid-time">{currentTime}</span>
							<span style="flex:1"></span>
							<span class="vid-time">{durationText}</span>
							<span class="vid-speed">{playbackRate}x</span>
						</div>
					</div>
				</div>

				<!-- Clip info -->
				<div class="clip-info">
					{#if isEditing}
						<input
							type="text"
							class="edit-input edit-title"
							bind:value={editTitle}
							placeholder="Clip title..."
							onkeydown={(e) => {
								if (e.key === 'Enter') saveEdit();
								if (e.key === 'Escape') cancelEdit();
							}}
						/>
						<textarea
							class="edit-input edit-notes"
							bind:value={editNotes}
							placeholder="Notes..."
							rows="3"
							onkeydown={(e) => {
								if (e.key === 'Escape') cancelEdit();
							}}
						></textarea>
						<div class="edit-actions">
							<button class="btn-sm btn-save" onclick={saveEdit}>Save</button>
							<button class="btn-sm btn-cancel" onclick={cancelEdit}>Cancel</button>
						</div>
					{:else}
						<div class="clip-header">
							<span class="clip-channel">{clipChannel(clip)}</span>
							<span class="clip-badge" class:ai={clip.createdBy === 'ai'}>{clip.createdBy === 'ai' ? 'AI' : 'Human'}</span>
							{#if clip.favourite}
								<span class="fav-badge">&#9733;</span>
							{/if}
							{#if resolvedCamBounds != null}
								<span class="cam-badge">CAM</span>
							{/if}
						</div>
						<div class="clip-title">{clip.title || 'Untitled'}</div>
						{#if clip.notes}
							<div class="clip-notes">{clip.notes}</div>
						{/if}
						<div class="clip-details">
							<span>{clipDate(clip.startTime)}</span>
							<span class="clip-dur">{formatDuration(dur)}</span>
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<span class="clip-id" onclick={() => copyClipId(clip.id)} title="Click to copy">{clip.id}</span>
						</div>
					{/if}
				</div>

				<!-- Action buttons -->
				{#if !isEditing}
					<div class="review-actions">
						<button class="btn-action btn-approve" onclick={() => approveClip(clip)}>
							<span class="action-icon">&#10003;</span> Approve
						</button>
						<button
							class="btn-action btn-fav"
							class:fav-active={clip.favourite}
							onclick={() => toggleFavourite(clip)}
							title="Toggle favourite (F)"
						>
							<span class="action-icon">{clip.favourite ? '\u2605' : '\u2606'}</span>
						</button>
						<button
							class="btn-action btn-delete"
							class:confirming={deleteConfirmId === clip.id}
							onclick={() => handleDelete(clip.id)}
						>
							{#if deleteConfirmId === clip.id}
								Press again to delete
							{:else}
								<span class="action-icon">&#10005;</span> Delete
							{/if}
						</button>
						<button class="btn-action btn-edit" onclick={() => startEdit(clip)}>
							<span class="action-icon">&#9998;</span> Edit
						</button>
						<button
							class="btn-action btn-camera"
							class:cam-active={camRegionActive}
							onclick={() => (camRegionActive = !camRegionActive)}
							title="Toggle camera region (C)"
						>
							{#if resolvedCamBounds != null}
								{camRegionActive ? 'Done' : 'Edit Camera'}
							{:else}
								Set Camera
							{/if}
						</button>
						{#if resolvedCamBounds != null && camRegionActive}
							<button class="btn-action btn-cam-clear" onclick={clearCamRegion}>
								Clear
							</button>
						{/if}
						{#if undoStack.length > 0}
							<button class="btn-action btn-undo" onclick={applyUndo} title="Undo (Ctrl+Z)">
								&#8630; Undo<span class="undo-count">{undoStack.length}</span>
							</button>
						{/if}
					</div>
				{/if}
			</div>

			{#if transcriptPanelOpen}
				<ReviewTranscriptPanel {clip} {currentLocalTime} onseek={(t) => { if (videoEl) videoEl.currentTime = t; }} />
			{/if}
			{#if chatPanelOpen}
				<ClipChatPanel {clip} {currentLocalTime} onseek={(t) => { if (videoEl) videoEl.currentTime = t; }} />
			{/if}
		</div>
	{/if}
</main>

<style>
	.review-page {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 8px 12px;
		gap: 4px;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		flex: 1;
		gap: 8px;
		color: #666;
	}

	.empty-icon {
		font-size: 3rem;
		color: #4ade80;
		margin-bottom: 8px;
	}

	.empty-hint {
		font-size: 0.85rem;
		color: #555;
	}

	.review-counter {
		font-size: 0.8rem;
		color: #888;
		align-self: flex-start;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.panel-toggles {
		display: flex;
		gap: 4px;
	}

	.panel-toggle {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #666;
		font-size: 0.7rem;
		font-weight: 700;
		width: 26px;
		height: 26px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}

	.panel-toggle:hover {
		color: #aaa;
		border-color: #3a3a5a;
	}

	.panel-toggle.active {
		background: #7c3aed;
		border-color: #7c3aed;
		color: #fff;
	}

	.review-body {
		flex: 1;
		min-height: 0;
		display: flex;
		width: 100%;
	}

	.review-card {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: #0f0f23;
		border: 1px solid #1a1a2e;
		border-radius: 8px;
		overflow: hidden;
	}

	/* Video */
	.video-container {
		position: relative;
		background: #000;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.review-video {
		width: 100%;
		flex: 1;
		min-height: 0;
		object-fit: contain;
		display: block;
	}

	.video-controls {
		display: flex;
		flex-direction: column;
		background: #0a0a1a;
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

	.transcript-region {
		position: absolute;
		top: 0;
		bottom: 0;
		background: rgba(56, 189, 248, 0.15);
		border-left: 1px solid rgba(56, 189, 248, 0.3);
		pointer-events: none;
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

	.vid-speed {
		font-size: 0.7rem;
		color: #7c3aed;
		font-weight: 600;
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

	/* Clip info */
	.clip-info {
		padding: 10px 20px;
		flex-shrink: 0;
	}

	.clip-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.clip-channel {
		font-size: 0.8rem;
		color: #7c3aed;
		font-weight: 600;
		text-transform: lowercase;
	}

	.clip-badge {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.clip-badge {
		background: #1e3a2e;
		color: #4ade80;
	}

	.clip-badge.ai {
		background: #1e3a5f;
		color: #60a5fa;
	}

	.clip-title {
		font-size: 1rem;
		color: #e0e0ff;
		margin-bottom: 4px;
	}

	.clip-notes {
		font-size: 0.8rem;
		color: #888;
		margin-bottom: 6px;
		line-height: 1.4;
	}

	.clip-details {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 0.75rem;
		color: #666;
	}

	.clip-dur {
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		color: #888;
	}

	.clip-id {
		margin-left: auto;
		font-family: monospace;
		font-size: 0.7rem;
		color: #555;
		cursor: pointer;
	}

	.clip-id:hover {
		color: #888;
	}

	/* Actions */
	.review-actions {
		display: flex;
		gap: 8px;
		padding: 12px 20px 16px;
		border-top: 1px solid #1a1a2e;
	}

	.btn-action {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 18px;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		background: none;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
	}

	.action-icon {
		font-size: 0.9rem;
	}

	.btn-approve {
		color: #4ade80;
		border-color: #1a3a2e;
	}
	.btn-approve:hover {
		background: #1a3a2e;
	}

	.btn-delete {
		color: #f87171;
		border-color: #3a1a1a;
	}
	.btn-delete:hover {
		background: #3a1a1a;
	}
	.btn-delete.confirming {
		background: #5a1a1a;
		border-color: #f87171;
		font-weight: 700;
		animation: pulse-delete 0.6s ease-in-out infinite alternate;
	}

	@keyframes pulse-delete {
		from {
			opacity: 0.7;
		}
		to {
			opacity: 1;
		}
	}

	.btn-edit {
		color: #aaa;
	}
	.btn-edit:hover {
		background: #2a2a4a;
		color: #fff;
	}

	.btn-undo {
		color: #fbbf24;
		border-color: #3a3a1a;
	}
	.btn-undo:hover {
		background: #3a3a1a;
	}

	.undo-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: rgba(251, 191, 36, 0.2);
		color: #fbbf24;
		font-size: 0.6rem;
		font-weight: 700;
		min-width: 16px;
		height: 16px;
		border-radius: 8px;
		margin-left: 6px;
		padding: 0 4px;
	}

	.empty-undo {
		margin-top: 16px;
	}

	/* Edit mode */
	.edit-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.8rem;
		padding: 6px 10px;
		border-radius: 4px;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.edit-input:focus {
		border-color: #7c3aed;
	}

	.edit-title {
		margin-bottom: 6px;
	}

	.edit-notes {
		resize: vertical;
		font-family: inherit;
		margin-bottom: 6px;
	}

	.edit-actions {
		display: flex;
		gap: 6px;
	}

	.btn-sm {
		font-size: 0.75rem;
		padding: 4px 14px;
		border-radius: 4px;
		border: none;
		cursor: pointer;
	}

	.btn-save {
		background: #7c3aed;
		color: #fff;
	}
	.btn-save:hover {
		background: #6d28d9;
	}
	.btn-cancel {
		background: #2a2a4a;
		color: #ccc;
	}
	.btn-cancel:hover {
		background: #3a3a5a;
	}

	.cam-badge {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(168, 85, 247, 0.2);
		color: #a855f7;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.btn-camera {
		color: #a855f7;
		border-color: #3a2a5a;
	}
	.btn-camera:hover {
		background: #3a2a5a;
	}
	.btn-camera.cam-active {
		background: #3a2a5a;
		border-color: #a855f7;
	}

	.btn-cam-clear {
		color: #f87171;
		border-color: #3a1a1a;
	}
	.btn-cam-clear:hover {
		background: #3a1a1a;
	}

	.btn-fav {
		color: #666;
		border-color: #2a2a4a;
	}
	.btn-fav:hover {
		color: #fbbf24;
		background: #3a3a1a;
	}
	.btn-fav.fav-active {
		color: #fbbf24;
		border-color: #3a3a1a;
	}

	.fav-badge {
		font-size: 0.7rem;
		color: #fbbf24;
	}
</style>
