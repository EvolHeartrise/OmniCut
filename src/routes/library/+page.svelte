<script lang="ts">
	import MediaLibrary from '$lib/components/MediaLibrary.svelte';
</script>

<main class="library-content">
	<MediaLibrary />
</main>

<style>
	.library-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
</style>
