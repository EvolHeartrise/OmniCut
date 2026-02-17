<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let currentTime: number = 0;
	export let duration: number = 0;
	export let isLive: boolean = true;

	const dispatch = createEventDispatcher<{ seek: number; live: void }>();

	let trackEl: HTMLDivElement;
	let isDragging = false;

	$: progress = duration > 0 ? (currentTime / duration) * 100 : 0;

	function formatTime(seconds: number): string {
		if (!isFinite(seconds) || seconds < 0) return '0:00';
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		if (h > 0) {
			return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
		}
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function getTimeFromMouseEvent(e: MouseEvent): number {
		if (!trackEl) return 0;
		const rect = trackEl.getBoundingClientRect();
		const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
		const ratio = x / rect.width;
		return ratio * duration;
	}

	function handleMouseDown(e: MouseEvent) {
		isDragging = true;
		const time = getTimeFromMouseEvent(e);
		dispatch('seek', time);
		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);
	}

	function handleMouseMove(e: MouseEvent) {
		if (!isDragging) return;
		const time = getTimeFromMouseEvent(e);
		dispatch('seek', time);
	}

	function handleMouseUp() {
		isDragging = false;
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', handleMouseUp);
	}

	function handleLiveClick() {
		dispatch('live');
	}
</script>

<div class="timeline">
	<span class="time-label">{formatTime(currentTime)}</span>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="track" bind:this={trackEl} on:mousedown={handleMouseDown}>
		<div class="track-fill" style="width: {progress}%"></div>
		<div class="track-thumb" style="left: {progress}%"></div>
	</div>

	<span class="time-label">{formatTime(duration)}</span>

	<button
		class="live-btn"
		class:active={isLive}
		on:click={handleLiveClick}
		title="Snap to live"
	>
		LIVE
	</button>
</div>

<style>
	.timeline {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
	}

	.time-label {
		font-size: 0.7rem;
		color: #888;
		font-variant-numeric: tabular-nums;
		min-width: 3.5em;
		text-align: center;
	}

	.track {
		flex: 1;
		height: 6px;
		background: #2a2a4a;
		border-radius: 3px;
		position: relative;
		cursor: pointer;
	}

	.track-fill {
		height: 100%;
		background: #7c3aed;
		border-radius: 3px;
		transition: width 0.1s linear;
	}

	.track-thumb {
		position: absolute;
		top: 50%;
		transform: translate(-50%, -50%);
		width: 12px;
		height: 12px;
		background: #a78bfa;
		border-radius: 50%;
		border: 2px solid #1a1a2e;
		transition: left 0.1s linear;
	}

	.track:hover .track-thumb {
		width: 14px;
		height: 14px;
	}

	.live-btn {
		background: #333;
		border: none;
		color: #888;
		font-size: 0.65rem;
		font-weight: 800;
		padding: 3px 8px;
		border-radius: 4px;
		cursor: pointer;
		letter-spacing: 0.5px;
		transition: all 0.2s;
	}

	.live-btn.active {
		background: #dc2626;
		color: white;
	}

	.live-btn:hover {
		background: #dc2626;
		color: white;
	}
</style>
