<script lang="ts">
	import { tick } from 'svelte';
	import { get } from 'svelte/store';
	import Hls from 'hls.js';
	import {
		streams,
		syncOffsets,
		clipRegions,
		deleteClipRegion,
		saveClipRegion,
		type ClipRegion
	} from '$lib/stores/streams.js';

	interface ClipSegment {
		clip: ClipRegion;
		channel: string;
		cumulativeStart: number;
		duration: number;
		localStart: number; // video-local start time
		localEnd: number;   // video-local end time
	}

	// Build sorted concatenated clip segments
	let sortedClips = $derived(
		[...$clipRegions].sort((a, b) => a.startTime - b.startTime)
	);

	let segments = $derived.by(() => {
		let cumulative = 0;
		const result: ClipSegment[] = [];
		for (const clip of sortedClips) {
			const stream = $streams.find((s) => s.id === clip.streamId);
			if (!stream) continue;
			const offset = $syncOffsets[clip.streamId] || 0;
			const anchor = stream.startedAt / 1000;
			const dur = clip.endTime - clip.startTime;
			if (dur <= 0) continue;
			result.push({
				clip,
				channel: stream.channel,
				cumulativeStart: cumulative,
				duration: dur,
				localStart: clip.startTime - anchor + offset,
				localEnd: clip.endTime - anchor + offset
			});
			cumulative += dur;
		}
		return result;
	});

	let totalDuration = $derived(
		segments.length > 0
			? segments[segments.length - 1].cumulativeStart + segments[segments.length - 1].duration
			: 0
	);

	// Own playback state
	let playing = $state(false);
	let playbackRate = $state(1);
	let cleaningTime = $state(0); // virtual timeline position in seconds
	let currentSegIndex = $state(0);

	// Dual video players for seamless clip transitions
	let videoElA = $state<HTMLVideoElement | null>(null);
	let videoElB = $state<HTMLVideoElement | null>(null);
	let activePlayer = $state<'A' | 'B'>('A');
	let videoEl = $derived(activePlayer === 'A' ? videoElA : videoElB);

	interface HlsSlot { hls: Hls | null; streamId: string | null; }
	const slots: Record<'A' | 'B', HlsSlot> = {
		A: { hls: null, streamId: null },
		B: { hls: null, streamId: null }
	};
	let preloadedForSeg = $state<number | null>(null);

	let rafId: number;
	let lastFrameTime = 0;
	let suppressTimeUpdate = false;
	let loadingSource = false; // true while waiting for new HLS source to become playable

	// Zoom & scroll state
	const MIN_PPS = 1;
	const MAX_PPS = 200;
	let pixelsPerSecond = $state(20);
	let autoScroll = $state(true);
	let scrollAreaEl = $state<HTMLDivElement | null>(null);
	let ignoreScrollEvents = false;

	let contentWidth = $derived(Math.max(totalDuration * pixelsPerSecond, 100));
	let playheadX = $derived(cleaningTime * pixelsPerSecond);

	// Apply playback rate to video element
	$effect(() => {
		if (videoEl) videoEl.playbackRate = playbackRate;
	});

	// Find which segment the cleaning playhead is in
	function segmentAtTime(t: number): number {
		for (let i = segments.length - 1; i >= 0; i--) {
			if (t >= segments[i].cumulativeStart) return i;
		}
		return 0;
	}

	/** Set up HLS on a specific player slot. Calls onReady when canplay fires. */
	function setupHlsOnSlot(slot: 'A' | 'B', streamId: string, onReady?: () => void) {
		const s = slots[slot];
		const el = slot === 'A' ? videoElA : videoElB;
		if (!el) return;

		if (s.hls) { s.hls.destroy(); s.hls = null; }
		s.streamId = streamId;
		const url = `/hls/${streamId}/playlist.m3u8`;

		if (!Hls.isSupported()) {
			el.src = url;
		} else {
			const h = new Hls({
				enableWorker: true,
				lowLatencyMode: false,
				backBufferLength: Infinity,
				maxBufferLength: 30,
				maxMaxBufferLength: 600
			});
			s.hls = h;
			h.loadSource(url);
			h.attachMedia(el);
			h.on(Hls.Events.MANIFEST_PARSED, () => {
				el.playbackRate = playbackRate;
			});
			h.on(Hls.Events.ERROR, (_event, data) => {
				if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					h.recoverMediaError();
				}
			});
		}

		if (onReady) {
			const onCanPlay = () => {
				el.removeEventListener('canplay', onCanPlay);
				onReady();
			};
			el.addEventListener('canplay', onCanPlay);
		}
	}

	/** Preload the next segment's stream on the inactive player. */
	function preloadNext(nextIdx: number) {
		if (nextIdx >= segments.length) {
			preloadedForSeg = null;
			return;
		}
		const nextSeg = segments[nextIdx];
		const activeS = slots[activePlayer];

		// Same stream as current — no preload needed, just a seek when we get there
		if (nextSeg.clip.streamId === activeS.streamId) {
			preloadedForSeg = null;
			return;
		}

		const preloadKey: 'A' | 'B' = activePlayer === 'A' ? 'B' : 'A';
		const preloadS = slots[preloadKey];
		const preEl = preloadKey === 'A' ? videoElA : videoElB;

		// Already have the right stream loaded on preload player — just seek
		if (preloadS.streamId === nextSeg.clip.streamId) {
			if (preEl) {
				preEl.currentTime = nextSeg.localStart;
				preEl.pause();
			}
			preloadedForSeg = nextIdx;
			return;
		}

		// Load the next stream on the preload player
		setupHlsOnSlot(preloadKey, nextSeg.clip.streamId, () => {
			if (preEl) {
				preEl.currentTime = nextSeg.localStart;
				preEl.pause();
				preEl.muted = true;
			}
			preloadedForSeg = nextIdx;
		});
	}

	function loadSegment(idx: number) {
		if (idx < 0 || idx >= segments.length) return;
		const seg = segments[idx];
		currentSegIndex = idx;

		const preloadKey: 'A' | 'B' = activePlayer === 'A' ? 'B' : 'A';
		const preloadS = slots[preloadKey];

		// Check if preload player has the right stream ready for this segment
		if (preloadedForSeg === idx && preloadS.streamId === seg.clip.streamId) {
			// Swap to preloaded player
			const oldEl = activePlayer === 'A' ? videoElA : videoElB;
			if (oldEl) { oldEl.pause(); oldEl.muted = true; }

			activePlayer = preloadKey;
			preloadedForSeg = null;
			loadingSource = false;

			const newEl = activePlayer === 'A' ? videoElA : videoElB;
			if (newEl) newEl.muted = false;

			seekToSegmentPosition(idx);
			lastFrameTime = performance.now();
			if (playing) newEl?.play().catch(() => {});

			preloadNext(idx + 1);
			return;
		}

		// No preload available — load on active player
		preloadedForSeg = null;
		const activeS = slots[activePlayer];
		const el = activePlayer === 'A' ? videoElA : videoElB;
		if (!el) return;

		if (activeS.streamId !== seg.clip.streamId) {
			// Different stream — reload HLS; freeze timeline until ready
			loadingSource = true;
			setupHlsOnSlot(activePlayer, seg.clip.streamId, () => {
				seekToSegmentPosition(idx);
				loadingSource = false;
				lastFrameTime = performance.now();
				if (playing) el.play().catch(() => {});
				preloadNext(idx + 1);
			});
		} else {
			// Same stream — just seek
			seekToSegmentPosition(idx);
			if (playing) el.play().catch(() => {});
			preloadNext(idx + 1);
		}
	}

	function seekToSegmentPosition(idx: number) {
		if (!videoEl || idx >= segments.length) return;
		const seg = segments[idx];
		const offsetInClip = cleaningTime - seg.cumulativeStart;
		const localTime = seg.localStart + Math.max(0, Math.min(offsetInClip, seg.duration));
		suppressTimeUpdate = true;
		videoEl.currentTime = localTime;
	}

	function togglePlayPause() {
		if (segments.length === 0) return;
		playing = !playing;
		if (playing) {
			lastFrameTime = performance.now();
			loadSegment(segmentAtTime(cleaningTime));
			videoEl?.play().catch(() => {});
			autoScroll = true;
			rafId = requestAnimationFrame(advanceLoop);
		} else {
			videoEl?.pause();
			cancelAnimationFrame(rafId);
		}
	}

	function advanceLoop() {
		if (!playing) return;
		const now = performance.now();
		if (loadingSource) {
			// Don't advance timeline while waiting for new HLS source
			lastFrameTime = 0;
			rafId = requestAnimationFrame(advanceLoop);
			return;
		}
		if (lastFrameTime > 0) {
			const delta = ((now - lastFrameTime) / 1000) * playbackRate;
			cleaningTime += delta;

			// Check if we've crossed a segment boundary
			if (currentSegIndex < segments.length) {
				const seg = segments[currentSegIndex];
				if (cleaningTime >= seg.cumulativeStart + seg.duration) {
					// Move to next segment
					const nextIdx = currentSegIndex + 1;
					if (nextIdx < segments.length) {
						cleaningTime = segments[nextIdx].cumulativeStart;
						loadSegment(nextIdx);
					} else {
						// Reached the end
						cleaningTime = totalDuration;
						playing = false;
						videoEl?.pause();
						lastFrameTime = 0;
						return;
					}
				}
			}

			// Auto-scroll to keep playhead centered
			if (autoScroll && scrollAreaEl) {
				ignoreScrollEvents = true;
				scrollAreaEl.scrollLeft = playheadX - scrollAreaEl.clientWidth / 2;
			}
		}
		lastFrameTime = now;
		rafId = requestAnimationFrame(advanceLoop);
	}

	function handleTimeUpdate(e: Event) {
		const activeEl = activePlayer === 'A' ? videoElA : videoElB;
		if (e.target !== activeEl) return; // Ignore preload player events
		if (suppressTimeUpdate) {
			suppressTimeUpdate = false;
			return;
		}
		// Sync cleaningTime from video's actual position
		if (currentSegIndex < segments.length && playing) {
			const seg = segments[currentSegIndex];
			const localPos = activeEl!.currentTime - seg.localStart;
			cleaningTime = seg.cumulativeStart + Math.max(0, localPos);
		}
	}

	function seekTo(t: number) {
		cleaningTime = Math.max(0, Math.min(t, totalDuration));
		const idx = segmentAtTime(cleaningTime);
		loadSegment(idx);
	}

	function handleTimelineClick(e: MouseEvent) {
		if (!scrollAreaEl) return;
		const rect = scrollAreaEl.getBoundingClientRect();
		const x = e.clientX - rect.left + scrollAreaEl.scrollLeft;
		seekTo(x / pixelsPerSecond);
	}

	function handleScroll() {
		if (ignoreScrollEvents) {
			ignoreScrollEvents = false;
			return;
		}
		if (playing) autoScroll = false;
	}

	function handleWheel(e: WheelEvent) {
		if (e.ctrlKey) {
			e.preventDefault();
			if (!scrollAreaEl) return;
			const rect = scrollAreaEl.getBoundingClientRect();
			const cursorX = e.clientX - rect.left;
			const cursorScrollX = scrollAreaEl.scrollLeft + cursorX;
			const timeUnderCursor = cursorScrollX / pixelsPerSecond;
			const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
			pixelsPerSecond = Math.min(MAX_PPS, Math.max(MIN_PPS, pixelsPerSecond * factor));
			tick().then(() => {
				if (!scrollAreaEl) return;
				const newCursorScrollX = timeUnderCursor * pixelsPerSecond;
				ignoreScrollEvents = true;
				scrollAreaEl.scrollLeft = newCursorScrollX - cursorX;
			});
		} else if (e.shiftKey) {
			e.preventDefault();
			if (!scrollAreaEl) return;
			scrollAreaEl.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
		}
	}

	// Undo stack
	type CleaningUndoEntry =
		| { type: 'delete'; clip: ClipRegion }
		| { type: 'split'; original: ClipRegion; createdIds: [string, string] };

	let undoStack = $state<CleaningUndoEntry[]>([]);

	function removeClip(clip: ClipRegion) {
		undoStack = [...undoStack, { type: 'delete', clip: { ...clip } }];
		clipRegions.update((regions) => regions.filter((r) => r.id !== clip.id));
		deleteClipRegion(clip.id, clip.streamId);
	}

	function splitClip(clip: ClipRegion, splitMasterTime: number) {
		if (splitMasterTime <= clip.startTime || splitMasterTime >= clip.endTime) return;
		const firstHalf: ClipRegion = {
			id: crypto.randomUUID(),
			streamId: clip.streamId,
			startTime: clip.startTime,
			endTime: splitMasterTime
		};
		const secondHalf: ClipRegion = {
			id: crypto.randomUUID(),
			streamId: clip.streamId,
			startTime: splitMasterTime,
			endTime: clip.endTime
		};
		clipRegions.update((regions) => [
			...regions.filter((r) => r.id !== clip.id),
			firstHalf,
			secondHalf
		]);
		deleteClipRegion(clip.id, clip.streamId);
		saveClipRegion(firstHalf);
		saveClipRegion(secondHalf);
		undoStack = [...undoStack, { type: 'split', original: clip, createdIds: [firstHalf.id, secondHalf.id] }];
	}

	function applyUndo() {
		if (undoStack.length === 0) return;
		const entry = undoStack[undoStack.length - 1];
		undoStack = undoStack.slice(0, -1);

		switch (entry.type) {
			case 'delete':
				clipRegions.update((regions) => [...regions, entry.clip]);
				saveClipRegion(entry.clip);
				break;
			case 'split': {
				const { original, createdIds } = entry;
				clipRegions.update((regions) => [
					...regions.filter((r) => !createdIds.includes(r.id)),
					original
				]);
				deleteClipRegion(createdIds[0], original.streamId);
				deleteClipRegion(createdIds[1], original.streamId);
				saveClipRegion(original);
				break;
			}
		}
	}

	function nudgeClipBoundary(field: 'startTime' | 'endTime', delta: number) {
		if (currentSegIndex >= segments.length) return;
		const seg = segments[currentSegIndex];
		const clip = seg.clip;

		const updated = { ...clip, [field]: clip[field] + delta };
		// Don't allow start >= end
		if (updated.startTime >= updated.endTime) return;

		clipRegions.update((regions) =>
			regions.map((r) => (r.id === clip.id ? updated : r))
		);
		saveClipRegion(updated);

		// Re-seek if playhead is now outside the adjusted clip
		tick().then(() => {
			if (currentSegIndex < segments.length) {
				const newSeg = segments[currentSegIndex];
				if (cleaningTime < newSeg.cumulativeStart || cleaningTime > newSeg.cumulativeStart + newSeg.duration) {
					cleaningTime = Math.max(newSeg.cumulativeStart, Math.min(cleaningTime, newSeg.cumulativeStart + newSeg.duration));
				}
				seekToSegmentPosition(currentSegIndex);
			}
		});
	}

	function formatDuration(sec: number): string {
		const m = Math.floor(sec / 60);
		const s = Math.floor(sec % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function zoomIn() {
		pixelsPerSecond = Math.min(MAX_PPS, pixelsPerSecond * 1.5);
	}

	function zoomOut() {
		pixelsPerSecond = Math.max(MIN_PPS, pixelsPerSecond / 1.5);
	}

	function reCenter() {
		autoScroll = true;
		if (scrollAreaEl) {
			ignoreScrollEvents = true;
			scrollAreaEl.scrollLeft = playheadX - scrollAreaEl.clientWidth / 2;
		}
	}

	// Keyboard shortcuts for cleaning mode
	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
			e.preventDefault();
			applyUndo();
			return;
		}
		if (e.key === ' ') {
			e.preventDefault();
			togglePlayPause();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			playbackRate = Math.min(4, +((playbackRate + 0.25).toFixed(2)));
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			playbackRate = Math.max(0.25, +((playbackRate - 0.25).toFixed(2)));
		} else if (e.shiftKey && e.key === 'ArrowLeft') {
			e.preventDefault();
			if (currentSegIndex < segments.length) {
				const seg = segments[currentSegIndex];
				const atStart = Math.abs(cleaningTime - seg.cumulativeStart) < 0.05;
				if (atStart && !playing && currentSegIndex > 0) {
					// Already at clip start while paused → jump to previous clip start
					seekTo(segments[currentSegIndex - 1].cumulativeStart);
				} else {
					// In the middle of a clip → jump to this clip's start
					seekTo(seg.cumulativeStart);
				}
			}
		} else if (e.shiftKey && e.key === 'ArrowRight') {
			e.preventDefault();
			if (currentSegIndex < segments.length) {
				const seg = segments[currentSegIndex];
				const clipEnd = seg.cumulativeStart + seg.duration;
				const atEnd = Math.abs(cleaningTime - clipEnd) < 0.05;
				if (atEnd && !playing && currentSegIndex + 1 < segments.length) {
					// At clip end while paused → jump to next clip's end
					const nextSeg = segments[currentSegIndex + 1];
					seekTo(nextSeg.cumulativeStart + nextSeg.duration);
				} else {
					// In the middle → jump to this clip's end
					seekTo(clipEnd);
				}
			}
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			seekTo(cleaningTime - 3 * playbackRate);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			seekTo(cleaningTime + 3 * playbackRate);
		} else if (e.key === 'd') {
			e.preventDefault();
			nudgeClipBoundary('endTime', 0.1);
		} else if (e.key === 'D') {
			e.preventDefault();
			nudgeClipBoundary('endTime', -0.1);
		} else if (e.key === 'a') {
			e.preventDefault();
			nudgeClipBoundary('startTime', -0.1);
		} else if (e.key === 'A') {
			e.preventDefault();
			nudgeClipBoundary('startTime', 0.1);
		} else if ((e.key === 's' || e.key === 'S') && !e.repeat) {
			if (currentSegIndex < segments.length) {
				const seg = segments[currentSegIndex];
				// Convert cleaning playhead to master time for the split point
				const offsetInClip = cleaningTime - seg.cumulativeStart;
				const splitMasterTime = seg.clip.startTime + offsetInClip;
				splitClip(seg.clip, splitMasterTime);
			}
		} else if (e.key === 'r' || e.key === 'R') {
			if (!e.repeat && currentSegIndex < segments.length) {
				const seg = segments[currentSegIndex];
				const wasPaused = !playing;
				if (playing) { playing = false; videoEl?.pause(); cancelAnimationFrame(rafId); }
				removeClip(seg.clip);
				// After removing, jump to the segment that now occupies this index
				if (segments.length > 0) {
					const newIdx = Math.min(currentSegIndex, segments.length - 1);
					cleaningTime = segments[newIdx]?.cumulativeStart ?? 0;
					loadSegment(newIdx);
					if (!wasPaused) { playing = true; lastFrameTime = performance.now(); videoEl?.play().catch(() => {}); rafId = requestAnimationFrame(advanceLoop); }
				} else {
					cleaningTime = 0;
					slots.A.streamId = null;
					slots.B.streamId = null;
					preloadedForSeg = null;
				}
			}
		}
	}

	// Wheel listener — needs non-passive for zoom
	$effect(() => {
		const el = scrollAreaEl;
		if (!el) return;
		el.addEventListener('wheel', handleWheel, { passive: false });
		return () => el.removeEventListener('wheel', handleWheel);
	});

	// Cleanup on unmount
	$effect(() => {
		return () => {
			cancelAnimationFrame(rafId);
			if (slots.A.hls) slots.A.hls.destroy();
			if (slots.B.hls) slots.B.hls.destroy();
		};
	});

	// Current segment info
	let currentSeg = $derived(
		currentSegIndex < segments.length ? segments[currentSegIndex] : null
	);
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="cleaning-mode">
	<div class="cleaning-player">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoElA}
			ontimeupdate={handleTimeUpdate}
			playsinline
			class={activePlayer === 'A' ? '' : 'preload-video'}
		></video>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoElB}
			ontimeupdate={handleTimeUpdate}
			playsinline
			class={activePlayer === 'B' ? '' : 'preload-video'}
		></video>
		{#if segments.length === 0}
			<div class="empty-overlay">
				<p>No clip regions marked</p>
				<p class="empty-hint">Use Clipping mode to mark regions with W</p>
			</div>
		{/if}
	</div>

	<div class="cleaning-controls">
		<div class="transport">
			<button class="btn-ctl" onclick={togglePlayPause} disabled={segments.length === 0}>
				{playing ? '⏸' : '▶'}
			</button>
			<span class="time-display">
				{formatDuration(cleaningTime)} / {formatDuration(totalDuration)}
			</span>
			<span class="speed-display">{playbackRate}x</span>
			{#if currentSeg}
				<span class="clip-info">
					Clip {currentSegIndex + 1}/{segments.length} — {currentSeg.channel}
				</span>
			{/if}
			<div class="toolbar-spacer"></div>
			<button class="btn-ctl btn-small" onclick={zoomOut} title="Zoom out">−</button>
			<span class="zoom-label">{pixelsPerSecond.toFixed(0)} px/s</span>
			<button class="btn-ctl btn-small" onclick={zoomIn} title="Zoom in">+</button>
			{#if !autoScroll}
				<button class="btn-ctl btn-small" onclick={reCenter} title="Re-center playhead">⊙</button>
			{/if}
			<span class="cleaning-hint">Space: Play | R: Remove | S: Split | A/D: Nudge in/out | Ctrl+Z: Undo</span>
		</div>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="track-scroll-area"
			bind:this={scrollAreaEl}
			onscroll={handleScroll}
			onmousedown={handleTimelineClick}
		>
			<div class="track-content" style="width: {contentWidth}px">
				{#each segments as seg, i}
					{@const left = seg.cumulativeStart * pixelsPerSecond}
					{@const width = seg.duration * pixelsPerSecond}
					<div
						class="clip-block"
						class:active={i === currentSegIndex}
						style="left: {left}px; width: {width}px"
						title="{seg.channel}: {formatDuration(seg.duration)}"
					>
						<span class="clip-block-label">{seg.channel}</span>
					</div>
				{/each}
				<div class="track-playhead" style="left: {playheadX}px"></div>
			</div>
		</div>
	</div>
</div>

<style>
	.cleaning-mode {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.cleaning-player {
		flex: 1;
		min-height: 0;
		background: #000;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.cleaning-player video {
		width: 100%;
		height: 100%;
		display: block;
	}

	.cleaning-player video.preload-video {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.empty-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: #666;
		gap: 4px;
	}

	.empty-hint {
		font-size: 0.85rem;
		color: #555;
	}

	.cleaning-controls {
		background: #0a0a1a;
		border-top: 1px solid #2a2a4a;
		padding: 8px 16px 12px;
		flex-shrink: 0;
	}

	.transport {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.btn-ctl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.btn-ctl:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.btn-ctl:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn-small {
		padding: 2px 8px;
		font-size: 0.75rem;
	}

	.time-display {
		font-size: 0.85rem;
		color: #e0e0ff;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
	}

	.speed-display {
		font-size: 0.7rem;
		color: #aaa;
		font-variant-numeric: tabular-nums;
		min-width: 3em;
		text-align: center;
	}

	.clip-info {
		font-size: 0.75rem;
		color: #aaa;
	}

	.toolbar-spacer {
		flex: 1;
	}

	.zoom-label {
		font-size: 0.65rem;
		color: #666;
		font-variant-numeric: tabular-nums;
		min-width: 4em;
		text-align: center;
	}

	.cleaning-hint {
		font-size: 0.6rem;
		color: #444;
		font-family: monospace;
	}

	.track-scroll-area {
		height: 40px;
		overflow-x: auto;
		overflow-y: hidden;
		background: #1a1a2e;
		border-radius: 4px;
		cursor: pointer;
		user-select: none;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.track-scroll-area::-webkit-scrollbar {
		height: 6px;
	}

	.track-scroll-area::-webkit-scrollbar-track {
		background: #0a0a1a;
	}

	.track-scroll-area::-webkit-scrollbar-thumb {
		background: #2a2a4a;
		border-radius: 3px;
	}

	.track-content {
		position: relative;
		height: 100%;
		min-width: 100%;
	}

	.clip-block {
		position: absolute;
		top: 4px;
		bottom: 4px;
		background: #7c3aed;
		border-radius: 3px;
		opacity: 0.7;
		transition: opacity 0.15s;
		overflow: hidden;
		border-right: 1px solid #0a0a1a;
	}

	.clip-block.active {
		opacity: 1;
		box-shadow: 0 0 6px rgba(124, 58, 237, 0.5);
	}

	.clip-block-label {
		font-size: 0.6rem;
		color: rgba(255, 255, 255, 0.8);
		padding: 0 6px;
		line-height: 32px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		display: block;
		pointer-events: none;
	}

	.track-playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		pointer-events: none;
		z-index: 5;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
	}
</style>
