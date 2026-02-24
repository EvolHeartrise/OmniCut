<script lang="ts">
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
	import DiscoveryBrowser from '$lib/components/DiscoveryBrowser.svelte';
</script>

<main class="browse-content">
	<AddStreamBar />
	<DiscoveryBrowser />
</main>

<style>
	.browse-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
</style>
