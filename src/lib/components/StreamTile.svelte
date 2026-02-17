<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Hls from 'hls.js';
	import type { StreamState } from '$lib/stores/streams.js';
	import { focusedStreamId, removeStream } from '$lib/stores/streams.js';
	import Timeline from './Timeline.svelte';

	export let stream: StreamState;
	export let focused: boolean = false;

	let videoEl: HTMLVideoElement;
	let hls: Hls | null = null;
	let isLive = true;
	let currentTime = 0;
	let duration = 0;
	let playlistUrl = '';
	let retryTimeout: ReturnType<typeof setTimeout> | null = null;

	$: playlistUrl = `/hls/${stream.id}/playlist.m3u8`;

	function initHls() {
		if (!videoEl) return;

		if (hls) {
			hls.destroy();
			hls = null;
		}

		if (!Hls.isSupported()) {
			// Fallback for Safari (native HLS support)
			videoEl.src = playlistUrl;
			videoEl.play().catch(() => {});
			return;
		}

		hls = new Hls({
			liveSyncDurationCount: 3,
			liveMaxLatencyDurationCount: 6,
			enableWorker: true,
			lowLatencyMode: false,
			// Keep a larger back buffer for seeking into the past
			backBufferLength: Infinity,
			maxBufferLength: 30,
			maxMaxBufferLength: 600,
		});

		hls.loadSource(playlistUrl);
		hls.attachMedia(videoEl);

		hls.on(Hls.Events.MANIFEST_PARSED, () => {
			videoEl.play().catch(() => {});
		});

		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (data.fatal) {
				switch (data.type) {
					case Hls.ErrorTypes.NETWORK_ERROR:
						// Playlist not ready yet, retry in a bit
						retryTimeout = setTimeout(() => {
							hls?.loadSource(playlistUrl);
						}, 2000);
						break;
					case Hls.ErrorTypes.MEDIA_ERROR:
						hls?.recoverMediaError();
						break;
					default:
						hls?.destroy();
						break;
				}
			}
		});
	}

	function handleTimeUpdate() {
		if (!videoEl) return;
		currentTime = videoEl.currentTime;
		duration = videoEl.duration || 0;
		// Consider "live" if within 5 seconds of the end
		isLive = duration > 0 && duration - currentTime < 5;
	}

	function seekTo(time: number) {
		if (!videoEl) return;
		videoEl.currentTime = time;
		isLive = false;
	}

	function snapToLive() {
		if (!videoEl) return;
		videoEl.currentTime = videoEl.duration || 0;
		videoEl.play().catch(() => {});
		isLive = true;
	}

	function toggleFocus() {
		focusedStreamId.update((current) => (current === stream.id ? null : stream.id));
	}

	function handleRemove() {
		removeStream(stream.id);
	}

	// Frame stepping (approximate: 1/30th of a second per frame at 30fps)
	function stepFrame(direction: number) {
		if (!videoEl) return;
		videoEl.pause();
		videoEl.currentTime += direction * (1 / 30);
		isLive = false;
	}

	onMount(() => {
		// Wait a moment for the stream to start producing segments
		if (stream.status === 'capturing') {
			initHls();
		} else {
			// Retry until capturing
			const check = setInterval(() => {
				if (stream.status === 'capturing') {
					clearInterval(check);
					initHls();
				}
			}, 1000);
			return () => clearInterval(check);
		}
	});

	onDestroy(() => {
		if (hls) hls.destroy();
		if (retryTimeout) clearTimeout(retryTimeout);
	});

	// Re-init HLS when stream status changes to capturing
	$: if (stream.status === 'capturing' && videoEl && !hls) {
		initHls();
	}
</script>

<div class="stream-tile" class:focused class:starting={stream.status === 'starting'}>
	<div class="stream-header">
		<span class="channel-name">{stream.channel}</span>
		<div class="header-controls">
			<span class="status-badge" class:live={isLive && stream.status === 'capturing'} class:behind={!isLive && stream.status === 'capturing'}>
				{#if stream.status === 'starting'}
					Starting...
				{:else if stream.status === 'error'}
					Error
				{:else if stream.status === 'stopped'}
					Stopped
				{:else if isLive}
					LIVE
				{:else}
					-{Math.floor(duration - currentTime)}s
				{/if}
			</span>
			<button class="btn-icon" on:click={toggleFocus} title={focused ? 'Minimize' : 'Maximize'}>
				{focused ? '⊖' : '⊕'}
			</button>
			<button class="btn-icon btn-remove" on:click={handleRemove} title="Remove stream">
				✕
			</button>
		</div>
	</div>

	<div class="video-container">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoEl}
			on:timeupdate={handleTimeUpdate}
			playsinline
			muted
		></video>

		{#if stream.status === 'starting'}
			<div class="overlay">
				<div class="spinner"></div>
				<p>Connecting to {stream.channel}...</p>
			</div>
		{/if}
	</div>

	<div class="controls">
		<div class="seek-controls">
			<button class="btn-sm" on:click={() => stepFrame(-1)} title="Previous frame">◄</button>
			<button class="btn-sm" on:click={() => { videoEl?.paused ? videoEl?.play() : videoEl?.pause() }}>
				{videoEl?.paused ? '▶' : '⏸'}
			</button>
			<button class="btn-sm" on:click={() => stepFrame(1)} title="Next frame">►</button>
		</div>

		<Timeline
			{currentTime}
			{duration}
			{isLive}
			on:seek={(e) => seekTo(e.detail)}
			on:live={snapToLive}
		/>
	</div>
</div>

<style>
	.stream-tile {
		background: #1a1a2e;
		border: 2px solid #2a2a4a;
		border-radius: 8px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		transition: border-color 0.2s;
	}

	.stream-tile:hover {
		border-color: #4a4a7a;
	}

	.stream-tile.focused {
		border-color: #7c3aed;
		box-shadow: 0 0 20px rgba(124, 58, 237, 0.3);
	}

	.stream-tile.starting {
		opacity: 0.7;
	}

	.stream-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: #0f0f23;
	}

	.channel-name {
		font-weight: 700;
		font-size: 0.9rem;
		color: #e0e0ff;
	}

	.header-controls {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.status-badge {
		font-size: 0.7rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 4px;
		background: #333;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.status-badge.live {
		background: #dc2626;
		color: white;
		animation: pulse 2s infinite;
	}

	.status-badge.behind {
		background: #d97706;
		color: white;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.7;
		}
	}

	.btn-icon {
		background: none;
		border: none;
		color: #888;
		cursor: pointer;
		font-size: 1rem;
		padding: 2px 4px;
		line-height: 1;
	}

	.btn-icon:hover {
		color: #e0e0ff;
	}

	.btn-remove:hover {
		color: #ef4444;
	}

	.video-container {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		background: #000;
	}

	video {
		width: 100%;
		height: 100%;
		display: block;
	}

	.overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.7);
		color: #ccc;
		gap: 12px;
	}

	.spinner {
		width: 32px;
		height: 32px;
		border: 3px solid #333;
		border-top-color: #7c3aed;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.controls {
		padding: 6px 10px;
		display: flex;
		align-items: center;
		gap: 8px;
		background: #0f0f23;
	}

	.seek-controls {
		display: flex;
		gap: 2px;
	}

	.btn-sm {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 8px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.75rem;
	}

	.btn-sm:hover {
		background: #3a3a5a;
		color: #fff;
	}
</style>
