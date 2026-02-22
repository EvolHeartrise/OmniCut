<script lang="ts">
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
	import DiscoveryBrowser from '$lib/components/DiscoveryBrowser.svelte';
	import MediaLibrary from '$lib/components/MediaLibrary.svelte';

	let sourcesTab = $state<'library' | 'browse'>('browse');
</script>

<main class="sources-content">
	<div class="sources-tabs">
		<button class="sources-tab" class:active={sourcesTab === 'library'} onclick={() => (sourcesTab = 'library')}
			>Library</button
		>
		<button class="sources-tab" class:active={sourcesTab === 'browse'} onclick={() => (sourcesTab = 'browse')}
			>Browse</button
		>
	</div>
	{#if sourcesTab === 'library'}
		<MediaLibrary />
	{:else}
		<AddStreamBar />
		<DiscoveryBrowser />
	{/if}
</main>

<style>
	.sources-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.sources-tabs {
		display: flex;
		gap: 2px;
		background: #1a1a2e;
		border-radius: 6px;
		padding: 2px;
		align-self: flex-start;
		flex-shrink: 0;
	}

	.sources-tab {
		background: none;
		border: none;
		color: #666;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 4px 14px;
		border-radius: 4px;
		cursor: pointer;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.sources-tab:hover {
		color: #aaa;
	}

	.sources-tab.active {
		background: #7c3aed;
		color: #fff;
	}
</style>
