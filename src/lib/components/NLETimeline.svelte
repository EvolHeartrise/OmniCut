<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		streams,
		streamPlaybackStates,
		syncOffsets,
		masterControl,
		masterTime,
		masterPlaying,
		masterPlaybackRate,
		saveOffset,
		removeStream,
		focusedStreamId,
		clipRegions,
		saveClipRegion,
		type ClipRegion
	} from '$lib/stores/streams.js';
	import { applyTimelineZoom, clampPps } from '$lib/timeline.js';
	import { splitClipRegion, removeClipRegionAction } from '$lib/clipActions.js';

	const COLORS = [
		'#7c3aed',
		'#2563eb',
		'#dc2626',
		'#16a34a',
		'#d97706',
		'#db2777',
		'#0891b2',
		'#84cc16'
	];

	const MIN_PPS = 0.1;
	const MAX_PPS = 200;

	let pixelsPerSecond = $state(20);
	let autoScroll = $state(true);

	// Track drag state
	let draggingStreamId = $state<string | null>(null);
	let dragStartX = 0;
	let dragStartOffset = 0;
	let frozenTimelineStart = $state<number | null>(null);
	let frozenMasterTime = $state<number | null>(null);
	let dragOffsetDelta = $state(0); // offset change during drag (newOffset - dragStartOffset)

	// Undo stack
	type UndoEntry =
		| { type: 'add-region'; region: ClipRegion }
		| { type: 'delete-region'; region: ClipRegion }
		| { type: 'update-region'; before: ClipRegion }
		| { type: 'offset-drag'; streamId: string; oldOffset: number; oldRegions: ClipRegion[] }
		| { type: 'split-region'; original: ClipRegion; createdIds: [string, string] };

	let undoStack = $state<UndoEntry[]>([]);
	function pushUndo(entry: UndoEntry) {
		undoStack = [...undoStack, entry];
	}

	// Clip marking state (W key hold-to-mark)
	let markingStreamId = $state<string | null>(null);
	let markingStartTime = $state(0);

	/** Reaction-time compensation: how far behind the playhead to place the start marker.
	 *  Linearly interpolated from 800ms at 1x to 1600ms at 2x. */
	function reactionCompensation(speed: number): number {
		return 0.8 * speed;
	}

	// Snapshot of regions before a drag for undo
	let dragOldRegions: ClipRegion[] = [];

	// DOM refs ($state so $effect can track availability)
	let scrollAreaEl = $state<HTMLDivElement | null>(null);
	let labelsEl = $state<HTMLDivElement | null>(null);
	let rafId: number;
	let ignoreScrollEvents = false;
	let lastFrameTime = 0;

	// Stable track ordering: preserve insertion order
	let trackOrder = $state<string[]>([]);

	$effect.pre(() => {
		const currentIds = $streams.map((s) => s.id);
		const prevOrder = untrack(() => trackOrder);
		const updated = prevOrder.filter((id) => currentIds.includes(id));
		for (const id of currentIds) {
			if (!updated.includes(id)) updated.push(id);
		}
		trackOrder = updated;
	});

	// Derive per-track data from stores
	let tracksData = $derived(
		trackOrder.map((id, i) => {
			const stream = $streams.find((s) => s.id === id);
			const playback = $streamPlaybackStates[id];
			const offset = $syncOffsets[id] || 0;
			return {
				id,
				channel: stream?.channel || id,
				sourceType: stream?.sourceType || 'live',
				color: COLORS[i % COLORS.length],
				offset,
				anchor: (stream?.startedAt || Date.now()) / 1000,
				duration: playback?.duration || 0,
				currentTime: playback?.currentTime || 0,
				paused: playback?.paused ?? true
			};
		})
	);

	// Master time is a pure self-advancing clock in epoch seconds. Streams follow it, never the reverse.
	let masterCurrentTimeState = $state(Date.now() / 1000);

	let masterCurrentTime = $derived(
		frozenMasterTime !== null ? frozenMasterTime : masterCurrentTimeState
	);

	// Sync to shared store (read by StreamGrid for intersection filtering)
	$effect(() => {
		$masterTime = masterCurrentTime;
	});

	let masterPaused = $derived(!$masterPlaying);

	// Timeline range
	let effectiveTimelineStart = $derived(
		frozenTimelineStart !== null
			? frozenTimelineStart
			: tracksData.length > 0
				? Math.min(...tracksData.map((t) => t.anchor - t.offset))
				: Date.now() / 1000
	);

	let timelineEnd = $derived(
		tracksData.length > 0
			? Math.max(...tracksData.map((t) => t.anchor + t.duration - t.offset))
			: Date.now() / 1000 + 60
	);

	let timelineDuration = $derived(timelineEnd - effectiveTimelineStart);
	let contentWidth = $derived(Math.max(timelineDuration * pixelsPerSecond, 100));

	// Playhead pixel position within content
	let playheadX = $derived((masterCurrentTime - effectiveTimelineStart) * pixelsPerSecond);

	// Ruler tick interval: choose so ticks are ~60-150px apart
	let tickInterval = $derived.by(() => {
		const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 43200, 86400];
		for (const c of candidates) {
			if (c * pixelsPerSecond >= 60) return c;
		}
		return 86400;
	});

	let ticks = $derived.by(() => {
		const result: { x: number; label: string }[] = [];
		const start = Math.ceil(effectiveTimelineStart / tickInterval) * tickInterval;
		for (let t = start; t <= timelineEnd + tickInterval; t += tickInterval) {
			const x = (t - effectiveTimelineStart) * pixelsPerSecond;
			if (x >= 0 && x <= contentWidth) {
				result.push({ x, label: formatTime(t) });
			}
		}
		return result;
	});

	function formatTime(epochSec: number): string {
		const d = new Date(epochSec * 1000);
		const h = d.getHours();
		const m = d.getMinutes();
		const s = d.getSeconds();
		return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
	}

	// --- Auto-scroll + self-advance ---
	function scrollLoop() {
		const now = performance.now();

		// Self-advance master time at playback rate when playing
		if ($masterPlaying && lastFrameTime > 0) {
			const deltaSec = ((now - lastFrameTime) / 1000) * $masterPlaybackRate;
			masterCurrentTimeState += deltaSec;
		}
		lastFrameTime = now;

		if (autoScroll && scrollAreaEl && !masterPaused) {
			const targetScrollLeft = playheadX - scrollAreaEl.clientWidth / 2;
			ignoreScrollEvents = true;
			scrollAreaEl.scrollLeft = targetScrollLeft;
		}
		rafId = requestAnimationFrame(scrollLoop);
	}

	function handleScroll() {
		// Sync vertical scroll to labels panel
		if (labelsEl && scrollAreaEl) {
			labelsEl.scrollTop = scrollAreaEl.scrollTop;
		}
		if (ignoreScrollEvents) {
			ignoreScrollEvents = false;
			return;
		}
		if (!masterPaused) {
			autoScroll = false;
		}
	}

	function reCenter() {
		autoScroll = true;
		if (scrollAreaEl) {
			ignoreScrollEvents = true;
			scrollAreaEl.scrollLeft = playheadX - scrollAreaEl.clientWidth / 2;
		}
	}

	// --- Zoom (Ctrl+Wheel) / Pan (bare scroll) ---
	function handleWheel(e: WheelEvent) {
		if (e.ctrlKey) {
			e.preventDefault();
			if (!scrollAreaEl) return;
			const { newPps, scheduleScrollRestore } = applyTimelineZoom(
				e, scrollAreaEl, pixelsPerSecond, effectiveTimelineStart, MIN_PPS, MAX_PPS
			);
			pixelsPerSecond = newPps;
			scheduleScrollRestore(() => { ignoreScrollEvents = true; });
		} else if (e.shiftKey) {
			// Shift+wheel → horizontal pan
			e.preventDefault();
			if (!scrollAreaEl) return;
			scrollAreaEl.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
		}
		// Bare wheel: native vertical scroll (don't prevent default)
	}

	// --- Click-to-seek on background ---
	function handleContentMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		if (!scrollAreaEl) return;
		const rect = scrollAreaEl.getBoundingClientRect();
		const x = e.clientX - rect.left + scrollAreaEl.scrollLeft;
		const seekTime = x / pixelsPerSecond + effectiveTimelineStart;
		masterCurrentTimeState = seekTime;
		masterControl.update((c) => ({
			action: 'seek',
			time: seekTime,
			direction: 0,
			seq: c.seq + 1
		}));
	}

	// --- Track bar drag (offset adjustment) ---
	function handleTrackMouseDown(e: MouseEvent, trackId: string) {
		e.stopPropagation();
		e.preventDefault();
		draggingStreamId = trackId;
		dragStartX = e.clientX;
		dragStartOffset = $syncOffsets[trackId] || 0;
		dragOldRegions = $clipRegions.filter((r) => r.streamId === trackId).map((r) => ({ ...r }));
		// Freeze timeline origin and master time to prevent jitter while dragging
		frozenTimelineStart =
			tracksData.length > 0
				? Math.min(...tracksData.map((t) => t.anchor - t.offset))
				: Date.now() / 1000;
		frozenMasterTime = masterCurrentTime;
		window.addEventListener('mousemove', handleTrackMouseMove);
		window.addEventListener('mouseup', handleTrackMouseUp);
	}

	function handleTrackMouseMove(e: MouseEvent) {
		if (!draggingStreamId) return;
		const deltaX = e.clientX - dragStartX;
		const deltaSec = deltaX / pixelsPerSecond;
		const newOffset = dragStartOffset - deltaSec;
		dragOffsetDelta = newOffset - dragStartOffset;
		syncOffsets.update((o) => ({ ...o, [draggingStreamId!]: newOffset }));
		// Force all streams to seek to correct position with updated offsets
		masterControl.update((c) => ({
			action: 'seek',
			time: masterCurrentTime,
			direction: 0,
			seq: c.seq + 1
		}));
	}

	function handleTrackMouseUp() {
		// Save the final offset to the server
		if (draggingStreamId) {
			const finalOffset = $syncOffsets[draggingStreamId] || 0;

			// Push undo before saving (only if offset actually changed)
			if (dragOffsetDelta !== 0) {
				pushUndo({
					type: 'offset-drag',
					streamId: draggingStreamId,
					oldOffset: dragStartOffset,
					oldRegions: dragOldRegions
				});
			}

			saveOffset(draggingStreamId, finalOffset);

			// Shift clip regions by the same amount the track moved
			if (dragOffsetDelta !== 0) {
				const streamId = draggingStreamId;
				const timeDelta = -dragOffsetDelta; // offset up = bar moves left = markers move left
				clipRegions.update((regions) =>
					regions.map((r) =>
						r.streamId === streamId
							? { ...r, startTime: r.startTime + timeDelta, endTime: r.endTime + timeDelta }
							: r
					)
				);
				// Persist shifted regions to server
				for (const r of $clipRegions.filter((r) => r.streamId === streamId)) {
					saveClipRegion(r);
				}
			}
		}
		// Sync master time state before clearing frozen values to prevent playhead jump
		if (frozenMasterTime !== null) {
			masterCurrentTimeState = frozenMasterTime;
		}
		draggingStreamId = null;
		dragOffsetDelta = 0;
		frozenTimelineStart = null;
		frozenMasterTime = null;
		window.removeEventListener('mousemove', handleTrackMouseMove);
		window.removeEventListener('mouseup', handleTrackMouseUp);
	}

	// --- Toolbar controls ---
	function togglePlayPause() {
		$masterPlaying = !$masterPlaying;
		lastFrameTime = $masterPlaying ? performance.now() : 0;
		masterControl.update((c) => ({
			action: $masterPlaying ? 'play' : 'pause',
			time: 0,
			direction: 0,
			seq: c.seq + 1
		}));
		if ($masterPlaying) {
			autoScroll = true;
		}
	}

	function applyUndo() {
		if (undoStack.length === 0) return;
		const entry = undoStack[undoStack.length - 1];
		undoStack = undoStack.slice(0, -1);

		switch (entry.type) {
			case 'add-region':
				// Undo region creation → remove it
				removeClipRegionAction(entry.region);
				break;
			case 'delete-region':
				// Undo region deletion → re-add it
				clipRegions.update((regions) => [...regions, entry.region]);
				saveClipRegion(entry.region);
				break;
			case 'update-region':
				// Undo marker move → restore old snapshot
				clipRegions.update((regions) =>
					regions.map((r) => (r.id === entry.before.id ? { ...entry.before } : r))
				);
				saveClipRegion(entry.before);
				break;
			case 'offset-drag': {
				// Undo offset drag → restore old offset and old region positions
				const { streamId, oldOffset, oldRegions } = entry;
				syncOffsets.update((o) => ({ ...o, [streamId]: oldOffset }));
				saveOffset(streamId, oldOffset);
				clipRegions.update((regions) => {
					const otherRegions = regions.filter((r) => r.streamId !== streamId);
					return [...otherRegions, ...oldRegions];
				});
				for (const r of oldRegions) {
					saveClipRegion(r);
				}
				// Seek streams to correct position with restored offset
				masterControl.update((c) => ({
					action: 'seek',
					time: masterCurrentTime,
					direction: 0,
					seq: c.seq + 1
				}));
				break;
			}
			case 'split-region': {
				// Undo split → remove the two halves, re-add original
				const { original, createdIds } = entry;
				clipRegions.update((regions) =>
					[...regions.filter((r) => !createdIds.includes(r.id)), original]
				);
				removeClipRegionAction({ ...original, id: createdIds[0] });
				removeClipRegionAction({ ...original, id: createdIds[1] });
				// Re-add original (removeClipRegionAction removed from store, but we re-added above)
				saveClipRegion(original);
				break;
			}
		}
	}

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
			$masterPlaybackRate = Math.min(4, +(($masterPlaybackRate + 0.25).toFixed(2)));
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			$masterPlaybackRate = Math.max(0.25, +(($masterPlaybackRate - 0.25).toFixed(2)));
		} else if (e.key === 'w' || e.key === 'W') {
			if (!e.repeat && $masterPlaying && $focusedStreamId && !markingStreamId) {
				markingStreamId = $focusedStreamId;
				markingStartTime = masterCurrentTimeState - reactionCompensation($masterPlaybackRate);
			}
		} else if ((e.key === 'q' || e.key === 'Q' || e.key === 'e' || e.key === 'E') && !e.repeat) {
			if ($focusedStreamId) {
				const now = masterCurrentTimeState;
				const region = $clipRegions.find(
					(r) => r.streamId === $focusedStreamId && r.startTime <= now && now <= r.endTime
				);
				const isStart = e.key === 'q' || e.key === 'Q';
				if (region) {
					pushUndo({ type: 'update-region', before: { ...region } });
					clipRegions.update((regions) =>
						regions.map((r) =>
							r.id === region.id
								? { ...r, ...(isStart ? { startTime: now } : { endTime: now }) }
								: r
						)
					);
					saveClipRegion({
						...region,
						...(isStart ? { startTime: now } : { endTime: now })
					});
				} else {
					const streamRegions = $clipRegions.filter((r) => r.streamId === $focusedStreamId);
					let target: ClipRegion | undefined;
					if (isStart) {
						// Q outside: find nearest start marker in the future, pull it back
						target = streamRegions
							.filter((r) => r.startTime > now)
							.sort((a, b) => a.startTime - b.startTime)[0];
						if (target) {
							pushUndo({ type: 'update-region', before: { ...target } });
							clipRegions.update((regions) =>
								regions.map((r) => r.id === target!.id ? { ...r, startTime: now } : r)
							);
							saveClipRegion({ ...target, startTime: now });
						}
					} else {
						// E outside: find nearest end marker in the past, extend it forward
						target = streamRegions
							.filter((r) => r.endTime < now)
							.sort((a, b) => b.endTime - a.endTime)[0];
						if (target) {
							pushUndo({ type: 'update-region', before: { ...target } });
							clipRegions.update((regions) =>
								regions.map((r) => r.id === target!.id ? { ...r, endTime: now } : r)
							);
							saveClipRegion({ ...target, endTime: now });
						}
					}
				}
			}
		} else if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
			if ($focusedStreamId) {
				const now = masterCurrentTimeState;
				const region = $clipRegions.find(
					(r) => r.streamId === $focusedStreamId && r.startTime <= now && now <= r.endTime
				);
				if (region) {
					pushUndo({ type: 'delete-region', region: { ...region } });
					removeClipRegionAction(region);
				}
			}
		} else if ((e.key === 's' || e.key === 'S') && !e.repeat) {
			if ($focusedStreamId) {
				const now = masterCurrentTimeState;
				const region = $clipRegions.find(
					(r) => r.streamId === $focusedStreamId && r.startTime < now && now < r.endTime
				);
				if (region) {
					const result = splitClipRegion(region, now);
					if (result) {
						pushUndo({ type: 'split-region', original: region, createdIds: [result.firstHalf.id, result.secondHalf.id] });
					}
				}
			}
		} else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
			e.preventDefault();
			const now = masterCurrentTimeState;
			const regions = $focusedStreamId
				? $clipRegions.filter((r) => r.streamId === $focusedStreamId)
				: $clipRegions;
			const markers = regions.flatMap((r) => [r.startTime, r.endTime]);
			let target: number | undefined;
			if (e.key === 'ArrowLeft') {
				target = markers.filter((t) => t < now - 0.05).sort((a, b) => b - a)[0];
			} else {
				target = markers.filter((t) => t > now + 0.05).sort((a, b) => a - b)[0];
			}
			if (target !== undefined) {
				masterCurrentTimeState = target;
				masterControl.update((c) => ({
					action: 'seek',
					time: target,
					direction: 0,
					seq: c.seq + 1
				}));
			}
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			const delta = (e.key === 'ArrowRight' ? 1 : -1) * 3 * $masterPlaybackRate;
			const seekTime = masterCurrentTimeState + delta;
			masterCurrentTimeState = seekTime;
			masterControl.update((c) => ({
				action: 'seek',
				time: seekTime,
				direction: 0,
				seq: c.seq + 1
			}));
		}
	}

	function handleKeyup(e: KeyboardEvent) {
		if ((e.key === 'w' || e.key === 'W') && markingStreamId) {
			const endTime = masterCurrentTimeState;
			const region: ClipRegion = {
				id: crypto.randomUUID(),
				streamId: markingStreamId!,
				startTime: markingStartTime,
				endTime
			};
			clipRegions.update((regions) => [...regions, region]);
			saveClipRegion(region);
			pushUndo({ type: 'add-region', region });
			markingStreamId = null;
			markingStartTime = 0;
		}
	}

	function zoomIn() {
		pixelsPerSecond = clampPps(pixelsPerSecond * 1.5, MIN_PPS, MAX_PPS);
	}

	function zoomOut() {
		pixelsPerSecond = clampPps(pixelsPerSecond / 1.5, MIN_PPS, MAX_PPS);
	}

	// Wheel listener — needs non-passive, reacts to scrollAreaEl availability
	$effect(() => {
		const el = scrollAreaEl;
		if (!el) return;
		el.addEventListener('wheel', handleWheel, { passive: false });
		return () => el.removeEventListener('wheel', handleWheel);
	});

	// RAF loop — runs for component lifetime
	$effect(() => {
		rafId = requestAnimationFrame(scrollLoop);
		return () => cancelAnimationFrame(rafId);
	});
</script>

<svelte:window onkeydown={handleKeydown} onkeyup={handleKeyup} />

{#if tracksData.length > 0}
	<div class="nle-timeline">
		<div class="nle-toolbar">
			<button class="btn-tool" onclick={togglePlayPause} title={masterPaused ? 'Play' : 'Pause'}>
				{masterPaused ? '▶' : '⏸'}
			</button>
			<span class="time-display">{formatTime(masterCurrentTime)}</span>
			<span class="speed-display">{$masterPlaybackRate}x</span>
			<div class="toolbar-spacer"></div>
			<button class="btn-tool btn-small" onclick={zoomOut} title="Zoom out">−</button>
			<span class="zoom-label">{pixelsPerSecond.toFixed(0)} px/s</span>
			<button class="btn-tool btn-small" onclick={zoomIn} title="Zoom in">+</button>
			{#if !autoScroll}
				<button class="btn-tool btn-small" onclick={reCenter} title="Re-center playhead">
					⊙
				</button>
			{/if}
		</div>

		<div class="nle-body">
			<div class="track-labels" bind:this={labelsEl}>
				<div class="ruler-spacer"></div>
				{#each tracksData as track}
					<div class="label-row">
						<span class="color-dot" style="background: {track.color}"></span>
						<span class="label-text">{track.channel}{#if track.sourceType === 'vod'} <span class="vod-suffix">(VOD)</span>{/if}</span>
						<button class="btn-remove-track" onclick={() => removeStream(track.id)} title="Remove stream">✕</button>
					</div>
				{/each}
			</div>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="nle-scroll-area"
				bind:this={scrollAreaEl}
				onscroll={handleScroll}
				onmousedown={handleContentMouseDown}
			>
				<div class="nle-content" style="width: {contentWidth}px">
					<div class="time-ruler">
						{#each ticks as t}
							<div class="tick" style="left: {t.x}px">
								<div class="tick-line"></div>
								<span class="tick-label">{t.label}</span>
							</div>
						{/each}
					</div>

					{#each tracksData as track}
						{@const barLeft = (track.anchor - track.offset - effectiveTimelineStart) * pixelsPerSecond}
						{@const barWidth = track.duration * pixelsPerSecond}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="track-row">
							{#if barWidth > 0}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="track-bar"
									class:dragging={draggingStreamId === track.id}
									style="left: {barLeft}px; width: {barWidth}px; background: {track.color};"
									onmousedown={(e) => handleTrackMouseDown(e, track.id)}
								>
									<div
										class="bar-progress"
										style="width: {((track.currentTime / track.duration) * 100).toFixed(1)}%"
									></div>
									<span class="bar-label">{track.channel}{track.sourceType === 'vod' ? ' (VOD)' : ''}</span>
								</div>
							{/if}
							{#each $clipRegions.filter((r) => r.streamId === track.id) as region}
								{@const dragShift = draggingStreamId === track.id ? -dragOffsetDelta : 0}
								{@const clipLeft = (region.startTime + dragShift - effectiveTimelineStart) * pixelsPerSecond}
								{@const clipWidth = (region.endTime - region.startTime) * pixelsPerSecond}
								<div class="clip-region" style="left: {clipLeft}px; width: {clipWidth}px">
									<div class="clip-edge clip-edge-start"></div>
									<div class="clip-edge clip-edge-end"></div>
								</div>
							{/each}
							{#if markingStreamId === track.id}
								{@const markLeft = (markingStartTime - effectiveTimelineStart) * pixelsPerSecond}
								{@const markWidth = (masterCurrentTime - markingStartTime) * pixelsPerSecond}
								<div class="clip-region clip-region-active" style="left: {markLeft}px; width: {markWidth}px">
									<div class="clip-edge clip-edge-start"></div>
									<div class="clip-edge clip-edge-end"></div>
								</div>
							{/if}
						</div>
					{/each}

					<div class="playhead-line" style="left: {playheadX}px"></div>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.nle-timeline {
		background: #0a0a1a;
		border-top: 1px solid #2a2a4a;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		height: 260px;
		user-select: none;
	}

	.nle-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
	}

	.btn-tool {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.btn-tool:hover {
		background: #3a3a5a;
		color: #fff;
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
		min-width: 5em;
	}

	.toolbar-spacer {
		flex: 1;
	}

	.speed-display {
		font-size: 0.7rem;
		color: #aaa;
		margin-left: 8px;
		font-variant-numeric: tabular-nums;
		min-width: 3em;
		text-align: center;
	}

	.zoom-label {
		font-size: 0.65rem;
		color: #666;
		font-variant-numeric: tabular-nums;
		min-width: 4em;
		text-align: center;
	}

	.nle-body {
		flex: 1;
		display: flex;
		min-height: 0;
		overflow: hidden;
	}

	.track-labels {
		width: 120px;
		flex-shrink: 0;
		background: #0f0f23;
		border-right: 1px solid #1a1a2e;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none;
	}

	.track-labels::-webkit-scrollbar {
		display: none;
	}

	.ruler-spacer {
		height: 24px;
		border-bottom: 1px solid #1a1a2e;
		position: sticky;
		top: 0;
		z-index: 5;
		background: #0f0f23;
	}

	.label-row {
		height: 32px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px;
		border-bottom: 1px solid #111;
		overflow: hidden;
	}

	.btn-remove-track {
		margin-left: auto;
		background: none;
		border: none;
		color: #555;
		cursor: pointer;
		font-size: 0.65rem;
		padding: 2px 4px;
		line-height: 1;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.15s, color 0.15s;
	}

	.label-row:hover .btn-remove-track {
		opacity: 1;
	}

	.btn-remove-track:hover {
		color: #ef4444;
	}

	.color-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.label-text {
		font-size: 0.75rem;
		color: #ccc;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.vod-suffix {
		color: #d97706;
		font-size: 0.65rem;
	}

	.nle-scroll-area {
		flex: 1;
		overflow-x: auto;
		overflow-y: auto;
		position: relative;
		cursor: crosshair;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.nle-scroll-area::-webkit-scrollbar {
		width: 6px;
		height: 6px;
	}

	.nle-scroll-area::-webkit-scrollbar-track {
		background: #0a0a1a;
	}

	.nle-scroll-area::-webkit-scrollbar-thumb {
		background: #2a2a4a;
		border-radius: 3px;
	}

	.nle-content {
		position: relative;
		min-height: 100%;
	}

	.time-ruler {
		height: 24px;
		position: sticky;
		top: 0;
		z-index: 5;
		border-bottom: 1px solid #1a1a2e;
		background: #0d0d1f;
	}

	.tick {
		position: absolute;
		top: 0;
		height: 100%;
	}

	.tick-line {
		width: 1px;
		height: 8px;
		background: #444;
		position: absolute;
		bottom: 0;
	}

	.tick-label {
		font-size: 0.6rem;
		color: #666;
		position: absolute;
		top: 2px;
		left: 4px;
		white-space: nowrap;
	}

	.track-row {
		height: 32px;
		position: relative;
		border-bottom: 1px solid #111;
	}

	.track-bar {
		position: absolute;
		top: 4px;
		height: 24px;
		border-radius: 4px;
		cursor: grab;
		overflow: hidden;
		opacity: 0.85;
		transition: opacity 0.1s;
	}

	.track-bar:hover {
		opacity: 1;
	}

	.track-bar.dragging {
		opacity: 1;
		cursor: grabbing;
		box-shadow: 0 0 8px rgba(255, 255, 255, 0.2);
	}

	.bar-progress {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		background: rgba(255, 255, 255, 0.15);
		pointer-events: none;
	}

	.bar-label {
		position: relative;
		font-size: 0.65rem;
		color: rgba(255, 255, 255, 0.9);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
		padding: 0 8px;
		line-height: 24px;
	}

	.clip-region {
		position: absolute;
		top: 2px;
		height: 28px;
		background: rgba(250, 204, 21, 0.2);
		border-top: 1px solid rgba(250, 204, 21, 0.5);
		border-bottom: 1px solid rgba(250, 204, 21, 0.5);
		pointer-events: none;
		z-index: 5;
	}

	.clip-region-active {
		background: rgba(250, 204, 21, 0.3);
	}

	.clip-edge {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: rgba(250, 204, 21, 0.8);
	}

	.clip-edge-start {
		left: 0;
	}

	.clip-edge-end {
		right: 0;
	}

	.playhead-line {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		pointer-events: none;
		z-index: 10;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
	}
</style>
