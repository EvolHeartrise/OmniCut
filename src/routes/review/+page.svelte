<script lang="ts">
	import Hls from 'hls.js';
	import {
		streams,
		syncOffsets,
		clipRegions,
		saveClipRegion,
		deleteClipRegion,
		clipEncodeStatuses,
		type ClipRegion
	} from '$lib/stores/streams.js';
	import { formatDuration, createHlsConfig } from '$lib/utils.js';
	import { getClipEncodeStatuses, getMultiStreamTranscriptions } from '$lib/streams.remote';
	import { splitClipRegion } from '$lib/clipActions.js';
	import { untrack } from 'svelte';

	// --- Current clip under review (oldest AI clip) ---
	let aiClips = $derived(
		[...$clipRegions].filter((c) => c.createdBy === 'ai').sort((a, b) => a.startTime - b.startTime)
	);
	let currentClip = $derived<ClipRegion | null>(aiClips[0] ?? null);

	// --- Delete confirmation ---
	let deleteConfirmId = $state<string | null>(null);
	let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Undo stack ---
	type ReviewUndoEntry =
		| { type: 'update-region'; before: ClipRegion }
		| { type: 'delete-region'; region: ClipRegion }
		| { type: 'split-region'; original: ClipRegion; createdIds: [string, string] };

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
	let durationText = $state('0:00');
	let isSeeking = $state(false);
	let loadedClipId = $state<string | null>(null);
	let playbackRate = $state(1);

	// --- Transcription regions ---
	let transcriptionRegions = $state<Array<{ startFrac: number; endFrac: number; text: string }>>([]);

	// --- Waveform ---
	const WAVEFORM_BINS = 800;
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

	function fmtTime(seconds: number): string {
		const s = Math.max(0, Math.floor(seconds));
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}

	function getClipLocalBounds(clip: ClipRegion): { localStart: number; localEnd: number } | null {
		const stream = $streams.find((s) => s.id === clip.streamId);
		if (!stream) return null;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		return { localStart: clip.startTime - anchor + offset, localEnd: clip.endTime - anchor + offset };
	}

	function encodeStatusInfo(status: string | undefined): { label: string; cls: string } {
		switch (status) {
			case 'ready':
				return { label: 'Encoded', cls: 'badge-ready' };
			case 'encoding':
				return { label: 'Encoding...', cls: 'badge-encoding' };
			case 'pending':
				return { label: 'Pending', cls: 'badge-pending' };
			case 'error':
				return { label: 'Error', cls: 'badge-error' };
			default:
				return { label: 'Unknown', cls: 'badge-unknown' };
		}
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

		const autoPlay = () => {
			videoEl!.playbackRate = playbackRate;
			videoEl!
				.play()
				.then(() => {
					playing = true;
					startWaveformLoop();
				})
				.catch(() => {});
		};

		if (Hls.isSupported()) {
			const h = new Hls(createHlsConfig(false));
			hls = h;
			h.loadSource(url);
			h.attachMedia(videoEl);
			h.on(Hls.Events.MANIFEST_PARSED, () => {
				videoEl!.currentTime = localStart;
				autoPlay();
			});
			h.on(Hls.Events.ERROR, (_event, data) => {
				if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					h.recoverMediaError();
				}
			});
		} else {
			videoEl.src = url;
			videoEl.currentTime = localStart;
			autoPlay();
		}

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
		durationText = fmtTime(clip.endTime - clip.startTime);
		waveformPeaks = new Float32Array(WAVEFORM_BINS);
		editingId = null;
		deleteConfirmId = null;
		// Wait for DOM
		requestAnimationFrame(() => setupPlayer(clip));
	});

	// Fetch encode statuses
	$effect(() => {
		const clip = currentClip;
		if (!clip) return;
		getClipEncodeStatuses({ clipIds: [clip.id] })
			.then((statuses) => clipEncodeStatuses.update((c) => ({ ...c, ...statuses })))
			.catch(() => {});
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

	// Clamp playback to clip bounds
	function handleTimeUpdate() {
		if (!videoEl || !currentClip) return;
		const bounds = getClipLocalBounds(currentClip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;

		if (videoEl.currentTime >= localEnd) {
			videoEl.pause();
			playing = false;
			videoEl.currentTime = localStart;
			progress = 0;
			currentTime = '0:00';
		} else if (!isSeeking) {
			const elapsed = videoEl.currentTime - localStart;
			progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			currentTime = fmtTime(elapsed);
		}
		durationText = fmtTime(clipDur);
	}

	function handleSeekInput(e: Event) {
		isSeeking = true;
		const value = +(e.target as HTMLInputElement).value;
		progress = value;
		if (currentClip) {
			const bounds = getClipLocalBounds(currentClip);
			if (bounds) currentTime = fmtTime(value * (bounds.localEnd - bounds.localStart));
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
		const halfH = h / 2;

		// Center line (bg only)
		bgCtx.strokeStyle = '#1a1a2e';
		bgCtx.lineWidth = 1;
		bgCtx.beginPath();
		bgCtx.moveTo(0, halfH);
		bgCtx.lineTo(w, halfH);
		bgCtx.stroke();

		// Draw bars: bg = unplayed color, fg = played color
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
				currentTime = fmtTime(elapsed);
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
			if (bounds) currentTime = fmtTime(x * (bounds.localEnd - bounds.localStart));
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
		durationText = fmtTime(clipDur);
		if (videoEl) {
			const bounds = getClipLocalBounds(updated);
			if (bounds) {
				const elapsed = videoEl.currentTime - bounds.localStart;
				progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
				currentTime = fmtTime(Math.max(0, elapsed));
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
			<div class="empty-icon">&#10003;</div>
			<p>No AI clips to review</p>
			<p class="empty-hint">AI-created clips will appear here for your review</p>
			{#if undoStack.length > 0}
				<button class="btn-action btn-undo empty-undo" onclick={applyUndo} title="Undo (Ctrl+Z)">
					&#8630; Undo<span class="undo-count">{undoStack.length}</span>
				</button>
			{/if}
		</div>
	{:else}
		{@const clip = currentClip}
		{@const dur = clip.endTime - clip.startTime}
		{@const encStatus = $clipEncodeStatuses[clip.id]}
		{@const badge = encodeStatusInfo(encStatus)}
		{@const isEditing = editingId === clip.id}

		<div class="review-counter">{aiClips.length} clip{aiClips.length !== 1 ? 's' : ''} to review</div>

		<div class="review-card">
			<!-- Video preview -->
			<div class="video-container">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} ontimeupdate={handleTimeUpdate} playsinline class="review-video"></video>
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
						<span class="clip-badge ai">AI</span>
						<span class="encode-badge {badge.cls}">{badge.label}</span>
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
					{#if undoStack.length > 0}
						<button class="btn-action btn-undo" onclick={applyUndo} title="Undo (Ctrl+Z)">
							&#8630; Undo<span class="undo-count">{undoStack.length}</span>
						</button>
					{/if}
				</div>
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
	}

	.review-card {
		width: 100%;
		flex: 1;
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

	.encode-badge {
		font-size: 0.6rem;
		padding: 1px 6px;
		border-radius: 3px;
		font-weight: 500;
	}

	.badge-ready {
		background: rgba(22, 163, 74, 0.15);
		color: #4ade80;
	}
	.badge-encoding {
		background: rgba(234, 179, 8, 0.15);
		color: #fbbf24;
	}
	.badge-pending {
		background: rgba(100, 100, 100, 0.15);
		color: #999;
	}
	.badge-error {
		background: rgba(220, 38, 38, 0.15);
		color: #f87171;
	}
	.badge-unknown {
		background: rgba(80, 80, 80, 0.15);
		color: #666;
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

	.btn-copy {
		color: #aaa;
		margin-left: auto;
	}
	.btn-copy:hover {
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
</style>
