<script lang="ts">
	import { enhanceThumbnailCmd } from '$lib/streams.remote';

	interface Props {
		thumbnailId: string;
		aiConfigured: boolean;
		onResult: (pngBase64: string, thumbnailRecord: { id: string }) => void;
		onRevert: () => void;
		hasAIImage: boolean;
	}

	let { thumbnailId, aiConfigured, onResult, onRevert, hasAIImage }: Props = $props();

	let expanded = $state(false);
	let prompt = $state('');
	let generating = $state(false);
	let error = $state<string | null>(null);
	let history = $state<Array<{ prompt: string; imageBase64?: string }>>([]);

	async function handleGenerate() {
		if (!prompt.trim() || generating) return;
		generating = true;
		error = null;

		try {
			const conversationHistory = history.map((h) => ({
				role: 'user' as const,
				text: h.prompt,
				...(h.imageBase64 && { imageBase64: h.imageBase64 })
			}));

			const result = await enhanceThumbnailCmd({
				thumbnailId,
				prompt: prompt.trim(),
				conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined
			});

			history = [...history, { prompt: prompt.trim(), imageBase64: result.pngBase64 }];
			onResult(result.pngBase64, result.thumbnailRecord);
			prompt = '';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			generating = false;
		}
	}
</script>

<div class="ai-panel">
	<button class="ai-toggle" onclick={() => { expanded = !expanded; }}>
		{expanded ? '\u25BE' : '\u25B8'} AI Enhance
	</button>

	{#if expanded}
		<div class="ai-content">
			{#if !aiConfigured}
				<div class="ai-not-configured">
					<p>AI enhancement requires a Google Gemini API key.</p>
					<p class="ai-hint">Set <code>GOOGLE_GENAI_API_KEY</code> in your <code>.env</code> file and restart the server.</p>
				</div>
			{:else}
				<p class="ai-info">Save your thumbnail first, then use AI to enhance it.</p>

				{#if history.length > 0}
					<div class="ai-history">
						{#each history as entry, i (i)}
							<div class="history-entry">
								<span class="history-prompt">{entry.prompt}</span>
							</div>
						{/each}
					</div>
				{/if}

				<div class="ai-input-row">
					<input
						class="ai-prompt-input"
						type="text"
						bind:value={prompt}
						placeholder="Make it more dramatic..."
						onkeydown={(e) => { if (e.key === 'Enter' && prompt.trim()) handleGenerate(); }}
						disabled={generating}
					/>
					<button
						class="btn-generate"
						onclick={handleGenerate}
						disabled={generating || !prompt.trim()}
					>
						{generating ? 'Generating...' : 'Generate'}
					</button>
				</div>

				{#if error}
					<div class="ai-error">{error}</div>
				{/if}

				{#if hasAIImage}
					<button class="btn-revert" onclick={onRevert}>
						Revert to Original
					</button>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.ai-panel {
		margin-top: 8px;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		overflow: hidden;
	}

	.ai-toggle {
		width: 100%;
		background: #1a1a2e;
		border: none;
		color: #ccc;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 8px 12px;
		text-align: left;
		cursor: pointer;
	}

	.ai-toggle:hover {
		background: #22223a;
	}

	.ai-content {
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.ai-not-configured {
		padding: 10px;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
	}

	.ai-not-configured p {
		font-size: 0.75rem;
		color: #888;
		margin: 4px 0;
	}

	.ai-hint code {
		background: #0a0a1a;
		padding: 1px 4px;
		border-radius: 2px;
		color: #4ade80;
		font-size: 0.7rem;
	}

	.ai-info {
		font-size: 0.7rem;
		color: #666;
	}

	.ai-history {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 120px;
		overflow-y: auto;
	}

	.history-entry {
		padding: 4px 8px;
		background: #0f0f23;
		border-radius: 4px;
	}

	.history-prompt {
		font-size: 0.65rem;
		color: #a78bfa;
	}

	.ai-input-row {
		display: flex;
		gap: 8px;
	}

	.ai-prompt-input {
		flex: 1;
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 6px 10px;
		font-family: inherit;
	}

	.ai-prompt-input:focus {
		outline: none;
		border-color: #7c3aed;
	}

	.ai-prompt-input:disabled {
		opacity: 0.5;
	}

	.btn-generate {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
	}

	.btn-generate:hover:not(:disabled) {
		background: #6d28d9;
	}

	.btn-generate:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ai-error {
		font-size: 0.7rem;
		color: #f87171;
		padding: 6px 10px;
		background: rgba(220, 38, 38, 0.08);
		border-radius: 4px;
	}

	.btn-revert {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.7rem;
		padding: 6px 12px;
		border-radius: 4px;
		cursor: pointer;
	}

	.btn-revert:hover {
		background: #3a3a5a;
		color: #fff;
	}
</style>
