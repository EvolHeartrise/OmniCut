<script lang="ts">
	import AddStreamBar from '$lib/components/AddStreamBar.svelte';
</script>

<main class="watchlist-content">
	<AddStreamBar />
</main>

<style>
	.watchlist-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
</style>
