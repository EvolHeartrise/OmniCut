<script lang="ts">
	import { addStream } from '$lib/stores/streams.js';

	let channelInput = '';
	let loading = false;
	let error = '';

	async function handleAdd() {
		const channel = channelInput.trim();
		if (!channel) return;

		loading = true;
		error = '';

		try {
			await addStream(channel);
			channelInput = '';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to add stream';
		} finally {
			loading = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			handleAdd();
		}
	}
</script>

<div class="add-stream-bar">
	<div class="input-group">
		<span class="input-prefix">twitch.tv/</span>
		<input
			type="text"
			bind:value={channelInput}
			on:keydown={handleKeydown}
			placeholder="channel name"
			disabled={loading}
			class="channel-input"
		/>
		<button on:click={handleAdd} disabled={loading || !channelInput.trim()} class="add-btn">
			{loading ? '...' : '+ Add Stream'}
		</button>
	</div>

	{#if error}
		<p class="error">{error}</p>
	{/if}
</div>

<style>
	.add-stream-bar {
		padding: 12px 16px;
		background: #0f0f23;
		border-bottom: 1px solid #2a2a4a;
	}

	.input-group {
		display: flex;
		align-items: center;
		gap: 0;
		max-width: 600px;
	}

	.input-prefix {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-right: none;
		border-radius: 6px 0 0 6px;
		padding: 8px 10px;
		color: #666;
		font-size: 0.9rem;
		font-family: monospace;
	}

	.channel-input {
		flex: 1;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-left: none;
		border-right: none;
		padding: 8px 12px;
		color: #e0e0ff;
		font-size: 0.9rem;
		outline: none;
		font-family: monospace;
	}

	.channel-input::placeholder {
		color: #444;
	}

	.channel-input:focus {
		border-color: #7c3aed;
	}

	.add-btn {
		background: #7c3aed;
		border: 1px solid #7c3aed;
		border-radius: 0 6px 6px 0;
		color: white;
		padding: 8px 16px;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.2s;
	}

	.add-btn:hover:not(:disabled) {
		background: #6d28d9;
	}

	.add-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error {
		color: #ef4444;
		font-size: 0.8rem;
		margin-top: 6px;
	}
</style>
