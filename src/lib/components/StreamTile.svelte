<script module lang="ts">
	// Persists volume state across mount/unmount cycles per stream
	const volumeStates = new Map<string, { volume: number; muted: boolean }>();
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import Hls from 'hls.js';
	import type { StreamState } from '$lib/stores/streams.js';
	import { syncOffsets, streamPlaybackStates, masterControl, masterPlaying, masterPlaybackRate, masterTime, transcriptions, stopStream, retranscribeStream } from '$lib/stores/streams.js';
	import { createHlsConfig, formatBytes } from '$lib/utils.js';

	let { stream, focused = false, trackNumber = 0 }: { stream: StreamState; focused?: boolean; trackNumber?: number } = $props();

	let videoEl: HTMLVideoElement;
	let hls: Hls | null = null;
	let currentTime = $state(0);
	let duration = $state(0);
	let retryTimeout: ReturnType<typeof setTimeout> | null = null;
	const initVol = volumeStates.get(stream.id);
	let volume = $state(initVol?.volume ?? 1);
	let muted = $state(initVol?.muted ?? true);
	let lastMasterSeq = 0;
	let needsInitialSeek = false;

	// Throttle playback state store updates (~4/sec per video is excessive)
	let lastStateUpdate = 0;
	const STATE_UPDATE_INTERVAL = 250; // ms

	let playlistUrl = $derived(`/hls/${stream.id}/playlist.m3u8`);
	let offset = $derived($syncOffsets[stream.id] || 0);
	let allCaptions = $derived($transcriptions[stream.id] || []);
	// Show current + previous transcription lines
	let captionLines = $derived.by(() => {
		if (allCaptions.length === 0) return { current: '', prev: '' };
		const localTime = currentTime;
		const activeIdx = allCaptions.findIndex((c) => localTime >= c.startTime && localTime < c.endTime);
		if (activeIdx !== -1) {
			// Active caption exists — show it + the one before it
			const current = allCaptions[activeIdx].text;
			const prev = activeIdx > 0 ? allCaptions[activeIdx - 1].text : '';
			return { current, prev };
		}
		// No active caption — find the most recent past caption and show last two
		let lastIdx = -1;
		for (let i = allCaptions.length - 1; i >= 0; i--) {
			if (localTime >= allCaptions[i].endTime) { lastIdx = i; break; }
		}
		if (lastIdx === -1) return { current: '', prev: '' };
		const current = allCaptions[lastIdx].text;
		const prev = lastIdx > 0 ? allCaptions[lastIdx - 1].text : '';
		return { current, prev };
	});

	// Sync playback rate from master
	$effect(() => {
		if (videoEl) videoEl.playbackRate = $masterPlaybackRate;
	});

	// Auto mute/unmute when focus changes
	$effect(() => {
		if (!videoEl) return;
		if (focused) {
			muted = false;
			videoEl.muted = false;
			videoEl.volume = volume;
		} else {
			muted = true;
			videoEl.muted = true;
		}
		saveVolumeState();
	});

	// React to master timeline controls
	$effect(() => {
		const ctrl = $masterControl;
		if (ctrl.seq !== lastMasterSeq) {
			lastMasterSeq = ctrl.seq;
			untrack(() => handleMasterControl(ctrl));
		}
	});

	function handleMasterControl(ctrl: { action: string; time: number; direction: number }) {
		if (!videoEl) return;
		switch (ctrl.action) {
			case 'seek': {
				const anchor = stream.startedAt / 1000;
				const target = Math.max(0, Math.min(ctrl.time - anchor + offset, videoEl.duration || 0));
				videoEl.currentTime = target;

				break;
			}
			case 'play':
				videoEl.play().catch(() => {});
				break;
			case 'pause':
				videoEl.pause();
				break;
			case 'step':
				videoEl.pause();
				videoEl.currentTime += ctrl.direction * (1 / 30);

				break;
		}
	}

	function saveVolumeState() {
		volumeStates.set(stream.id, { volume, muted });
	}

	function toggleMute() {
		if (!videoEl) return;
		muted = !muted;
		videoEl.muted = muted;
		saveVolumeState();
	}

	function setVolume(e: Event) {
		if (!videoEl) return;
		volume = +(e.target as HTMLInputElement).value;
		videoEl.volume = volume;
		if (volume > 0 && muted) {
			muted = false;
			videoEl.muted = false;
		} else if (volume === 0) {
			muted = true;
			videoEl.muted = true;
		}
		saveVolumeState();
	}

	function shouldAutoPlay(): boolean {
		return get(masterPlaying);
	}

	function initHls() {
		if (!videoEl) return;

		if (hls) {
			hls.destroy();
			hls = null;
		}

		if (!Hls.isSupported()) {
			videoEl.src = playlistUrl;
			if (shouldAutoPlay()) videoEl.play().catch(() => {});
			return;
		}

		const isLive = stream.status === 'capturing' || stream.status === 'starting';
		hls = new Hls(createHlsConfig(isLive));

		hls.loadSource(playlistUrl);
		hls.attachMedia(videoEl);

		// Apply persisted volume state
		videoEl.volume = volume;
		videoEl.muted = muted;

		hls.on(Hls.Events.MANIFEST_PARSED, () => {
			// Reapply playback rate — attachMedia resets it to 1.0
			videoEl.playbackRate = get(masterPlaybackRate);
			if (shouldAutoPlay()) {
				needsInitialSeek = true;
				// Attempt early seek — may not work if no data buffered yet
				const mt = get(masterTime);
				const anchor = stream.startedAt / 1000;
				const targetLocal = Math.max(0, mt - anchor + offset);
				videoEl.currentTime = targetLocal;
				videoEl.play().catch(() => {});
			}
		});

		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (data.fatal) {
				switch (data.type) {
					case Hls.ErrorTypes.NETWORK_ERROR:
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

		// On first timeupdate after mount, seek to the master time position.
		// At this point videoEl.duration is valid so the seek will land correctly.
		if (needsInitialSeek) {
			needsInitialSeek = false;
			const mt = get(masterTime);
			const anchor = stream.startedAt / 1000;
			const targetLocal = Math.max(0, mt - anchor + offset);
			if (videoEl.duration && targetLocal <= videoEl.duration) {
				videoEl.currentTime = targetLocal;
			}
		}

		currentTime = videoEl.currentTime;
		duration = videoEl.duration || 0;

		// Throttle store updates to reduce churn
		const now = performance.now();
		if (now - lastStateUpdate >= STATE_UPDATE_INTERVAL) {
			lastStateUpdate = now;
			streamPlaybackStates.update((s) => ({
				...s,
				[stream.id]: { currentTime, duration, paused: videoEl.paused }
			}));
		}
	}

	// Init HLS when stream has data (capturing, stopped, or error — segments are on disk)
	$effect(() => {
		if (stream.status !== 'starting' && videoEl && !hls) {
			initHls();
		}
	});

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (hls) hls.destroy();
			if (retryTimeout) clearTimeout(retryTimeout);
		};
	});
</script>

<div class="stream-tile" class:focused class:starting={stream.status === 'starting'}>
	<div class="stream-header">
		<span class="channel-name">
			{#if trackNumber}<span class="track-number">{trackNumber}</span>{/if}<a href="https://twitch.tv/{stream.channel}" target="_blank" rel="noopener noreferrer" class="channel-link">{stream.channel}</a>{#if stream.sourceType === 'vod'}<span class="vod-badge">(VOD)</span>{/if}
			{#if stream.streamTitle}<span class="stream-title">{stream.streamTitle}</span>{/if}
			<span class="disk-usage">{formatBytes(stream.diskUsageBytes)}</span>
			{#if stream.chatMessageCount > 0}<span class="chat-count">{stream.chatMessageCount.toLocaleString()} msgs</span>{/if}
		</span>
		{#if stream.status === 'capturing' && stream.sourceType === 'vod'}
			<button class="btn-stop" onclick={() => stopStream(stream.id)} title="Stop downloading">Stop</button>
		{:else if stream.status === 'stopped'}
			<button class="btn-retranscribe" onclick={() => retranscribeStream(stream.id)} title="Re-transcribe entire recording">Re-transcribe</button>
			<span class="status-badge">Stopped</span>
		{:else if stream.status === 'starting' || stream.status === 'error'}
			<span class="status-badge" class:error={stream.status === 'error'}>
				{stream.status === 'starting' ? 'Starting...' : 'Error'}
			</span>
		{/if}
	</div>

	<div class="video-container">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoEl}
			ontimeupdate={handleTimeUpdate}
			title={stream.streamTitle || stream.channel}
			playsinline
			muted
		></video>

		{#if stream.status === 'starting'}
			<div class="overlay">
				<div class="spinner"></div>
				<p>Connecting to {stream.channel}...</p>
			</div>
		{/if}

		{#if captionLines.current || captionLines.prev}
			<div class="subtitles">
				{#if captionLines.prev}
					<p class="sub-prev">{captionLines.prev}</p>
				{/if}
				<p class="sub-current">{captionLines.current}</p>
			</div>
		{/if}

	</div>

	<div class="controls">
		<div class="volume-controls">
			<button class="btn-sm" onclick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
				{muted ? '🔇' : volume < 0.5 ? '🔈' : '🔊'}
			</button>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={muted ? 0 : volume}
				oninput={setVolume}
				class="volume-slider"
			/>
		</div>
		{#if stream.viewerCount != null}
			<span class="viewer-count">{stream.viewerCount.toLocaleString()}</span>
		{/if}
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
		height: 100%;
	}

	.stream-tile:hover {
		border-color: #4a4a7a;
	}

	.stream-tile.focused {
		border-color: #7c3aed;
		box-shadow: 0 0 20px rgba(124, 58, 237, 0.3);
		height: 100%;
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

	.track-number {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		background: #2a2a4a;
		border-radius: 3px;
		font-size: 0.7rem;
		color: #888;
		margin-right: 6px;
		flex-shrink: 0;
	}

	.channel-link {
		color: inherit;
		text-decoration: none;
	}

	.channel-link:hover {
		text-decoration: underline;
		color: #a78bfa;
	}

	.vod-badge {
		font-weight: 600;
		font-size: 0.65rem;
		color: #d97706;
		margin-left: 4px;
	}

	.stream-title {
		font-weight: 400;
		font-size: 0.7rem;
		color: #888;
		margin-left: 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.viewer-count {
		margin-left: auto;
		font-weight: 400;
		font-size: 0.7rem;
		color: #dc2626;
	}

	.viewer-count::before {
		content: '⏺ ';
		font-size: 0.5rem;
		vertical-align: middle;
	}

	.disk-usage {
		font-weight: 400;
		font-size: 0.7rem;
		color: #666;
		margin-left: 6px;
	}

	.chat-count {
		font-weight: 400;
		font-size: 0.7rem;
		color: #7c3aed;
		margin-left: 6px;
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

	.btn-stop {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 4px;
		border: 1px solid #d97706;
		background: transparent;
		color: #d97706;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition: background 0.15s, color 0.15s;
	}

	.btn-stop:hover {
		background: #d97706;
		color: #000;
	}

	.btn-retranscribe {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 2px 8px;
		border-radius: 4px;
		border: 1px solid #7c3aed;
		background: transparent;
		color: #7c3aed;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition: background 0.15s, color 0.15s;
	}

	.btn-retranscribe:hover {
		background: #7c3aed;
		color: #fff;
	}

	.status-badge.error {
		background: #dc2626;
		color: white;
	}


	.video-container {
		position: relative;
		width: 100%;
		flex: 1;
		min-height: 0;
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

	.subtitles {
		position: absolute;
		bottom: 8px;
		left: 8px;
		right: 8px;
		text-align: center;
		pointer-events: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.subtitles p {
		margin: 0;
		display: inline;
		background: rgba(0, 0, 0, 0.75);
		color: #fff;
		font-size: 0.8rem;
		line-height: 1.4;
		padding: 2px 8px;
		border-radius: 3px;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
	}

	.sub-prev {
		opacity: 0.45;
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

	.volume-controls {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.volume-slider {
		width: 60px;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: #2a2a4a;
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.volume-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 10px;
		height: 10px;
		background: #7c3aed;
		border-radius: 50%;
		cursor: pointer;
	}

	.volume-slider::-moz-range-thumb {
		width: 10px;
		height: 10px;
		background: #7c3aed;
		border: none;
		border-radius: 50%;
		cursor: pointer;
	}
</style>
