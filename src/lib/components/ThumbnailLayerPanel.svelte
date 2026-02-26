<script lang="ts">
	interface TextLayer {
		id: string;
		type: 'text';
		text: string;
		x: number;
		y: number;
		fontSize: number;
		fontFamily: string;
		color: string;
		strokeColor?: string;
		strokeWidth?: number;
		rotation?: number;
		scaleX?: number;
		scaleY?: number;
		locked?: boolean;
		shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
	}

	interface ImageLayer {
		id: string;
		type: 'image';
		x: number;
		y: number;
		rotation?: number;
		scaleX?: number;
		scaleY?: number;
		opacity?: number;
		locked?: boolean;
		streamId?: string;
		timestamp?: number;
		dataUrl?: string;
		naturalWidth: number;
		naturalHeight: number;
	}

	interface EffectLayer {
		id: string;
		type: 'effect';
		kind: 'blur' | 'ai';
		blurRadius?: number;
		prompt?: string;
		locked?: boolean;
	}

	type Layer = TextLayer | ImageLayer | EffectLayer;

	interface Props {
		layers: Layer[];
		selectedLayerIndex: number | null;
		onLayersChange: (layers: Layer[]) => void;
		onSelectLayer: (index: number | null) => void;
		onGenerateAI?: (layerIndex: number) => void;
		aiGeneratingIds?: Set<string>;
	}

	let { layers, selectedLayerIndex, onLayersChange, onSelectLayer, onGenerateAI, aiGeneratingIds }: Props = $props();

	const FONT_FAMILIES = [
		'Arial',
		'Arial Black',
		'Impact',
		'Georgia',
		'Verdana',
		'Trebuchet MS',
		'Courier New',
		'Times New Roman',
		'Comic Sans MS'
	];

	function addTextLayer() {
		const newLayer: TextLayer = {
			id: crypto.randomUUID().slice(0, 8),
			type: 'text',
			text: 'New Text',
			x: 0.5,
			y: 0.5,
			fontSize: 48,
			fontFamily: 'Arial Black',
			color: '#ffffff',
			strokeColor: '#000000',
			strokeWidth: 3
		};
		onLayersChange([...layers, newLayer]);
		onSelectLayer(layers.length);
	}

	function addBlurLayer() {
		const newLayer: EffectLayer = {
			id: crypto.randomUUID().slice(0, 8),
			type: 'effect',
			kind: 'blur',
			blurRadius: 8
		};
		onLayersChange([...layers, newLayer]);
		onSelectLayer(layers.length);
	}

	function addAILayer() {
		const newLayer: EffectLayer = {
			id: crypto.randomUUID().slice(0, 8),
			type: 'effect',
			kind: 'ai',
			prompt: ''
		};
		onLayersChange([...layers, newLayer]);
		onSelectLayer(layers.length);
	}

	function updateLayer(index: number, updates: Record<string, unknown>) {
		const updated = layers.map((l, i) => (i === index ? { ...l, ...updates } as Layer : l));
		onLayersChange(updated);
	}

	function duplicateLayer(index: number) {
		const layer = layers[index];
		const clone = { ...layer, id: crypto.randomUUID().slice(0, 8) } as Layer;
		const updated = [...layers];
		updated.splice(index + 1, 0, clone);
		onLayersChange(updated);
		onSelectLayer(index + 1);
	}

	function removeLayer(index: number) {
		onLayersChange(layers.filter((_, i) => i !== index));
		if (selectedLayerIndex === index) {
			onSelectLayer(null);
		} else if (selectedLayerIndex !== null && selectedLayerIndex > index) {
			onSelectLayer(selectedLayerIndex - 1);
		}
	}

	function toggleStroke(index: number) {
		const layer = layers[index];
		if (layer.type !== 'text') return;
		if (layer.strokeWidth) {
			updateLayer(index, { strokeWidth: 0 });
		} else {
			updateLayer(index, { strokeColor: layer.strokeColor || '#000000', strokeWidth: 3 });
		}
	}

	function toggleShadow(index: number) {
		const layer = layers[index];
		if (layer.type !== 'text') return;
		if (layer.shadow) {
			updateLayer(index, { shadow: undefined });
		} else {
			updateLayer(index, { shadow: { color: 'rgba(0,0,0,0.8)', blur: 4, offsetX: 2, offsetY: 2 } });
		}
	}

	// --- Drag-to-reorder state ---
	let dragFromVisual = $state<number | null>(null); // visual index being dragged
	let dropTargetVisual = $state<number | null>(null); // visual index of drop target

	let dragEnabled = $state(false);

	function handleGripMouseDown() {
		dragEnabled = true;
	}

	function handleDragStart(e: DragEvent, visualIndex: number) {
		if (!dragEnabled) {
			e.preventDefault();
			return;
		}
		dragFromVisual = visualIndex;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(visualIndex));
		}
	}

	function handleDragOver(e: DragEvent, visualIndex: number) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (dragFromVisual !== null && visualIndex !== dragFromVisual) {
			dropTargetVisual = visualIndex;
		}
	}

	function handleDragLeave() {
		dropTargetVisual = null;
	}

	function handleDrop(e: DragEvent, visualIndex: number) {
		e.preventDefault();
		if (dragFromVisual === null || dragFromVisual === visualIndex) {
			dragFromVisual = null;
			dropTargetVisual = null;
			return;
		}

		// Convert visual indices back to real layer indices (list is reversed)
		const fromReal = layers.length - 1 - dragFromVisual;
		const toReal = layers.length - 1 - visualIndex;

		// Reorder: remove from old position, insert at new position
		const updated = [...layers];
		const [moved] = updated.splice(fromReal, 1);
		updated.splice(toReal, 0, moved);
		onLayersChange(updated);

		// Update selection to follow the moved layer
		if (selectedLayerIndex === fromReal) {
			onSelectLayer(toReal);
		} else if (selectedLayerIndex !== null) {
			// Adjust selection if it shifted due to the move
			let newSel = selectedLayerIndex;
			if (fromReal < selectedLayerIndex && toReal >= selectedLayerIndex) {
				newSel--;
			} else if (fromReal > selectedLayerIndex && toReal <= selectedLayerIndex) {
				newSel++;
			}
			if (newSel !== selectedLayerIndex) onSelectLayer(newSel);
		}

		dragFromVisual = null;
		dropTargetVisual = null;
	}

	function handleDragEnd() {
		dragFromVisual = null;
		dropTargetVisual = null;
		dragEnabled = false;
	}

	function stop(e: Event) {
		e.stopPropagation();
	}
</script>

<div class="layer-panel">
	<div class="layers-header">
		<span class="layers-title">Layers</span>
		<div class="header-buttons">
			<button class="btn-add" onclick={addTextLayer}>+ Text</button>
			<button class="btn-add btn-add-fx" onclick={addBlurLayer}>+ Blur</button>
			<button class="btn-add btn-add-ai" onclick={addAILayer}>+ AI</button>
		</div>
	</div>

	{#if layers.length === 0}
		<p class="empty-hint">No layers. Add a frame or text to get started.</p>
	{:else}
		<div class="layer-list">
			{#each layers.toReversed() as layer, vi (layer.id)}
				{@const i = layers.length - 1 - vi}
				<div
					class="layer-item"
					class:selected={selectedLayerIndex === i}
					class:drag-over={dropTargetVisual === vi && dragFromVisual !== vi}
					class:dragging={dragFromVisual === vi}
					draggable="true"
					ondragstart={(e) => handleDragStart(e, vi)}
					ondragover={(e) => handleDragOver(e, vi)}
					ondragleave={handleDragLeave}
					ondrop={(e) => handleDrop(e, vi)}
					ondragend={handleDragEnd}
					onclick={() => onSelectLayer(i)}
					onkeydown={(e) => { if (e.key === 'Enter') onSelectLayer(i); }}
					role="button"
					tabindex="0"
				>
					<div class="layer-item-header">
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span class="drag-handle" title="Drag to reorder" onmousedown={handleGripMouseDown}>&#8942;&#8942;</span>
						<span class="layer-badge" class:badge-text={layer.type === 'text'} class:badge-img={layer.type === 'image'} class:badge-fx={layer.type === 'effect' && layer.kind === 'blur'} class:badge-ai={layer.type === 'effect' && layer.kind === 'ai'}>
							{layer.type === 'text' ? 'T' : layer.type === 'image' ? 'IMG' : layer.type === 'effect' && layer.kind === 'ai' ? 'AI' : 'FX'}
						</span>
						<span class="layer-label">
							{#if layer.type === 'text'}
								{layer.text.slice(0, 20)}{layer.text.length > 20 ? '...' : ''}
							{:else if layer.type === 'image'}
								{layer.dataUrl ? 'Pasted' : 'Frame'}
							{:else if layer.kind === 'ai'}
								{layer.prompt ? layer.prompt.slice(0, 18) + (layer.prompt.length > 18 ? '...' : '') : 'AI Edit'}
							{:else}
								Blur
							{/if}
						</span>
						<div class="layer-item-actions">
							<button class="btn-lock" class:locked={layer.locked} onclick={(e) => { e.stopPropagation(); updateLayer(i, { locked: !layer.locked }); }} title={layer.locked ? 'Unlock' : 'Lock'}>{layer.locked ? '&#128274;' : '&#128275;'}</button>
							<button class="btn-action" onclick={(e) => { e.stopPropagation(); duplicateLayer(i); }} title="Duplicate">&#9851;</button>
							<button class="btn-remove" onclick={(e) => { e.stopPropagation(); removeLayer(i); }} title="Delete">&times;</button>
						</div>
					</div>

					{#if selectedLayerIndex === i}
						{#if layer.type === 'text'}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<textarea
								class="layer-text-input"
								value={layer.text}
								oninput={(e) => updateLayer(i, { text: (e.target as HTMLTextAreaElement).value })}
								placeholder="Enter text..."
								rows="2"
								onclick={stop}
							></textarea>

							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="layer-row" onclick={stop}>
								<label class="layer-field">
									Font
									<select class="layer-select" value={layer.fontFamily} onchange={(e) => updateLayer(i, { fontFamily: (e.target as HTMLSelectElement).value })}>
										{#each FONT_FAMILIES as font}
											<option value={font}>{font}</option>
										{/each}
									</select>
								</label>
							</div>

							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="layer-row" onclick={stop}>
								<label class="layer-field">
									Color
									<input
										class="layer-color"
										type="color"
										value={layer.color}
										oninput={(e) => updateLayer(i, { color: (e.target as HTMLInputElement).value })}
									/>
								</label>
								<label class="layer-field layer-toggle">
									<input type="checkbox" checked={!!layer.strokeWidth} onchange={() => toggleStroke(i)} />
									Stroke
								</label>
								{#if layer.strokeWidth}
									<label class="layer-field">
										<input
											class="layer-color"
											type="color"
											value={layer.strokeColor || '#000000'}
											oninput={(e) => updateLayer(i, { strokeColor: (e.target as HTMLInputElement).value })}
										/>
									</label>
									<label class="layer-field">
										<input
											class="layer-number"
											type="number"
											min="1"
											max="20"
											value={layer.strokeWidth}
											oninput={(e) => updateLayer(i, { strokeWidth: +(e.target as HTMLInputElement).value })}
										/>
									</label>
								{/if}
							</div>

							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="layer-row" onclick={stop}>
								<label class="layer-field layer-toggle">
									<input type="checkbox" checked={!!layer.shadow} onchange={() => toggleShadow(i)} />
									Shadow
								</label>
							</div>
						{:else if layer.type === 'image'}
							<!-- Image layer controls -->
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="layer-row" onclick={stop}>
								<label class="layer-field">
									Opacity
									<input
										class="layer-slider"
										type="range"
										min="0"
										max="1"
										step="0.05"
										value={layer.opacity ?? 1}
										oninput={(e) => updateLayer(i, { opacity: +(e.target as HTMLInputElement).value })}
									/>
									<span class="layer-value">{Math.round((layer.opacity ?? 1) * 100)}%</span>
								</label>
							</div>
						{:else if layer.type === 'effect' && layer.kind === 'blur'}
							<!-- Blur effect controls -->
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="layer-row" onclick={stop}>
								<label class="layer-field">
									Blur Radius
									<input
										class="layer-slider"
										type="range"
										min="1"
										max="40"
										step="1"
										value={layer.blurRadius ?? 8}
										oninput={(e) => updateLayer(i, { blurRadius: +(e.target as HTMLInputElement).value })}
									/>
									<span class="layer-value">{layer.blurRadius ?? 8}px</span>
								</label>
							</div>
							<span class="effect-hint">Blurs all layers below</span>
						{:else if layer.type === 'effect' && layer.kind === 'ai'}
							<!-- AI effect controls -->
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="ai-controls" onclick={stop}>
								<textarea
									class="layer-text-input"
									value={layer.prompt ?? ''}
									oninput={(e) => updateLayer(i, { prompt: (e.target as HTMLTextAreaElement).value })}
									placeholder="Describe the edit (e.g., 'make it look cinematic')"
									rows="2"
								></textarea>
								<button
									class="btn-generate"
									onclick={() => onGenerateAI?.(i)}
									disabled={!layer.prompt?.trim() || aiGeneratingIds?.has(layer.id)}
								>
									{aiGeneratingIds?.has(layer.id) ? 'Generating...' : 'Generate'}
								</button>
							</div>
							<span class="effect-hint">AI-edits all layers below using Nano Banana Pro</span>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.layer-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.layers-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.header-buttons {
		display: flex;
		gap: 4px;
	}

	.layers-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: #ccc;
	}

	.btn-add {
		background: #7c3aed;
		border: none;
		color: #fff;
		font-size: 0.65rem;
		font-weight: 600;
		padding: 4px 12px;
		border-radius: 4px;
		cursor: pointer;
	}

	.btn-add:hover {
		background: #6d28d9;
	}

	.empty-hint {
		font-size: 0.7rem;
		color: #666;
	}

	.layer-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 500px;
		overflow-y: auto;
	}

	.layer-item {
		background: #0f0f23;
		border: 1px solid #2a2a4a;
		border-radius: 6px;
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.layer-item:hover {
		border-color: #3a3a5a;
	}

	.layer-item.selected {
		border-color: #7c3aed;
		background: rgba(124, 58, 237, 0.05);
	}

	.layer-item.dragging {
		opacity: 0.4;
	}

	.layer-item.drag-over {
		border-top: 2px solid #7c3aed;
	}

	.layer-item-header {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.drag-handle {
		cursor: grab;
		color: #555;
		font-size: 0.65rem;
		letter-spacing: -3px;
		user-select: none;
		padding: 0 2px;
		flex-shrink: 0;
	}

	.drag-handle:hover {
		color: #999;
	}

	.dragging .drag-handle {
		cursor: grabbing;
	}

	.layer-badge {
		font-size: 0.55rem;
		font-weight: 700;
		padding: 2px 5px;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.badge-text {
		background: #3b82f6;
		color: #fff;
	}

	.badge-img {
		background: #22c55e;
		color: #fff;
	}

	.badge-fx {
		background: #f59e0b;
		color: #fff;
	}

	.btn-add-fx {
		background: #d97706;
	}

	.btn-add-fx:hover {
		background: #b45309;
	}

	.btn-add-ai {
		background: #9333ea;
	}

	.btn-add-ai:hover {
		background: #7e22ce;
	}

	.badge-ai {
		background: #9333ea;
		color: #fff;
	}

	.ai-controls {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.btn-generate {
		background: #9333ea;
		border: none;
		color: #fff;
		font-size: 0.65rem;
		font-weight: 600;
		padding: 5px 12px;
		border-radius: 4px;
		cursor: pointer;
		align-self: flex-start;
	}

	.btn-generate:hover:not(:disabled) {
		background: #7e22ce;
	}

	.btn-generate:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.effect-hint {
		font-size: 0.6rem;
		color: #666;
		font-style: italic;
	}

	.layer-label {
		font-size: 0.7rem;
		color: #ccc;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.layer-item-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.btn-action, .btn-lock, .btn-remove {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #888;
		font-size: 0.6rem;
		padding: 2px 6px;
		border-radius: 3px;
		cursor: pointer;
		line-height: 1;
	}

	.btn-action:hover { color: #ccc; background: #2a2a4a; }
	.btn-lock.locked { color: #f59e0b; }
	.btn-lock:hover { color: #ccc; }
	.btn-remove:hover { color: #f87171; border-color: #5a2a2a; }

	.layer-text-input {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 4px;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 5px 8px;
		font-family: inherit;
		width: 100%;
		resize: vertical;
	}

	.layer-text-input:focus {
		outline: none;
		border-color: #7c3aed;
	}

	.layer-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.layer-field {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.6rem;
		color: #888;
	}

	.layer-toggle {
		flex-direction: row;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}

	.layer-toggle input[type="checkbox"] {
		accent-color: #7c3aed;
	}

	.layer-select {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 3px;
		color: #e0e0ff;
		font-size: 0.65rem;
		padding: 3px 4px;
		font-family: inherit;
	}

	.layer-number {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 3px;
		color: #e0e0ff;
		font-size: 0.65rem;
		padding: 3px 4px;
		width: 50px;
	}

	.layer-color {
		width: 28px;
		height: 22px;
		border: 1px solid #2a2a4a;
		border-radius: 3px;
		padding: 0;
		cursor: pointer;
		background: none;
	}

	.layer-slider {
		width: 100%;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: #2a2a4a;
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}

	.layer-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		cursor: pointer;
	}

	.layer-slider::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #7c3aed;
		border: none;
		cursor: pointer;
	}

	.layer-value {
		font-size: 0.6rem;
		color: #aaa;
		font-variant-numeric: tabular-nums;
	}
</style>
