<script lang="ts">
	import Hls from 'hls.js';
	import type { ClipRegion } from '$lib/stores/streams.js';
	import { formatDuration, getClipLocalBounds, setupHls } from '$lib/utils.js';

	let {
		clip,
		stream,
		syncOffset,
		onclose
	}: {
		clip: ClipRegion;
		stream: { startedAt: number } | undefined;
		syncOffset: number;
		onclose: () => void;
	} = $props();

	let videoEl = $state<HTMLVideoElement | null>(null);
	let hls: Hls | null = null;
	let playing = $state(false);
	let progress = $state(0);
	let currentTimeText = $state('0:00');
	let durationText = $state('0:00');
	let isSeeking = $state(false);

	let bounds = $derived(getClipLocalBounds(clip, stream, syncOffset));

	// Setup player when clip changes
	$effect(() => {
		const _clip = clip;
		const _bounds = bounds;
		if (!_bounds) return;

		durationText = formatDuration(_bounds.localEnd - _bounds.localStart);
		progress = 0;
		currentTimeText = '0:00';
		playing = false;

		// Wait for DOM
		requestAnimationFrame(() => {
			if (!videoEl || !_bounds) return;
			if (hls) { hls.destroy(); hls = null; }

			const url = `/hls/${_clip.streamId}/playlist.m3u8`;
			hls = setupHls(Hls, videoEl, url, _bounds.localStart, () => {
				videoEl!.play().then(() => { playing = true; }).catch(() => {});
			});
		});
	});

	// Clamp playback to clip bounds
	$effect(() => {
		const _bounds = bounds;
		if (!videoEl || !_bounds) return;
		const { localStart, localEnd } = _bounds;
		const clipDur = localEnd - localStart;
		durationText = formatDuration(clipDur);

		if (videoEl.currentTime >= localEnd) {
			videoEl.currentTime = localStart;
			progress = 0;
			currentTimeText = '0:00';
			if (playing) { videoEl.pause(); playing = false; }
		} else if (videoEl.currentTime < localStart) {
			videoEl.currentTime = localStart;
			progress = 0;
			currentTimeText = '0:00';
		} else {
			const elapsed = videoEl.currentTime - localStart;
			progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			currentTimeText = formatDuration(elapsed);
		}
	});

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (hls) { hls.destroy(); hls = null; }
		};
	});

	function handleTimeUpdate() {
		if (!videoEl || !bounds) return;
		const { localStart, localEnd } = bounds;
		const clipDur = localEnd - localStart;

		if (videoEl.currentTime >= localEnd) {
			videoEl.pause();
			playing = false;
			videoEl.currentTime = localStart;
			progress = 0;
			currentTimeText = '0:00';
		} else if (!isSeeking) {
			const elapsed = videoEl.currentTime - localStart;
			progress = clipDur > 0 ? Math.max(0, Math.min(1, elapsed / clipDur)) : 0;
			currentTimeText = formatDuration(elapsed);
		}
		durationText = formatDuration(clipDur);
	}

	function togglePlay() {
		if (!videoEl) return;
		if (playing) { videoEl.pause(); } else { videoEl.play().catch(() => {}); }
		playing = !playing;
	}

	function handleSeekInput(e: Event) {
		isSeeking = true;
		const value = +(e.target as HTMLInputElement).value;
		progress = value;
		if (bounds) {
			currentTimeText = formatDuration(value * (bounds.localEnd - bounds.localStart));
		}
	}

	function handleSeekCommit() {
		if (!videoEl || !bounds) { isSeeking = false; return; }
		const { localStart, localEnd } = bounds;
		videoEl.currentTime = localStart + progress * (localEnd - localStart);
		isSeeking = false;
	}
</script>

<div class="preview-container">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={videoEl}
		ontimeupdate={handleTimeUpdate}
		playsinline
		class="preview-video"
	></video>
	<div class="preview-controls">
		<button class="btn-ctl" onclick={togglePlay}>
			{playing ? '\u23F8' : '\u25B6'}
		</button>
		<span class="preview-time">{currentTimeText}</span>
		<input
			type="range"
			class="preview-seek"
			min="0"
			max="1"
			step="0.001"
			value={progress}
			oninput={handleSeekInput}
			onchange={handleSeekCommit}
		/>
		<span class="preview-time">{durationText}</span>
		<button class="btn-ctl" onclick={onclose}>Close</button>
	</div>
</div>

<style>
	.preview-container {
		padding: 0 20px 10px 48px;
	}

	.preview-video {
		width: 100%;
		max-height: 300px;
		background: #000;
		border-radius: 4px;
		display: block;
	}

	.preview-controls {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
	}

	.preview-time {
		font-size: 0.65rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		min-width: 3em;
		text-align: center;
	}

	.preview-seek {
		flex: 1;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: #2a2a4a;
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.preview-seek::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		cursor: pointer;
	}

	.preview-seek::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		border: none;
		cursor: pointer;
	}

	.preview-seek::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
	}

	.preview-seek::-moz-range-track {
		height: 4px;
		background: #2a2a4a;
		border-radius: 2px;
	}

	.btn-ctl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.75rem;
	}

	.btn-ctl:hover {
		background: #3a3a5a;
		color: #fff;
	}
</style>
