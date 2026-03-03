<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import Hls from 'hls.js';
	import {
		videos,
		clipRegions,
		streams,
		syncOffsets
	} from '$lib/stores/streams.js';
	import {
		getVideoById,
		updateVideoCmd,
		deleteVideoCmd,
		exportVideoFromVideoCmd,
		getMultiStreamTranscriptions,
		getChatMessageByTwitchId,
		uploadOverlayImageCmd,
		uploadOverlayAudioCmd,
		getCensorTerms,
		addCensorTermCmd,
		removeCensorTermCmd
	} from '$lib/streams.remote';
	import { getCameraBounds } from '$lib/stores/streams.js';
	import { untrack } from 'svelte';
	import { formatDuration, getClipLocalBounds, setupHls, usernameColor } from '$lib/utils.js';
	import type { ClipEntry, EffectEntry, CameraBoundsEntry } from '$lib/types.js';
	import type { ClipRegion } from '$lib/stores/streams.js';
	import { computeTickInterval, handleTimelineWheel, zoomIn as tzZoomIn, zoomOut as tzZoomOut } from '$lib/timeline.js';
	import { TRACK_COLORS } from '$lib/constants.js';
	import { nanoid } from 'nanoid';
	import { parseEmotes, getThirdPartyEmotes, type ChatSegment, type EmoteMap } from '$lib/emoteParser.js';
	import { resolveBadges, fetchTwitchBadges, type BadgeInfo } from '$lib/badgeParser.js';
	import ClipChatPanel from '$lib/components/ClipChatPanel.svelte';
	import ChatPanelPreview from '$lib/components/ChatPanelPreview.svelte';

	let videoId = $derived(page.params.id as string);

	// Primary video data — reactively derived from SSE-updated store
	let video = $derived($videos.find((v) => v.id === videoId) ?? null);

	// Local editable state (initialized from video, auto-saved on change)
	let title = $state('');
	let description = $state('');
	let entries = $state<ClipEntry[]>([]);
	let loaded = $state(false);

	// --- Effect entries state ---
	let effectEntries = $state<EffectEntry[]>([]);
	let selectedEffectId = $state<string | null>(null);
	let addingEffect = $state(false);
	let addEffectTwitchId = $state('');
	let draggingOverlay = $state<string | null>(null);
	let dragOffset = $state({ x: 0, y: 0 });

	interface ResolvedChatMessage {
		username: string;
		text: string;
		color: string | null;
		segments: ChatSegment[];
		badges: BadgeInfo[];
		twitchId: string;
	}
	let chatMessageCache = $state<Map<string, ResolvedChatMessage>>(new Map());

	// Chat panel state
	let chatPanelOpen = $state(false);

	// Censor terms state
	let censorTerms = $state<string[]>([]);
	let newCensorTerm = $state('');
	let censorExpanded = $state(false);

	// Load censor terms on mount
	$effect(() => {
		getCensorTerms().then((terms) => { censorTerms = terms; });
	});

	async function handleAddCensorTerm() {
		const term = newCensorTerm.trim();
		if (!term) return;
		await addCensorTermCmd({ term });
		newCensorTerm = '';
		censorTerms = await getCensorTerms();
	}

	async function handleRemoveCensorTerm(term: string) {
		await removeCensorTermCmd({ term });
		censorTerms = await getCensorTerms();
	}

	// --- Canvas preview (vertical and multi-track standard) ---
	const VERT_OUT_W = 1080;
	const VERT_OUT_H = 1920;
	const VERT_CANVAS_W = 540; // half-res for perf, CSS-scaled
	const VERT_CANVAS_H = 960;
	let verticalCanvasEl = $state<HTMLCanvasElement | null>(null);
	let verticalRafId: number | null = null;
	let currentCamBounds = $state<CameraBoundsEntry | null>(null);

	// Track whether we've initialized local state from the video
	let initialized = $state(false);

	// Initialize from video on first load or when video changes from server
	$effect(() => {
		if (video && !initialized) {
			title = video.title;
			description = video.description || '';
			entries = structuredClone(video.clipEntries);
			effectEntries = structuredClone(video.effectEntries ?? []);
			initialized = true;
			loaded = true;
			// Fetch chat message data for all effect entries
			for (const entry of video.effectEntries ?? []) {
				if (entry.twitchId) fetchChatMessage(entry.twitchId);
			}
		}
	});

	// Load video from server if not in store
	onMount(async () => {
		if (!video) {
			try {
				const fetched = await getVideoById({ id: videoId });
				videos.update((v) => {
					if (v.find((x) => x.id === fetched.id)) return v;
					return [...v, fetched];
				});
			} catch {
				// Video not found
			}
		}
	});

	// --- Auto-save (debounced) ---
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let saving = $state(false);
	let lastSavedAt = $state<number | null>(null);

	function scheduleSave() {
		if (!initialized) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(doSave, 600);
	}

	async function doSave() {
		if (!video) return;
		saving = true;
		try {
			await updateVideoCmd({
				id: video.id,
				title: title.trim() || 'Untitled',
				description: description.trim() || undefined,
				clipEntries: entries,
				effectEntries
			});
			lastSavedAt = Date.now();
		} catch (err) {
			console.error('Failed to save video:', err);
		} finally {
			saving = false;
		}
	}

	// Trigger auto-save when editable fields change
	$effect(() => {
		void title;
		void description;
		void JSON.stringify(entries);
		void JSON.stringify(effectEntries);
		if (initialized) scheduleSave();
	});

	// --- Clip resolution ---
	let streamMap = $derived(new Map($streams.map((s) => [s.id, s])));

	function resolveClip(clipId: string): ClipRegion | undefined {
		return $clipRegions.find((c) => c.id === clipId);
	}

	function clipChannel(clip: ClipRegion): string {
		return streamMap.get(clip.streamId)?.channel || 'unknown';
	}

	function clipDuration(clip: ClipRegion, entry: ClipEntry): number {
		let dur = clip.endTime - clip.startTime;
		if (entry.trimStart) dur -= entry.trimStart;
		if (entry.trimEnd) dur -= entry.trimEnd;
		return Math.max(0, dur);
	}

	function clipRawDuration(clip: ClipRegion): number {
		return clip.endTime - clip.startTime;
	}

	// --- Timeline state ---
	const MIN_PPS = 1;
	const MAX_PPS = 200;
	let pixelsPerSecond = $state(50);
	let compositionTime = $state(0);
	let selectedIndex = $state<number | null>(null);

	// Drag state
	let dragMode = $state<'none' | 'reorder' | 'trim-start' | 'trim-end' | 'move-track'>('none');
	let dragEntryIndex = $state<number | null>(null);
	let dragStartX = $state(0);
	let dragStartY = $state(0);
	let dragStartValue = $state(0);
	let dragInsertIndex = $state<number | null>(null);
	let dragPreviewDelta = $state(0);
	let dragStartTrack = $state(0);

	// Scroll/viewport
	let scrollAreaEl = $state<HTMLDivElement | null>(null);
	let viewportLeft = $state(0);
	let viewportWidth = $state(2000);
	const CULL_MARGIN = 200;
	let ignoreScrollEvents = false;

	// Ghost playhead (mouse hover)
	let ghostX = $state<number | null>(null);

	function handleTimelineMouseMove(e: MouseEvent) {
		if (!scrollAreaEl) return;
		const rect = scrollAreaEl.getBoundingClientRect();
		ghostX = e.clientX - rect.left + scrollAreaEl.scrollLeft;
	}

	function handleTimelineMouseLeave() {
		ghostX = null;
	}

	function updateViewport() {
		if (!scrollAreaEl) return;
		viewportLeft = scrollAreaEl.scrollLeft;
		viewportWidth = scrollAreaEl.clientWidth;
	}

	// --- Clip layout (precomputed positions) ---
	interface ClipLayoutEntry {
		index: number;
		entry: ClipEntry;
		clip: ClipRegion | undefined;
		startOffset: number;
		effectiveDuration: number;
		color: string;
	}

	// Per-track layout maps
	let trackLayouts = $derived.by(() => {
		const map = new Map<number, ClipLayoutEntry[]>();
		// Track 0: sequential layout
		const track0: ClipLayoutEntry[] = [];
		let offset = 0;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if ((entry.track ?? 0) !== 0) continue;
			const clip = resolveClip(entry.clipId);
			const dur = clip ? clipDuration(clip, entry) : 0;
			track0.push({
				index: i,
				entry,
				clip,
				startOffset: offset,
				effectiveDuration: dur,
				color: TRACK_COLORS[i % TRACK_COLORS.length]
			});
			offset += dur;
		}
		map.set(0, track0);

		// Tracks 1+: absolute positioning via startTime
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const track = entry.track ?? 0;
			if (track === 0) continue;
			if (!map.has(track)) map.set(track, []);
			const clip = resolveClip(entry.clipId);
			const dur = clip ? clipDuration(clip, entry) : 0;
			map.get(track)!.push({
				index: i,
				entry,
				clip,
				startOffset: entry.startTime ?? 0,
				effectiveDuration: dur,
				color: TRACK_COLORS[i % TRACK_COLORS.length]
			});
		}
		return map;
	});

	let clipLayout = $derived(trackLayouts.get(0) ?? []);

	let totalDuration = $derived.by(() => {
		let maxEnd = 0;
		for (const [, layout] of trackLayouts) {
			for (const cl of layout) {
				const end = cl.startOffset + cl.effectiveDuration;
				if (end > maxEnd) maxEnd = end;
			}
		}
		return maxEnd;
	});

	// Content width for timeline
	let contentWidth = $derived(Math.max(totalDuration * pixelsPerSecond + 200, 100));

	// Ruler ticks
	let tickInterval = $derived(computeTickInterval(pixelsPerSecond, 60));

	let ticks = $derived.by(() => {
		const result: { x: number; label: string }[] = [];
		const visMin = viewportLeft - CULL_MARGIN;
		const visMax = viewportLeft + viewportWidth + CULL_MARGIN;
		const tMin = visMin / pixelsPerSecond;
		const start = Math.max(0, Math.ceil(tMin / tickInterval) * tickInterval);
		for (let t = start; t <= totalDuration + tickInterval; t += tickInterval) {
			const x = t * pixelsPerSecond;
			if (x > visMax) break;
			if (x >= 0) {
				result.push({ x, label: formatDuration(t) });
			}
		}
		return result;
	});

	// Playhead X
	let playheadX = $derived(compositionTime * pixelsPerSecond);

	// Auto-select clip under playhead
	$effect(() => {
		const t = compositionTime;
		if (dragMode !== 'none') return;
		let found: number | null = null;
		for (const cl of clipLayout) {
			if (t >= cl.startOffset && t < cl.startOffset + cl.effectiveDuration) {
				found = cl.index;
				break;
			}
		}
		selectedIndex = found;
	});

	// --- Entry management ---
	function updateEntry(index: number, updates: Partial<ClipEntry>) {
		entries = entries.map((e, i) => (i === index ? { ...e, ...updates } : e));
	}

	function removeEntry(index: number) {
		entries = entries.filter((_, i) => i !== index);
		if (selectedIndex === index) selectedIndex = null;
		else if (selectedIndex !== null && selectedIndex > index) selectedIndex--;
	}

	function splitAtPlayhead() {
		const t = compositionTime;
		const cl = clipLayout.find((c) => t > c.startOffset && t < c.startOffset + c.effectiveDuration);
		if (!cl || !cl.clip) return;
		const entry = cl.entry;
		// Convert timeline offset at split point to source-time offset
		const sourceOffset = t - cl.startOffset;
		const rawDur = cl.clip.endTime - cl.clip.startTime;
		const first: ClipEntry = {
			...entry,
			trimEnd: rawDur - (entry.trimStart || 0) - sourceOffset
		};
		const second: ClipEntry = {
			...entry,
			trimStart: (entry.trimStart || 0) + sourceOffset,
			transition: undefined,
			transitionDuration: undefined
		};
		entries = [...entries.slice(0, cl.index), first, second, ...entries.slice(cl.index + 1)];
		selectedIndex = cl.index;
	}

	// --- Clip picker ---
	let showClipPicker = $state(false);
	let pickerFilter = $state('');
	let pickerClips = $derived.by(() => {
		const existingIds = new Set(entries.map((e) => e.clipId));
		let available = $clipRegions.filter((c) => !existingIds.has(c.id));
		if (pickerFilter) {
			const q = pickerFilter.toLowerCase();
			available = available.filter((c) => {
				const ch = clipChannel(c);
				return ch.includes(q) || (c.title || '').toLowerCase().includes(q) || (c.notes || '').toLowerCase().includes(q);
			});
		}
		return available.sort((a, b) => a.startTime - b.startTime);
	});

	function addClip(clipId: string) {
		entries = [...entries, { clipId }];
	}

	// --- Effect entry management ---
	async function fetchChatMessage(twitchId: string) {
		if (chatMessageCache.has(twitchId)) return;
		try {
			const msg = await getChatMessageByTwitchId({ twitchId });
			if (!msg) return;
			const stream = streamMap.get(msg.streamId);
			const channel = stream?.channel ?? null;
			const [badgeMap, thirdPartyEmotes] = await Promise.all([
				fetchTwitchBadges(channel),
				channel ? getThirdPartyEmotes(channel) : Promise.resolve(new Map() as EmoteMap)
			]);
			const segments = parseEmotes(msg.text, msg.emotes, thirdPartyEmotes);
			const badges = resolveBadges(msg.badges, badgeMap);
			chatMessageCache = new Map(chatMessageCache).set(twitchId, {
				username: msg.username,
				text: msg.text,
				color: msg.color ?? null,
				segments,
				badges,
				twitchId: msg.twitchId
			});
		} catch (err) {
			console.error('Failed to fetch chat message:', err);
		}
	}

	function addEffectEntry(twitchId: string) {
		const id = nanoid(12);
		const entry: EffectEntry = {
			id,
			type: 'chat-message',
			startTime: compositionTime,
			duration: 5,
			x: 0.5,
			y: 0.5,
			twitchId
		};
		effectEntries = [...effectEntries, entry];
		selectedEffectId = id;
		fetchChatMessage(twitchId);
	}

	function addTwitchChatEffect() {
		const id = nanoid(12);
		const entry: EffectEntry = {
			id,
			type: 'twitch-chat',
			startTime: compositionTime,
			duration: 10,
			x: 0.82,
			y: 0.5,
			panelWidth: 340,
			panelHeight: 1080
		};
		effectEntries = [...effectEntries, entry];
		selectedEffectId = id;
	}

	function addViewEffect(preset?: 'full' | 'top-bottom' | 'pip') {
		const dur = totalDuration || 10;
		if (preset === 'top-bottom') {
			// Create two views: top (full frame) and bottom (camera)
			const topId = nanoid(12);
			const botId = nanoid(12);
			const topEntry: EffectEntry = {
				id: topId, type: 'view', startTime: 0, duration: dur, x: 0, y: 0,
				viewSourceType: 'full',
				viewDestX: 0, viewDestY: 0, viewDestW: 1, viewDestH: 0.64, viewZOrder: 0,
			};
			const botEntry: EffectEntry = {
				id: botId, type: 'view', startTime: 0, duration: dur, x: 0, y: 0,
				viewSourceType: 'camera',
				viewDestX: 0, viewDestY: 0.64, viewDestW: 1, viewDestH: 0.36, viewZOrder: 0,
			};
			effectEntries = [...effectEntries, topEntry, botEntry];
			selectedEffectId = topId;
			return;
		}
		if (preset === 'pip') {
			// Create two views: full-frame background + small camera PiP
			const bgId = nanoid(12);
			const pipId = nanoid(12);
			const bgEntry: EffectEntry = {
				id: bgId, type: 'view', startTime: 0, duration: dur, x: 0, y: 0,
				viewSourceType: 'full',
				viewDestX: 0, viewDestY: 0, viewDestW: 1, viewDestH: 1, viewZOrder: 0,
			};
			const pipEntry: EffectEntry = {
				id: pipId, type: 'view', startTime: 0, duration: dur, x: 0, y: 0,
				viewSourceType: 'camera',
				viewDestX: 0.72, viewDestY: 0.72, viewDestW: 0.26, viewDestH: 0.26, viewZOrder: 1,
			};
			effectEntries = [...effectEntries, bgEntry, pipEntry];
			selectedEffectId = bgId;
			return;
		}
		// Default: single view, full frame source, full canvas dest
		const id = nanoid(12);
		const entry: EffectEntry = {
			id,
			type: 'view',
			startTime: compositionTime,
			duration: dur,
			x: 0, y: 0,
			viewSourceType: 'full',
			viewDestX: 0, viewDestY: 0, viewDestW: 1, viewDestH: 1,
			viewZOrder: 0,
		};
		effectEntries = [...effectEntries, entry];
		selectedEffectId = id;
	}

	function addSubtitleEffect() {
		const id = nanoid(12);
		const entry: EffectEntry = {
			id,
			type: 'subtitle',
			startTime: compositionTime,
			duration: 5,
			x: 0.5,
			y: 0.85,
			subtitleText: 'Subtitle text',
			subtitleFontSize: 48,
			subtitleFontColor: '#FFFFFF',
			subtitleOutlineColor: '#000000',
			subtitleOutlineWidth: 4,
			subtitleFontWeight: 700,
			subtitleMaxWidth: 900,
			subtitleTextAlign: 'center',
			animIn: 'grow',
			animOut: 'shrink',
			animDuration: 0.3,
		};
		effectEntries = [...effectEntries, entry];
		selectedEffectId = id;
	}

	let droppingImage = $state(false);

	function handleImageDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		droppingImage = true;
	}

	function handleImageDragLeave() {
		droppingImage = false;
	}

	async function handleImageDrop(e: DragEvent) {
		e.preventDefault();
		droppingImage = false;
		const files = e.dataTransfer?.files;
		if (!files || files.length === 0) return;
		const file = files[0];

		if (file.type.startsWith('audio/')) {
			await handleAudioDrop(file);
			return;
		}

		if (!file.type.startsWith('image/')) return;

		// Read file as base64
		const arrayBuf = await file.arrayBuffer();
		const bytes = new Uint8Array(arrayBuf);
		let binary = '';
		for (let j = 0; j < bytes.length; j += 8192) {
			binary += String.fromCharCode(...bytes.subarray(j, j + 8192));
		}
		const base64 = btoa(binary);

		// Upload to server
		const result = await uploadOverlayImageCmd({ data: base64, filename: file.name });

		// Compute drop position as normalized 0-1
		let x = 0.5, y = 0.5;
		if (overlayContainerEl) {
			const rect = overlayContainerEl.getBoundingClientRect();
			x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
		}

		const id = nanoid(12);
		const entry: EffectEntry = {
			id,
			type: 'image',
			startTime: compositionTime,
			duration: 5,
			x,
			y,
			imageId: result.id,
			imageWidth: result.width,
			imageHeight: result.height,
			imageScale: 1,
			imageOpacity: 1,
		};
		effectEntries = [...effectEntries, entry];
		selectedEffectId = id;
	}

	async function handleAudioDrop(file: File) {
		const arrayBuf = await file.arrayBuffer();
		const bytes = new Uint8Array(arrayBuf);
		let binary = '';
		for (let j = 0; j < bytes.length; j += 8192) {
			binary += String.fromCharCode(...bytes.subarray(j, j + 8192));
		}
		const base64 = btoa(binary);

		const result = await uploadOverlayAudioCmd({ data: base64, filename: file.name });

		const id = nanoid(12);
		const entry: EffectEntry = {
			id,
			type: 'audio',
			startTime: compositionTime,
			duration: result.duration || 5,
			x: 0,
			y: 0,
			audioId: result.id,
			audioVolume: 1,
			audioDuration: result.duration || 0,
		};
		effectEntries = [...effectEntries, entry];
		selectedEffectId = id;
	}

	/** Apply an easing function to a linear progress value (0-1). */
	function applyEasing(p: number, easing: import('$lib/types').EasingFunction): number {
		switch (easing) {
			case 'linear': return p;
			case 'ease-in': return p * p;
			case 'ease-out': return 1 - (1 - p) * (1 - p);
			case 'ease-in-out': return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
			case 'bounce': return 1 + (1 - p) * (1 - p) * (2.5 * p - 1);
			default: return p;
		}
	}

	/** Compute inline CSS for overlay in/out animation based on current composition time.
	 *  Works for all overlay effect types. Pass centered=true for subtitle-style centering. */
	function overlayAnimStyle(entry: EffectEntry, t: number, centered = false): string {
		const animIn = entry.animIn ?? 'none';
		const animOut = entry.animOut ?? 'none';
		const dur = entry.animDuration ?? 0.3;
		const effectEnd = entry.startTime + entry.duration;
		const inEasing = entry.animInEasing ?? 'ease-out';
		const outEasing = entry.animOutEasing ?? 'ease-in';

		if (animIn === 'none' && animOut === 'none') {
			return centered ? 'transform: translateX(-50%)' : '';
		}

		let opacity = 1;
		let offsetX = 0; // px offset from base position
		let offsetY = 0;
		let scale = 1;

		// In-animation phase
		const inElapsed = t - entry.startTime;
		if (inElapsed < dur && animIn !== 'none') {
			const p = Math.max(0, Math.min(1, inElapsed / dur));
			const eased = applyEasing(p, inEasing);

			// All in-animations get a subtle fade
			opacity = eased;

			if (animIn === 'grow') {
				scale = 0.3 + 0.7 * eased;
			} else if (animIn === 'shrink') {
				scale = 1.7 - 0.7 * eased;
			} else if (animIn === 'slide-up') {
				offsetY = (1 - eased) * 25;
			} else if (animIn === 'slide-down') {
				offsetY = -(1 - eased) * 25;
			} else if (animIn === 'slide-left') {
				offsetX = (1 - eased) * 50;
			} else if (animIn === 'slide-right') {
				offsetX = -(1 - eased) * 50;
			}
		}

		// Out-animation phase
		const outElapsed = t - (effectEnd - dur);
		if (outElapsed > 0 && animOut !== 'none') {
			const p = Math.max(0, Math.min(1, outElapsed / dur));
			const eased = applyEasing(p, outEasing);

			// All out-animations get a subtle fade
			opacity *= (1 - eased);

			if (animOut === 'grow') {
				scale *= (1 + 0.7 * eased);
			} else if (animOut === 'shrink') {
				scale *= (1 - eased * 0.7);
			} else if (animOut === 'slide-up') {
				offsetY = -eased * 25;
			} else if (animOut === 'slide-down') {
				offsetY = eased * 25;
			} else if (animOut === 'slide-left') {
				offsetX = -eased * 50;
			} else if (animOut === 'slide-right') {
				offsetX = eased * 50;
			}
		}

		const parts: string[] = [];
		const baseX = centered ? '-50%' : '0';
		const tx = offsetX !== 0 ? `calc(${baseX} + ${offsetX.toFixed(1)}px)` : baseX;
		const ty = offsetY !== 0 ? `${offsetY.toFixed(1)}px` : '0';
		parts.push(`transform: translateX(${tx}) translateY(${ty}) scale(${scale.toFixed(3)})`);
		if (opacity < 1) parts.push(`opacity: ${opacity.toFixed(3)}`);
		return parts.join('; ');
	}

	function overlayShadowStyle(entry: EffectEntry): string {
		if (!entry.shadow) return '';
		const { color, blur, offsetX, offsetY } = entry.shadow;
		return `filter: drop-shadow(${offsetX}px ${offsetY}px ${blur}px ${color})`;
	}

	function removeEffectEntry(id: string) {
		effectEntries = effectEntries.filter((e) => e.id !== id);
		if (selectedEffectId === id) selectedEffectId = null;
	}

	function updateEffectEntry(id: string, updates: Partial<EffectEntry>) {
		effectEntries = effectEntries.map((e) => (e.id === id ? { ...e, ...updates } : e));
	}

	// Effects visible at current composition time (sorted by track: lower tracks first = rendered behind)
	let visibleEffects = $derived(
		effectEntries
			.filter((e) => e.type !== 'audio' && compositionTime >= e.startTime && compositionTime < e.startTime + e.duration)
			.sort((a, b) => (a.track ?? 0) - (b.track ?? 0))
	);

	// Effects track count: N+1 where N is the number of tracks that have any effects
	let effectTrackCount = $derived.by(() => {
		const usedTracks = new Set(effectEntries.map((e) => e.track ?? 0));
		return usedTracks.size + 1;
	});

	// Video track count: used tracks + 1 empty track
	let videoTrackCount = $derived.by(() => {
		const usedTracks = new Set(entries.map((e) => e.track ?? 0));
		usedTracks.add(0); // always show track 0
		return usedTracks.size + 1;
	});

	// --- Effect timeline drag state ---
	let effectDragMode = $state<'none' | 'move' | 'trim-start' | 'trim-end'>('none');
	let effectDragId = $state<string | null>(null);
	let effectDragStartX = $state(0);
	let effectDragStartY = $state(0);
	let effectDragStartTrack = $state(0);
	let effectDragStartValue = $state(0);
	let effectDragEndTime = $state(0); // end time at drag start (for trim-start)

	function handleEffectClick(e: MouseEvent, id: string) {
		e.stopPropagation();
		selectedEffectId = id;
		selectedIndex = null; // deselect clip
	}

	function handleEffectMoveStart(e: MouseEvent, id: string) {
		if ((e.target as HTMLElement).closest('.trim-handle')) return;
		e.stopPropagation();
		e.preventDefault();
		effectDragMode = 'move';
		effectDragId = id;
		effectDragStartX = e.clientX;
		effectDragStartY = e.clientY;
		const entry = effectEntries.find((ee) => ee.id === id);
		effectDragStartValue = entry?.startTime ?? 0;
		effectDragStartTrack = entry?.track ?? 0;
		selectedEffectId = id;
		selectedIndex = null;
		window.addEventListener('mousemove', handleEffectDragMove);
		window.addEventListener('mouseup', handleEffectDragEnd);
	}

	function handleEffectTrimStart(e: MouseEvent, id: string) {
		e.stopPropagation();
		e.preventDefault();
		effectDragMode = 'trim-start';
		effectDragId = id;
		effectDragStartX = e.clientX;
		const entry = effectEntries.find((ee) => ee.id === id);
		effectDragStartValue = entry?.startTime ?? 0;
		effectDragEndTime = (entry?.startTime ?? 0) + (entry?.duration ?? 5);
		window.addEventListener('mousemove', handleEffectDragMove);
		window.addEventListener('mouseup', handleEffectDragEnd);
	}

	function handleEffectTrimEnd(e: MouseEvent, id: string) {
		e.stopPropagation();
		e.preventDefault();
		effectDragMode = 'trim-end';
		effectDragId = id;
		effectDragStartX = e.clientX;
		const entry = effectEntries.find((ee) => ee.id === id);
		effectDragStartValue = entry?.duration ?? 5;
		window.addEventListener('mousemove', handleEffectDragMove);
		window.addEventListener('mouseup', handleEffectDragEnd);
	}

	function handleEffectDragMove(e: MouseEvent) {
		if (!effectDragId) return;
		const deltaSec = (e.clientX - effectDragStartX) / pixelsPerSecond;
		if (effectDragMode === 'move') {
			// Vertical: each track row is 30px; dragging up = higher track (rows go high→low)
			const deltaRows = Math.round((effectDragStartY - e.clientY) / 30);
			const newTrack = Math.max(0, effectDragStartTrack + deltaRows);
			updateEffectEntry(effectDragId, { startTime: Math.max(0, effectDragStartValue + deltaSec), track: newTrack });
		} else if (effectDragMode === 'trim-start') {
			const newStart = Math.max(0, effectDragStartValue + deltaSec);
			const newDur = effectDragEndTime - newStart;
			if (newDur >= 0.1) {
				updateEffectEntry(effectDragId, { startTime: newStart, duration: newDur });
			}
		} else if (effectDragMode === 'trim-end') {
			const newDur = Math.max(0.1, effectDragStartValue + deltaSec);
			updateEffectEntry(effectDragId, { duration: newDur });
		}
	}

	function handleEffectDragEnd() {
		effectDragMode = 'none';
		effectDragId = null;
		window.removeEventListener('mousemove', handleEffectDragMove);
		window.removeEventListener('mouseup', handleEffectDragEnd);
	}

	// --- Overlay drag (position on video) ---
	let overlayContainerEl = $state<HTMLDivElement | null>(null);

	function handleOverlayPointerDown(e: PointerEvent, id: string) {
		e.preventDefault();
		e.stopPropagation();
		draggingOverlay = id;
		const entry = effectEntries.find((ee) => ee.id === id);
		if (!entry || !overlayContainerEl) return;
		const rect = overlayContainerEl.getBoundingClientRect();
		dragOffset = {
			x: e.clientX - rect.left - entry.x * rect.width,
			y: e.clientY - rect.top - entry.y * rect.height
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function handleOverlayPointerMove(e: PointerEvent) {
		if (!draggingOverlay || !overlayContainerEl) return;
		const rect = overlayContainerEl.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (e.clientX - rect.left - dragOffset.x) / rect.width));
		const y = Math.max(0, Math.min(1, (e.clientY - rect.top - dragOffset.y) / rect.height));
		updateEffectEntry(draggingOverlay, { x, y });
	}

	function handleOverlayPointerUp() {
		draggingOverlay = null;
	}

	// --- Preview ---
	let previewVideoEl = $state<HTMLVideoElement | null>(null);
	let previewPlayerAreaEl = $state<HTMLDivElement | null>(null);
	let previewHls: Hls | null = null;
	let previewPlaying = $state(false);
	let previewPlaybackRate = $state(1);
	let previewProgress = $state(0);
	let previewCurrentTime = $state('0:00');

	// Audio effect preview playback
	let audioPreviewEls = new Map<string, HTMLAudioElement>();

	function syncAudioEffects() {
		const ct = compositionTime;
		for (const entry of effectEntries) {
			if (entry.type !== 'audio' || !entry.audioId) continue;
			const end = entry.startTime + entry.duration;
			const isActive = ct >= entry.startTime && ct < end;
			let el = audioPreviewEls.get(entry.id);

			if (isActive && previewPlaying) {
				if (!el) {
					el = new Audio(`/api/overlay-audio/${entry.audioId}`);
					el.volume = entry.audioVolume ?? 1;
					audioPreviewEls.set(entry.id, el);
				}
				el.volume = entry.audioVolume ?? 1;
				el.playbackRate = previewPlaybackRate;
				const targetTime = (ct - entry.startTime) + (entry.audioOffset ?? 0);
				if (Math.abs(el.currentTime - targetTime) > 0.3) {
					el.currentTime = targetTime;
				}
				if (el.paused) el.play().catch(() => {});
			} else if (el) {
				if (!el.paused) el.pause();
				if (!isActive) {
					audioPreviewEls.delete(entry.id);
				}
			}
		}
		// Clean up elements for removed effects
		for (const [id, el] of audioPreviewEls) {
			if (!effectEntries.some(e => e.id === id)) {
				el.pause();
				audioPreviewEls.delete(id);
			}
		}
	}

	function pauseAllAudioEffects() {
		for (const el of audioPreviewEls.values()) {
			el.pause();
		}
	}

	// Track the video's actual rendered bounds within the player area (object-fit: contain)
	let videoBounds = $state({ left: 0, top: 0, width: 0, height: 0 });
	// Source video dimensions — updated alongside videoBounds so they stay in sync
	let sourceVideoSize = $state({ w: 1920, h: 1080 });
	let videoScale = $derived(videoBounds.width > 0 ? videoBounds.width / sourceVideoSize.w : 1);

	function updateVideoBounds() {
		const container = previewPlayerAreaEl;
		if (!container) return;
		const rect = container.getBoundingClientRect();

		// Virtual 9:16 AR for vertical preview
		const vw = 1080;
		const vh = 1920;
		const containerAR = rect.width / rect.height;
		const videoAR = vw / vh;
		let renderW: number, renderH: number, renderX: number, renderY: number;
		if (videoAR > containerAR) {
			renderW = rect.width;
			renderH = rect.width / videoAR;
			renderX = 0;
			renderY = (rect.height - renderH) / 2;
		} else {
			renderH = rect.height;
			renderW = rect.height * videoAR;
			renderX = (rect.width - renderW) / 2;
			renderY = 0;
		}
		videoBounds = { left: renderX, top: renderY, width: renderW, height: renderH };
		sourceVideoSize = { w: vw, h: vh };
	}

	// Keep video bounds updated on resize
	$effect(() => {
		const container = previewPlayerAreaEl;
		const video = previewVideoEl;
		if (!container || !video) return;
		const ro = new ResizeObserver(() => updateVideoBounds());
		ro.observe(container);
		const onMeta = () => updateVideoBounds();
		video.addEventListener('loadedmetadata', onMeta);
		video.addEventListener('resize', onMeta);
		updateVideoBounds();
		return () => {
			ro.disconnect();
			video.removeEventListener('loadedmetadata', onMeta);
			video.removeEventListener('resize', onMeta);
		};
	});
	let isSeeking = $state(false);
	let currentPreviewIndex = $state(0);
	let previewReady = $state(false);

	// --- Chat panel derived state ---
	let currentClipRegion = $derived(
		entries[currentPreviewIndex] ? resolveClip(entries[currentPreviewIndex].clipId) ?? null : null
	);
	let currentClipBounds = $derived(
		currentClipRegion ? clipBounds(currentClipRegion) : null
	);
	let chatLocalTime = $state(0);

	function handleChatSeek(localTime: number) {
		if (previewVideoEl) previewVideoEl.currentTime = localTime;
	}

	// --- Waveform + transcription (per-clip) ---
	const WAVEFORM_BINS = 2000;
	let waveformActive = false;
	let rafId: number | null = null;
	let clipProgress = $state(0);
	let clipDurationText = $state('0:00');
	let clipDurationSec = $state(0);
	let transcriptionRegions = $state<Array<{ startFrac: number; endFrac: number; text: string }>>([]);

	let clipCurrentTimeText = $derived(formatDuration(clipProgress * clipDurationSec));

	// --- Per-clip waveform cache for timeline overlay ---
	let clipWaveformCache = $state<Map<string, Float32Array>>(new Map());
	let clipWaveformAborts = new Map<string, AbortController>();

	function fetchClipWaveform(entry: ClipEntry, clip: ClipRegion) {
		const cacheKey = `${clip.id}:${entry.trimStart || 0}:${entry.trimEnd || 0}`;
		if (clipWaveformCache.has(cacheKey)) return;
		if (clipWaveformAborts.has(cacheKey)) return;

		const tb = trimmedBounds(entry, clip);
		if (!tb) return;
		const { trimmedStart, trimmedEnd } = tb;

		const abort = new AbortController();
		clipWaveformAborts.set(cacheKey, abort);

		fetch(`/api/waveform/${clip.streamId}?start=${trimmedStart.toFixed(3)}&end=${trimmedEnd.toFixed(3)}`, {
			signal: abort.signal
		})
			.then((r) => {
				if (!r.ok) throw new Error(r.statusText);
				return r.arrayBuffer();
			})
			.then((buf) => {
				if (abort.signal.aborted) return;
				const samples = new Int16Array(buf);
				const bins = WAVEFORM_BINS;
				const samplesPerBin = Math.max(1, Math.floor(samples.length / bins));
				const peaks = new Float32Array(bins);
				for (let bin = 0; bin < bins; bin++) {
					const start = bin * samplesPerBin;
					const end = Math.min(start + samplesPerBin, samples.length);
					let sum = 0;
					for (let i = start; i < end; i++) {
						const s = samples[i] / 32768;
						sum += s * s;
					}
					peaks[bin] = Math.sqrt(sum / (end - start));
				}
				clipWaveformCache = new Map(clipWaveformCache).set(cacheKey, peaks);
			})
			.catch(() => {})
			.finally(() => {
				clipWaveformAborts.delete(cacheKey);
			});
	}

	function getClipWaveformKey(entry: ClipEntry, clip: ClipRegion): string {
		return `${clip.id}:${entry.trimStart || 0}:${entry.trimEnd || 0}`;
	}

	function drawClipWaveformCanvas(canvas: HTMLCanvasElement, peaks: Float32Array, progress: number, color: string) {
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const rect = canvas.getBoundingClientRect();
		const w = rect.width;
		const h = rect.height;
		if (w === 0 || h === 0) return;
		const pw = Math.round(w * dpr);
		const ph = Math.round(h * dpr);

		if (canvas.width !== pw || canvas.height !== ph) {
			canvas.width = pw;
			canvas.height = ph;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		let maxPeak = 0;
		for (let i = 0; i < peaks.length; i++) {
			if (peaks[i] > maxPeak) maxPeak = peaks[i];
		}
		if (maxPeak < 0.001) maxPeak = 1;

		const barW = w / peaks.length;

		// Draw bars (peaks upward from bottom)
		for (let i = 0; i < peaks.length; i++) {
			const amp = peaks[i] / maxPeak;
			const barH = Math.max(0.5, amp * (h - 2));
			const x = i * barW;
			const frac = x / w;
			if (frac < progress) {
				ctx.fillStyle = '#fff';
				ctx.globalAlpha = 0.6;
			} else {
				ctx.fillStyle = '#fff';
				ctx.globalAlpha = 0.25;
			}
			ctx.fillRect(x, h - barH, Math.max(barW - 0.5, 0.5), barH);
		}
		ctx.globalAlpha = 1;
	}

	// Fetch waveforms for all clips in all tracks
	$effect(() => {
		for (const [, layout] of trackLayouts) {
			for (const cl of layout) {
				if (!cl.clip) continue;
				fetchClipWaveform(cl.entry, cl.clip);
			}
		}
	});

	// Map of clip-block canvas elements for drawing
	let clipCanvasMap = new Map<number, HTMLCanvasElement>();

	function clipWaveformAction(el: HTMLCanvasElement, index: () => number) {
		clipCanvasMap.set(index(), el);
		return {
			update() { clipCanvasMap.set(index(), el); },
			destroy() { clipCanvasMap.delete(index()); }
		};
	}

	// Redraw all clip waveforms on changes
	$effect(() => {
		// Re-read dependencies
		void trackLayouts;
		void clipWaveformCache;
		void compositionTime;
		// Schedule a draw on next frame
		requestAnimationFrame(() => {
			for (const [, layout] of trackLayouts) {
				for (const cl of layout) {
				const canvas = clipCanvasMap.get(cl.index);
				if (!canvas || !cl.clip) continue;
				const key = getClipWaveformKey(cl.entry, cl.clip);
				const peaks = clipWaveformCache.get(key);
				if (!peaks) continue;
				// Compute per-clip progress
				let progress = 0;
				if (compositionTime >= cl.startOffset + cl.effectiveDuration) {
					progress = 1;
				} else if (compositionTime > cl.startOffset) {
					progress = (compositionTime - cl.startOffset) / cl.effectiveDuration;
				}
				drawClipWaveformCanvas(canvas, peaks, progress, cl.color);
				}
			}
		});
	});

	/** Trimmed local bounds for a clip entry — accounts for trimStart/trimEnd. */
	function trimmedBounds(entry: ClipEntry, clip: ClipRegion) {
		const bounds = clipBounds(clip);
		if (!bounds) return null;
		const trimmedStart = bounds.localStart + (entry.trimStart || 0);
		const trimmedEnd = bounds.localEnd - (entry.trimEnd || 0);
		const trimmedDur = trimmedEnd - trimmedStart;
		if (trimmedDur <= 0) return null;
		return { trimmedStart, trimmedEnd, trimmedDur };
	}

	function clipBounds(clip: ClipRegion) {
		return getClipLocalBounds(clip, streamMap.get(clip.streamId), $syncOffsets[clip.streamId] || 0);
	}

	// Auto-initialize preview on load
	// Guard: also wait for streamMap to have the first clip's stream data.
	// On direct page load, refreshStreams() in the layout may not have completed yet
	// when `initialized` becomes true, so streamMap would be empty and loadPreviewClip
	// would silently fail. By reading streamMap.size here, the effect re-runs when
	// streams arrive.
	$effect(() => {
		if (initialized && entries.length > 0 && previewVideoEl && !previewReady) {
			// Ensure the first clip's stream is available
			const firstClip = resolveClip(entries[0].clipId);
			if (!firstClip || !streamMap.get(firstClip.streamId)) return;
			previewReady = true;
			loadPreviewClip(0, false);
		}
	});

	function stopWaveformScan() {
		for (const abort of clipWaveformAborts.values()) abort.abort();
		clipWaveformAborts.clear();
	}

	function waveformLoop() {
		rafId = null;
		if (!waveformActive) return;
		if (!isSeeking && previewVideoEl && entries.length > 0) {
			const entry = entries[currentPreviewIndex];
			const clip = entry ? resolveClip(entry.clipId) : undefined;
			if (entry && clip) {
				const tb = trimmedBounds(entry, clip);
				if (tb) {
					const elapsed = previewVideoEl.currentTime - tb.trimmedStart;
					clipProgress = tb.trimmedDur > 0 ? Math.max(0, Math.min(1, elapsed / tb.trimmedDur)) : 0;
					const layoutEntry = clipLayout[currentPreviewIndex];
					if (layoutEntry) {
						compositionTime = layoutEntry.startOffset + Math.max(0, elapsed);
						previewCurrentTime = formatDuration(compositionTime);
					}
				}
			}
		}
		if (previewPlaying) {
			rafId = requestAnimationFrame(waveformLoop);
		}
	}

	function startWaveformLoop() {
		if (rafId != null) return;
		rafId = requestAnimationFrame(waveformLoop);
	}

	function loadPreviewClip(index: number, autoPlay = true) {
		if (index < 0 || index >= entries.length) return;
		currentPreviewIndex = index;
		const entry = entries[index];
		const clip = resolveClip(entry.clipId);
		if (!clip || !previewVideoEl) return;
		const stream = streamMap.get(clip.streamId);
		if (!stream) return;

		if (previewHls) { previewHls.destroy(); previewHls = null; }

		const url = `/hls/${clip.streamId}/playlist.m3u8`;
		const offset = $syncOffsets[clip.streamId] || 0;
		const anchor = stream.startedAt / 1000;
		const localStart = clip.startTime - anchor + offset + (entry.trimStart || 0);

		previewHls = setupHls(Hls, previewVideoEl, url, localStart, () => {
			previewVideoEl!.playbackRate = previewPlaybackRate;
			if (autoPlay) {
				previewVideoEl!.play().then(() => { previewPlaying = true; startWaveformLoop(); }).catch(() => {});
			}
		});
	}

	function handlePreviewTimeUpdate() {
		if (!previewVideoEl || entries.length === 0) return;
		chatLocalTime = previewVideoEl.currentTime;
		const entry = entries[currentPreviewIndex];
		if (!entry) return;
		const clip = resolveClip(entry.clipId);
		if (!clip) return;
		const bounds = clipBounds(clip);
		if (!bounds) return;
		const { localStart, localEnd } = bounds;
		const trimmedStart = localStart + (entry.trimStart || 0);
		const trimmedEnd = localEnd - (entry.trimEnd || 0);

		const trimmedDur = trimmedEnd - trimmedStart;

		if (previewVideoEl.currentTime >= trimmedEnd) {
			if (currentPreviewIndex < entries.length - 1) {
				loadPreviewClip(currentPreviewIndex + 1);
			} else {
				previewVideoEl.pause();
				previewPlaying = false;
				pauseAllAudioEffects();
				previewProgress = 1;
				previewCurrentTime = formatDuration(totalDuration);
				compositionTime = totalDuration;
				clipProgress = 1;
			}
		} else if (!isSeeking) {
			// elapsed within the trimmed region of this clip
			const elapsed = previewVideoEl.currentTime - trimmedStart;
			clipProgress = trimmedDur > 0 ? Math.max(0, Math.min(1, elapsed / trimmedDur)) : 0;
			// Sync composition time for playhead
			const layoutEntry = clipLayout[currentPreviewIndex];
			if (layoutEntry) {
				compositionTime = layoutEntry.startOffset + Math.max(0, elapsed);
			}
			previewProgress = totalDuration > 0 ? Math.max(0, Math.min(1, compositionTime / totalDuration)) : 0;
			previewCurrentTime = formatDuration(compositionTime);
		}
		syncAudioEffects();
		syncOtherTrackVideos();
	}

	function seekToCompositionTime(targetTime: number) {
		if (!previewVideoEl || entries.length === 0) return;
		compositionTime = Math.max(0, Math.min(targetTime, totalDuration));

		// Find which clip contains this composition time
		let accumulated = 0;
		let targetIndex = 0;
		let offsetInClip = 0;
		for (let i = 0; i < clipLayout.length; i++) {
			const cl = clipLayout[i];
			if (accumulated + cl.effectiveDuration > compositionTime) {
				targetIndex = i;
				offsetInClip = compositionTime - accumulated;
				break;
			}
			accumulated += cl.effectiveDuration;
			if (i === clipLayout.length - 1) {
				targetIndex = i;
				offsetInClip = cl.effectiveDuration;
			}
		}

		const entry = entries[targetIndex];
		const clip = resolveClip(entry?.clipId ?? '');
		if (!clip) return;

		if (targetIndex !== currentPreviewIndex) {
			currentPreviewIndex = targetIndex;
			const stream = streamMap.get(clip.streamId);
			if (!stream) return;
			if (previewHls) { previewHls.destroy(); previewHls = null; }
			const url = `/hls/${clip.streamId}/playlist.m3u8`;
			const offset = $syncOffsets[clip.streamId] || 0;
			const anchor = stream.startedAt / 1000;
			const localStart = clip.startTime - anchor + offset + (entry.trimStart || 0) + offsetInClip;
			previewHls = setupHls(Hls, previewVideoEl, url, localStart, () => {
				previewVideoEl!.playbackRate = previewPlaybackRate;
				if (previewPlaying) previewVideoEl!.play().catch(() => {});
			});
		} else {
			const bounds = clipBounds(clip);
			if (bounds) {
				previewVideoEl.currentTime = bounds.localStart + (entry.trimStart || 0) + offsetInClip;
			}
		}
		syncOtherTrackVideos();
	}

	function togglePreviewPlay() {
		if (!previewVideoEl) return;
		if (previewPlaying) {
			previewVideoEl.pause();
			pauseAllAudioEffects();
		} else {
			if (compositionTime >= totalDuration && entries.length > 0) {
				compositionTime = 0;
				previewCurrentTime = '0:00';
				clipProgress = 0;
				loadPreviewClip(0);
				return;
			}
			previewVideoEl.play().catch(() => {});
			startWaveformLoop();
		}
		previewPlaying = !previewPlaying;
		syncOtherTrackVideos();
	}

	function setPreviewRate(rate: number) {
		previewPlaybackRate = Math.max(0.25, Math.min(4, rate));
		if (previewVideoEl) previewVideoEl.playbackRate = previewPlaybackRate;
		syncOtherTrackVideos();
	}

	// Clip-change detection: update clipDurationText, fetch transcription.
	let prevWaveformKey = '';
	$effect(() => {
		const idx = currentPreviewIndex;
		const entry = entries[idx];
		const clip = entry ? resolveClip(entry.clipId) : undefined;
		const stream = clip ? streamMap.get(clip.streamId) : undefined;
		const key = `${idx}:${clip?.id ?? ''}:${stream?.id ?? ''}`;
		if (key === prevWaveformKey) return;
		prevWaveformKey = key;

		clipProgress = 0;
		transcriptionRegions = [];

		if (!entry || !clip) {
			clipDurationText = '0:00';
			clipDurationSec = 0;
			return;
		}

		const tb = untrack(() => trimmedBounds(entry, clip));
		if (!tb) {
			clipDurationText = '0:00';
			clipDurationSec = 0;
			return;
		}
		clipDurationSec = tb.trimmedDur;
		clipDurationText = formatDuration(clipDurationSec);

		// Fetch transcription for trimmed range
		getMultiStreamTranscriptions({ ranges: [{ streamId: clip.streamId, from: tb.trimmedStart, to: tb.trimmedEnd }] })
			.then((segments) => {
				transcriptionRegions = segments.map((e) => ({
					startFrac: Math.max(0, (e.startTime - tb.trimmedStart) / tb.trimmedDur),
					endFrac: Math.min(1, (e.endTime - tb.trimmedStart) / tb.trimmedDur),
					text: e.text
				}));
			})
			.catch(() => {
				transcriptionRegions = [];
			});
	});

	// Waveform loop lifecycle
	$effect(() => {
		waveformActive = true;
		if (previewPlaying) startWaveformLoop();
		return () => {
			waveformActive = false;
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
		};
	});

	// Cleanup
	$effect(() => {
		return () => {
			if (previewHls) { previewHls.destroy(); previewHls = null; }
			if (saveTimer) clearTimeout(saveTimer);
			waveformActive = false;
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (verticalRafId != null) {
				cancelAnimationFrame(verticalRafId);
				verticalRafId = null;
			}
			stopWaveformScan();
		};
	});

	// --- Other-track video sources for multi-track preview ---
	interface OtherTrackSource {
		el: HTMLVideoElement;
		hls: Hls | null;
		clipId: string;
		streamId: string;
		track: number;
		trimmedLocalStart: number;
		trimmedLocalEnd: number;
		compStart: number;
	}
	let otherTrackSources = new Map<string, OtherTrackSource>();

	// Derive other-track clip entries (stable reference for effect diffing)
	let otherTrackEntryKeys = $derived(
		entries
			.filter((e) => (e.track ?? 0) !== 0)
			.map((e) => `${e.clipId}:${e.track}:${e.trimStart ?? 0}:${e.trimEnd ?? 0}:${e.startTime ?? 0}`)
			.join('|')
	);

	// Manage HLS instances for other-track clips
	$effect(() => {
		void otherTrackEntryKeys; // depend on entries changes
		const otherEntries = entries.filter((e) => (e.track ?? 0) !== 0);
		const neededIds = new Set(otherEntries.map((e) => e.clipId));

		// Remove sources for clips no longer in entries
		for (const [clipId, src] of otherTrackSources) {
			if (!neededIds.has(clipId)) {
				if (src.hls) src.hls.destroy();
				src.el.remove();
				otherTrackSources.delete(clipId);
			}
		}

		// Create sources for new clips
		for (const entry of otherEntries) {
			if (otherTrackSources.has(entry.clipId)) continue;
			const clip = resolveClip(entry.clipId);
			if (!clip) continue;
			const bounds = clipBounds(clip);
			if (!bounds) continue;

			const el = document.createElement('video');
			el.muted = true;
			el.playsInline = true;
			el.style.display = 'none';
			document.body.appendChild(el);

			const trimmedLocalStart = bounds.localStart + (entry.trimStart || 0);
			const trimmedLocalEnd = bounds.localEnd - (entry.trimEnd || 0);
			const url = `/hls/${clip.streamId}/playlist.m3u8`;
			const hls = setupHls(Hls, el, url, trimmedLocalStart, () => {});

			otherTrackSources.set(entry.clipId, {
				el, hls,
				clipId: entry.clipId,
				streamId: clip.streamId,
				track: entry.track ?? 1,
				trimmedLocalStart,
				trimmedLocalEnd,
				compStart: entry.startTime ?? 0,
			});
		}

		return () => {
			for (const [, src] of otherTrackSources) {
				if (src.hls) src.hls.destroy();
				src.el.remove();
			}
			otherTrackSources.clear();
		};
	});

	/**
	 * Get the video element for a given track at the current composition time.
	 * For track 0, returns the main preview video. For other tracks, finds the
	 * matching other-track source and returns it (even mid-seek — drawImage
	 * will use the last decoded frame, which is better than flashing black).
	 */
	function getTrackVideoEl(track: number): HTMLVideoElement | null {
		if (track === 0) return previewVideoEl;

		// Find the active clip on this track at compositionTime
		for (const entry of entries) {
			if ((entry.track ?? 0) !== track) continue;
			const clip = resolveClip(entry.clipId);
			if (!clip) continue;
			const dur = clipDuration(clip, entry);
			const start = entry.startTime ?? 0;
			if (compositionTime < start || compositionTime >= start + dur) continue;

			const src = otherTrackSources.get(entry.clipId);
			if (!src) continue;

			// Return element if it has ever loaded a frame (videoWidth > 0).
			// Don't gate on readyState — during seeks it temporarily drops,
			// but drawImage still uses the last decoded frame.
			return src.el.videoWidth > 0 ? src.el : null;
		}
		return null;
	}

	/**
	 * Sync all other-track video elements to the current composition time.
	 * Called on seek and during playback to keep frames aligned.
	 */
	function syncOtherTrackVideos() {
		for (const entry of entries) {
			if ((entry.track ?? 0) === 0) continue;
			const src = otherTrackSources.get(entry.clipId);
			if (!src) continue;

			const dur = clipDuration(resolveClip(entry.clipId)!, entry);
			const start = entry.startTime ?? 0;
			if (compositionTime < start || compositionTime >= start + dur) {
				// Outside this clip's range — pause if playing
				if (!src.el.paused) src.el.pause();
				continue;
			}

			const compOffset = compositionTime - start;
			const localTime = src.trimmedLocalStart + compOffset;

			// Set playback rate to match preview rate
			if (src.el.playbackRate !== previewPlaybackRate) src.el.playbackRate = previewPlaybackRate;

			// Only seek if drifted beyond threshold (avoids constant seek jank)
			if (Math.abs(src.el.currentTime - localTime) > 0.3) {
				src.el.currentTime = localTime;
			}

			// Match play/pause state with main preview
			if (previewPlaying && src.el.paused) {
				src.el.play().catch(() => {});
			} else if (!previewPlaying && !src.el.paused) {
				src.el.pause();
			}
		}
	}

	// --- Resolve camera bounds for current clip (needed by view effects with camera source) ---
	$effect(() => {
		const hasCameraView = effectEntries.some((e) => e.type === 'view' && e.viewSourceType === 'camera');
		if (!hasCameraView) { currentCamBounds = null; return; }
		const clip = currentClipRegion;
		if (!clip) return;
		const stream = streamMap.get(clip.streamId);
		if (!stream) return;
		getCameraBounds(stream.channel, clip.startTime).then(b => { currentCamBounds = b; });
	});

	// --- Vertical preview: canvas render loop ---
	function verticalCoverDraw(
		ctx: CanvasRenderingContext2D,
		video: HTMLVideoElement,
		srcX: number, srcY: number, srcW: number, srcH: number,
		dstX: number, dstY: number, dstW: number, dstH: number
	) {
		// Cover-fit: scale source to fill destination, center-crop
		const scale = Math.max(dstW / srcW, dstH / srcH);
		const cropW = dstW / scale;
		const cropH = dstH / scale;
		const cropX = srcX + (srcW - cropW) / 2;
		const cropY = srcY + (srcH - cropH) / 2;
		ctx.drawImage(video, cropX, cropY, cropW, cropH, dstX, dstY, dstW, dstH);
	}

	function drawViewFrame() {
		const canvas = verticalCanvasEl;
		const video = previewVideoEl;
		if (!canvas || !video || !video.videoWidth || !video.videoHeight) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const vw = video.videoWidth;
		const vh = video.videoHeight;
		const cw = canvas.width;
		const ch = canvas.height;

		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, cw, ch);

		const t = compositionTime;
		// Get active view effects at current time, sorted by z-order.
		const activeViews = effectEntries
			.filter((e) => e.type === 'view' && t >= e.startTime && t < e.startTime + e.duration)
			.sort((a, b) => (a.viewZOrder ?? 0) - (b.viewZOrder ?? 0));

		if (activeViews.length === 0) {
			// No views — draw the full source frame (passthrough)
			verticalCoverDraw(ctx, video, 0, 0, vw, vh, 0, 0, cw, ch);
			return;
		}

		for (const view of activeViews) {
			// Resolve video source for this view's track
			const trackEl = getTrackVideoEl(view.viewSourceTrack ?? 0);
			if (!trackEl || !trackEl.videoWidth || !trackEl.videoHeight) continue; // skip — no video data yet

			const tvw = trackEl.videoWidth;
			const tvh = trackEl.videoHeight;
			const progress = Math.max(0, Math.min(1, (t - view.startTime) / Math.max(0.001, view.duration)));

			// Resolve source region
			let srcX: number, srcY: number, srcW: number, srcH: number;
			if (view.viewSourceType === 'camera' && currentCamBounds) {
				srcX = currentCamBounds.camX * tvw;
				srcY = currentCamBounds.camY * tvh;
				srcW = currentCamBounds.camW * tvw;
				srcH = currentCamBounds.camH * tvh;
			} else if (view.viewSourceType === 'full') {
				srcX = 0; srcY = 0; srcW = tvw; srcH = tvh;
			} else {
				// Custom/animated source
				const sx = (view.viewSourceStartX ?? 0) + ((view.viewSourceEndX ?? view.viewSourceStartX ?? 0) - (view.viewSourceStartX ?? 0)) * progress;
				const sy = (view.viewSourceStartY ?? 0) + ((view.viewSourceEndY ?? view.viewSourceStartY ?? 0) - (view.viewSourceStartY ?? 0)) * progress;
				const sw = (view.viewSourceStartW ?? 1) + ((view.viewSourceEndW ?? view.viewSourceStartW ?? 1) - (view.viewSourceStartW ?? 1)) * progress;
				const sh = (view.viewSourceStartH ?? 1) + ((view.viewSourceEndH ?? view.viewSourceStartH ?? 1) - (view.viewSourceStartH ?? 1)) * progress;
				srcX = sx * tvw; srcY = sy * tvh; srcW = sw * tvw; srcH = sh * tvh;
			}

			// Resolve dest rect (scaled to canvas)
			const dstX = (view.viewDestX ?? 0) * cw;
			const dstY = (view.viewDestY ?? 0) * ch;
			const dstW = (view.viewDestW ?? 1) * cw;
			const dstH = (view.viewDestH ?? 1) * ch;

			verticalCoverDraw(ctx, trackEl, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
		}
	}

	function viewRenderLoop() {
		drawViewFrame();
		verticalRafId = requestAnimationFrame(viewRenderLoop);
	}

	// Start/stop canvas render loop for vertical preview
	$effect(() => {
		if (!verticalCanvasEl || !previewVideoEl) {
			if (verticalRafId != null) { cancelAnimationFrame(verticalRafId); verticalRafId = null; }
			return;
		}
		// Wait for video data
		const startLoop = () => {
			if (verticalRafId != null) return;
			verticalRafId = requestAnimationFrame(viewRenderLoop);
		};
		if (previewVideoEl.videoWidth) {
			startLoop();
		}
		previewVideoEl.addEventListener('loadeddata', startLoop);
		return () => {
			previewVideoEl!.removeEventListener('loadeddata', startLoop);
			if (verticalRafId != null) { cancelAnimationFrame(verticalRafId); verticalRafId = null; }
		};
	});

	// --- Export ---
	let exporting = $state(false);
	let exportResult = $state<{ success: boolean; message: string } | null>(null);

	async function handleExport() {
		if (!video) return;
		exporting = true;
		exportResult = null;
		try {
			const result = await exportVideoFromVideoCmd({ videoId: video.id });
			exportResult = { success: true, message: `Export queued (ID: ${result.exportId})` };
		} catch (err) {
			exportResult = { success: false, message: err instanceof Error ? err.message : 'Failed' };
		} finally {
			exporting = false;
		}
	}

	// --- Delete ---
	async function handleDeleteVideo() {
		if (!video || !confirm('Delete this video? This cannot be undone.')) return;
		try {
			await deleteVideoCmd({ id: video.id });
			goto('/videos');
		} catch (err) {
			console.error('Failed to delete video:', err);
		}
	}

	// --- Timeline interactions ---

	// Click-to-seek on timeline background
	function handleTimelineClick(e: MouseEvent) {
		if (e.button !== 0 || dragMode !== 'none') return;
		if (!scrollAreaEl) return;
		// Don't seek if we clicked a clip block
		if ((e.target as HTMLElement).closest('.clip-block, .trim-handle')) return;
		const rect = scrollAreaEl.getBoundingClientRect();
		const x = e.clientX - rect.left + scrollAreaEl.scrollLeft;
		const time = x / pixelsPerSecond;
		seekToCompositionTime(time);
	}

	// Click-to-select clip
	function handleClipClick(e: MouseEvent, index: number) {
		e.stopPropagation();
		selectedIndex = index;
	}

	// --- Drag-edge trim ---
	function handleTrimStart(e: MouseEvent, index: number) {
		e.stopPropagation();
		e.preventDefault();
		dragMode = 'trim-start';
		dragEntryIndex = index;
		dragStartX = e.clientX;
		dragStartValue = entries[index].trimStart ?? 0;
		window.addEventListener('mousemove', handleDragMove);
		window.addEventListener('mouseup', handleDragEnd);
	}

	function handleTrimEnd(e: MouseEvent, index: number) {
		e.stopPropagation();
		e.preventDefault();
		dragMode = 'trim-end';
		dragEntryIndex = index;
		dragStartX = e.clientX;
		dragStartValue = entries[index].trimEnd ?? 0;
		window.addEventListener('mousemove', handleDragMove);
		window.addEventListener('mouseup', handleDragEnd);
	}

	// --- Drag-to-reorder / move between tracks ---
	function handleReorderStart(e: MouseEvent, index: number) {
		// Only start reorder if not on a trim handle
		if ((e.target as HTMLElement).closest('.trim-handle')) return;
		e.stopPropagation();
		e.preventDefault();
		const entry = entries[index];
		const track = entry.track ?? 0;
		dragMode = track === 0 ? 'reorder' : 'move-track';
		dragEntryIndex = index;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		dragStartValue = entry.startTime ?? 0;
		dragStartTrack = track;
		dragInsertIndex = null;
		dragPreviewDelta = 0;
		selectedIndex = index;
		window.addEventListener('mousemove', handleDragMove);
		window.addEventListener('mouseup', handleDragEnd);
	}

	function handleDragMove(e: MouseEvent) {
		if (dragEntryIndex === null) return;
		const deltaX = e.clientX - dragStartX;

		if (dragMode === 'trim-start') {
			const deltaSec = deltaX / pixelsPerSecond;
			const clip = resolveClip(entries[dragEntryIndex].clipId);
			if (!clip) return;
			const maxTrim = clipRawDuration(clip) - (entries[dragEntryIndex].trimEnd ?? 0) - 0.1;
			const newTrim = Math.max(0, Math.min(maxTrim, dragStartValue + deltaSec));
			updateEntry(dragEntryIndex, { trimStart: newTrim > 0.01 ? newTrim : undefined });
		} else if (dragMode === 'trim-end') {
			const deltaSec = -deltaX / pixelsPerSecond;
			const clip = resolveClip(entries[dragEntryIndex].clipId);
			if (!clip) return;
			const maxTrim = clipRawDuration(clip) - (entries[dragEntryIndex].trimStart ?? 0) - 0.1;
			const newTrim = Math.max(0, Math.min(maxTrim, dragStartValue + deltaSec));
			updateEntry(dragEntryIndex, { trimEnd: newTrim > 0.01 ? newTrim : undefined });
		} else if (dragMode === 'reorder') {
			dragPreviewDelta = deltaX;
			// Check vertical movement — dragging up from track 0 moves to higher tracks
			const deltaRows = Math.round((dragStartY - e.clientY) / 64);
			if (deltaRows > 0 && dragEntryIndex !== null) {
				// Convert reorder to move-track: assign track and startTime
				const cl = clipLayout.find((c) => c.index === dragEntryIndex);
				const newStartTime = cl ? cl.startOffset : 0;
				const newTrack = Math.max(1, deltaRows);
				updateEntry(dragEntryIndex, { track: newTrack, startTime: newStartTime });
				dragMode = 'move-track';
				dragStartTrack = newTrack;
				dragStartValue = newStartTime;
				return;
			}
			// Compute insert position from cursor X
			if (!scrollAreaEl) return;
			const rect = scrollAreaEl.getBoundingClientRect();
			const x = e.clientX - rect.left + scrollAreaEl.scrollLeft;
			const cursorTime = x / pixelsPerSecond;

			// Find insert position based on clip midpoints
			let insertIdx = clipLayout.length;
			for (let i = 0; i < clipLayout.length; i++) {
				if (i === dragEntryIndex) continue;
				const midpoint = clipLayout[i].startOffset + clipLayout[i].effectiveDuration / 2;
				if (cursorTime < midpoint) {
					insertIdx = i;
					break;
				}
			}
			dragInsertIndex = insertIdx;
		} else if (dragMode === 'move-track') {
			// Horizontal: change startTime; Vertical: change track
			const deltaSec = deltaX / pixelsPerSecond;
			const deltaRows = Math.round((dragStartY - e.clientY) / 64);
			const newTrack = Math.max(0, dragStartTrack + deltaRows);
			const newStartTime = Math.max(0, dragStartValue + deltaSec);
			if (dragEntryIndex === null) return;
			if (newTrack === 0) {
				// Moving back to track 0 — remove startTime, become sequential
				updateEntry(dragEntryIndex, { track: undefined, startTime: undefined });
				dragMode = 'reorder';
			} else {
				updateEntry(dragEntryIndex, { track: newTrack, startTime: newStartTime });
			}
		}
	}

	function handleDragEnd() {
		if (dragMode === 'reorder' && dragEntryIndex !== null && dragInsertIndex !== null) {
			const fromIdx = dragEntryIndex;
			let toIdx = dragInsertIndex;
			if (fromIdx !== toIdx && toIdx !== fromIdx + 1) {
				const newEntries = [...entries];
				const [moved] = newEntries.splice(fromIdx, 1);
				if (toIdx > fromIdx) toIdx--;
				newEntries.splice(toIdx, 0, moved);
				entries = newEntries;
				selectedIndex = toIdx;
			}
		}
		dragMode = 'none';
		dragEntryIndex = null;
		dragInsertIndex = null;
		dragPreviewDelta = 0;
		window.removeEventListener('mousemove', handleDragMove);
		window.removeEventListener('mouseup', handleDragEnd);
	}

	// --- Zoom/Pan ---
	function handleWheel(e: WheelEvent) {
		const newPps = handleTimelineWheel(
			e,
			scrollAreaEl,
			pixelsPerSecond,
			0, // timelineStart is 0 for composition timeline
			MIN_PPS,
			MAX_PPS,
			() => { ignoreScrollEvents = true; }
		);
		if (newPps !== null) pixelsPerSecond = newPps;
	}

	function doZoomIn() {
		pixelsPerSecond = tzZoomIn(pixelsPerSecond, MIN_PPS, MAX_PPS);
	}

	function doZoomOut() {
		pixelsPerSecond = tzZoomOut(pixelsPerSecond, MIN_PPS, MAX_PPS);
	}

	// Wheel listener — needs non-passive
	$effect(() => {
		const el = scrollAreaEl;
		if (!el) return;
		el.addEventListener('wheel', handleWheel, { passive: false });
		updateViewport();
		const ro = new ResizeObserver(() => updateViewport());
		ro.observe(el);
		return () => {
			el.removeEventListener('wheel', handleWheel);
			ro.disconnect();
		};
	});

	function handleScroll() {
		updateViewport();
	}

	// --- Keyboard shortcuts ---
	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
		if (e.key === ' ') {
			e.preventDefault();
			togglePreviewPlay();
		} else if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			doZoomIn();
		} else if (e.key === '-') {
			e.preventDefault();
			doZoomOut();
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			if (selectedEffectId) {
				removeEffectEntry(selectedEffectId);
			} else if (selectedIndex !== null) {
				removeEntry(selectedIndex);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			selectedIndex = null;
			selectedEffectId = null;
			showClipPicker = false;
			addingEffect = false;
		} else if ((e.key === 's' || e.key === 'S') && !e.repeat) {
			e.preventDefault();
			splitAtPlayhead();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setPreviewRate(previewPlaybackRate + 0.25);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			setPreviewRate(previewPlaybackRate - 0.25);
		}
	}

	// Auto-scroll playhead into view during playback
	$effect(() => {
		if (previewPlaying && scrollAreaEl) {
			const phX = playheadX;
			const sl = scrollAreaEl.scrollLeft;
			const sw = scrollAreaEl.clientWidth;
			if (phX < sl || phX > sl + sw - 50) {
				ignoreScrollEvents = true;
				scrollAreaEl.scrollLeft = phX - sw / 3;
			}
		}
	});

</script>

<svelte:window onkeydown={handleKeydown} />

{#if !loaded && !video}
	<div class="editor-page main-content">
		<div class="editor-loading">Loading video...</div>
	</div>
{:else if !video}
	<div class="editor-page main-content">
		<div class="editor-loading">
			<p>Video not found</p>
			<a href="/videos" class="btn-back">Back to Videos</a>
		</div>
	</div>
{:else}
	<div class="editor-page main-content">
		<div class="nle-layout nle-layout-vertical">
			<!-- TOP ROW: Preview + Properties -->
			<div class="preview-panel">
				<div class="preview-main">
				<div class="preview-player-area" class:image-drop-active={droppingImage} bind:this={previewPlayerAreaEl} ondragover={handleImageDragOver} ondragleave={handleImageDragLeave} ondrop={handleImageDrop}>
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={previewVideoEl}
						ontimeupdate={handlePreviewTimeUpdate}
						playsinline
						class="preview-video preview-video-hidden"
					></video>
					<canvas
						bind:this={verticalCanvasEl}
						width={VERT_CANVAS_W}
						height={VERT_CANVAS_H}
						class="vertical-preview-canvas"
					></canvas>
					<!-- Effect overlays on video — positioned to match the video's actual rendered area -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="effect-overlay-container"
						bind:this={overlayContainerEl}
						style="left:{videoBounds.left}px;top:{videoBounds.top}px;width:{videoBounds.width}px;height:{videoBounds.height}px;right:auto;bottom:auto"
					>
						{#each visibleEffects as entry (entry.id)}
							{#if entry.type === 'twitch-chat'}
								{@const pw = entry.panelWidth ?? 340}
								{@const ph = entry.panelHeight ?? 1080}
								{@const cs = entry.chatScale ?? 1}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="chat-panel-placeholder"
									class:bubble-selected={selectedEffectId === entry.id}
									style="left: {entry.x * 100}%; top: {entry.y * 100}%; width: {pw * videoScale * cs}px; height: {ph * videoScale * cs}px; {overlayAnimStyle(entry, compositionTime)}; {overlayShadowStyle(entry)}"
									onpointerdown={(e) => handleOverlayPointerDown(e, entry.id)}
									onpointermove={handleOverlayPointerMove}
									onpointerup={handleOverlayPointerUp}
								>
									<div class="chat-panel-scaler" style="width:{pw}px;height:{ph}px;transform:scale({videoScale * cs});transform-origin:0 0">
										{#if currentClipRegion && currentClipBounds}
											<ChatPanelPreview
												streamId={currentClipRegion.streamId}
												localStart={currentClipBounds.localStart}
												localEnd={currentClipBounds.localEnd}
												currentTime={chatLocalTime}
												chatOffset={entry.chatOffset ?? 0}
												fontWeight={entry.chatFontWeight ?? 400}
												{censorTerms}
											/>
										{:else}
											<span class="chat-panel-label">Chat Panel</span>
										{/if}
									</div>
								</div>
							{:else if entry.type === 'view' && !entry.viewSourceType}
								{@const progress = Math.max(0, Math.min(1, (compositionTime - entry.startTime) / Math.max(0.001, entry.duration)))}
								{@const sx = entry.viewSourceStartX ?? 0}
								{@const sy = entry.viewSourceStartY ?? 0}
								{@const sw = entry.viewSourceStartW ?? 1}
								{@const sh = entry.viewSourceStartH ?? 1}
								{@const ex = entry.viewSourceEndX ?? sx}
								{@const ey = entry.viewSourceEndY ?? sy}
								{@const ew = entry.viewSourceEndW ?? sw}
								{@const eh = entry.viewSourceEndH ?? sh}
								{@const cx = sx + (ex - sx) * progress}
								{@const cy = sy + (ey - sy) * progress}
								{@const cw = sw + (ew - sw) * progress}
								{@const ch2 = sh + (eh - sh) * progress}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="zoom-overlay"
									class:zoom-selected={selectedEffectId === entry.id}
									onclick={() => selectedEffectId = entry.id}
								>
									<div class="zoom-dim zoom-dim-top" style="height: {cy * 100}%"></div>
									<div class="zoom-dim zoom-dim-bottom" style="height: {Math.max(0, (1 - cy - ch2)) * 100}%"></div>
									<div class="zoom-dim zoom-dim-left" style="top: {cy * 100}%; height: {ch2 * 100}%; width: {cx * 100}%"></div>
									<div class="zoom-dim zoom-dim-right" style="top: {cy * 100}%; height: {ch2 * 100}%; width: {Math.max(0, (1 - cx - cw)) * 100}%"></div>
									<div class="zoom-region" style="left: {cx * 100}%; top: {cy * 100}%; width: {cw * 100}%; height: {ch2 * 100}%"></div>
								</div>
							{:else if entry.type === 'image'}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="image-overlay"
									class:bubble-selected={selectedEffectId === entry.id}
									style="left: {entry.x * 100}%; top: {entry.y * 100}%; {overlayAnimStyle(entry, compositionTime)}; {overlayShadowStyle(entry)}"
									onpointerdown={(e) => handleOverlayPointerDown(e, entry.id)}
									onpointermove={handleOverlayPointerMove}
									onpointerup={handleOverlayPointerUp}
								>
									{#if entry.imageId}
										{@const imgScale = videoScale * (entry.imageScale ?? 1)}
										<img
											src="/api/overlay-image/{entry.imageId}"
											alt="overlay"
											style="{entry.imageWidth ? `width: ${entry.imageWidth * imgScale}px; height: ${(entry.imageHeight ?? entry.imageWidth) * imgScale}px;` : `transform: scale(${imgScale}); transform-origin: 0 0;`} opacity: {entry.imageOpacity ?? 1}; display: block;"
											draggable="false"
											onload={(e) => {
												if (!entry.imageWidth || !entry.imageHeight) {
													const img = e.target as HTMLImageElement;
													updateEffectEntry(entry.id, { imageWidth: img.naturalWidth, imageHeight: img.naturalHeight });
												}
											}}
										/>
									{/if}
								</div>
							{:else if entry.type === 'subtitle'}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="subtitle-overlay"
									class:bubble-selected={selectedEffectId === entry.id}
									style="left: {entry.x * 100}%; top: {entry.y * 100}%; max-width: {(entry.subtitleMaxWidth ?? 900) * videoScale}px; font-size: {(entry.subtitleFontSize ?? 48) * videoScale}px; font-weight: {entry.subtitleFontWeight ?? 700}; font-family: '{entry.subtitleFontFamily ?? 'Inter'}', sans-serif; color: {entry.subtitleFontColor ?? '#FFFFFF'}; -webkit-text-stroke: {(entry.subtitleOutlineWidth ?? 4) * videoScale}px {entry.subtitleOutlineColor ?? '#000000'}; paint-order: stroke fill; text-align: {entry.subtitleTextAlign ?? 'center'}; {overlayAnimStyle(entry, compositionTime, true)}; {overlayShadowStyle(entry)}"
									onpointerdown={(e) => handleOverlayPointerDown(e, entry.id)}
									onpointermove={handleOverlayPointerMove}
									onpointerup={handleOverlayPointerUp}
								>{entry.subtitleText ?? 'Subtitle'}</div>
							{:else}
								{@const msg = entry.twitchId ? chatMessageCache.get(entry.twitchId) : undefined}
								{#if msg}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="chat-bubble"
										class:bubble-selected={selectedEffectId === entry.id}
										style="left: {entry.x * 100}%; top: {entry.y * 100}%; {overlayAnimStyle(entry, compositionTime)}; {overlayShadowStyle(entry)}"
										onpointerdown={(e) => handleOverlayPointerDown(e, entry.id)}
										onpointermove={handleOverlayPointerMove}
										onpointerup={handleOverlayPointerUp}
									>{#each msg.badges as badge}<img class="bubble-badge" src={badge.imageUrl} alt={badge.title} title={badge.title} />{/each}<span class="bubble-user" style="color: {msg.color || usernameColor(msg.username)}">{msg.username}</span><span class="bubble-sep">: </span>{#each msg.segments as seg}{#if seg.type === 'emote' && seg.emoteUrl}<img class="bubble-emote" src={seg.emoteUrl} alt={seg.text} title={seg.text} />{:else}<span class="bubble-text">{seg.text}</span>{/if}{/each}</div>
								{/if}
							{/if}
						{/each}
					</div>
				</div>
				<div class="video-controls"></div>
				</div>
				{#if chatPanelOpen}
					<ClipChatPanel
						clip={currentClipRegion}
						currentLocalTime={chatLocalTime}
						onseek={handleChatSeek}
					/>
				{/if}
			</div>

			<div class="properties-panel">
				{#if selectedEffectId}
					{@const selEffect = effectEntries.find((e) => e.id === selectedEffectId)}
					{#if selEffect}
						{@const msg = selEffect.twitchId ? chatMessageCache.get(selEffect.twitchId) : undefined}
						{@const isChatPanel = selEffect.type === 'twitch-chat'}
						{@const isView = selEffect.type === 'view'}
						{@const isSubtitle = selEffect.type === 'subtitle'}
						{@const isImage = selEffect.type === 'image'}
						{@const isAudio = selEffect.type === 'audio'}
						<div class="props-header">
							<h3 class="props-title">Effect Properties</h3>
							<button class="btn-deselect" onclick={() => selectedEffectId = null} title="Deselect">&times;</button>
						</div>

						<div class="props-info">
							<div class="props-row">
								<span class="props-label">Type</span>
								<span class="props-value">{isView ? 'View' : isChatPanel ? 'Chat Panel' : isSubtitle ? 'Subtitle' : isImage ? 'Image' : isAudio ? 'Audio' : 'Chat Message'}</span>
							</div>
							{#if selEffect.type === 'chat-message'}
								<div class="props-row">
									<span class="props-label">Twitch ID</span>
									<span class="props-value" style="font-size: 0.55rem; word-break: break-all">{selEffect.twitchId ?? '—'}</span>
								</div>
							{/if}
						</div>

						<div class="props-section">
							<div class="prop-field">
								<label class="prop-label">Track</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									step="1"
									value={selEffect.track ?? 0}
									onchange={(e) => updateEffectEntry(selEffect.id, { track: Math.max(0, Math.round(+(e.target as HTMLInputElement).value)) })}
								/>
							</div>
							<div class="prop-field">
								<label class="prop-label">Start Time (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									step="0.1"
									value={selEffect.startTime}
									onchange={(e) => updateEffectEntry(selEffect.id, { startTime: +(e.target as HTMLInputElement).value })}
								/>
							</div>
							<div class="prop-field">
								<label class="prop-label">Duration (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0.1"
									step="0.1"
									value={selEffect.duration}
									onchange={(e) => updateEffectEntry(selEffect.id, { duration: +(e.target as HTMLInputElement).value })}
								/>
							</div>
							{#if !isView && !isAudio}
							<div class="prop-field">
								<label class="prop-label">X Position (0-1)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									max="1"
									step="0.01"
									value={selEffect.x}
									onchange={(e) => updateEffectEntry(selEffect.id, { x: +(e.target as HTMLInputElement).value })}
								/>
							</div>
							<div class="prop-field">
								<label class="prop-label">Y Position (0-1)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									max="1"
									step="0.01"
									value={selEffect.y}
									onchange={(e) => updateEffectEntry(selEffect.id, { y: +(e.target as HTMLInputElement).value })}
								/>
							</div>
							{/if}
							{#if isView}
								<div class="prop-field">
									<label class="prop-label">Source Type</label>
									<select class="prop-input"
										value={selEffect.viewSourceType ?? 'custom'}
										onchange={(e) => {
											const val = (e.target as HTMLSelectElement).value;
											if (val === 'custom') updateEffectEntry(selEffect.id, { viewSourceType: undefined });
											else updateEffectEntry(selEffect.id, { viewSourceType: val as 'full' | 'camera' });
										}}
									>
										<option value="custom">Custom</option>
										<option value="full">Full Frame</option>
										<option value="camera">Camera</option>
									</select>
								</div>
								<div class="prop-field">
									<label class="prop-label">Source Track</label>
									<input type="number" class="prop-input" min="0" step="1"
										value={selEffect.viewSourceTrack ?? 0}
										onchange={(e) => {
											const val = Math.max(0, Math.round(+(e.target as HTMLInputElement).value));
											updateEffectEntry(selEffect.id, { viewSourceTrack: val || undefined });
										}}
									/>
								</div>
								{#if !selEffect.viewSourceType}
									<div class="prop-field">
										<label class="prop-label" style="font-weight:600;color:#63b3ed">Source Start</label>
									</div>
									<div class="prop-field">
										<label class="prop-label">X</label>
										<input type="number" class="prop-input" min="0" max="1" step="0.01"
											value={selEffect.viewSourceStartX ?? 0}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceStartX: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label">Y</label>
										<input type="number" class="prop-input" min="0" max="1" step="0.01"
											value={selEffect.viewSourceStartY ?? 0}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceStartY: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label">W</label>
										<input type="number" class="prop-input" min="0.05" max="1" step="0.01"
											value={selEffect.viewSourceStartW ?? 1}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceStartW: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label">H</label>
										<input type="number" class="prop-input" min="0.05" max="1" step="0.01"
											value={selEffect.viewSourceStartH ?? 1}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceStartH: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label" style="font-weight:600;color:#63b3ed;margin-top:4px">Source End</label>
									</div>
									<div class="prop-field">
										<label class="prop-label">X</label>
										<input type="number" class="prop-input" min="0" max="1" step="0.01"
											value={selEffect.viewSourceEndX ?? 0}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceEndX: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label">Y</label>
										<input type="number" class="prop-input" min="0" max="1" step="0.01"
											value={selEffect.viewSourceEndY ?? 0}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceEndY: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label">W</label>
										<input type="number" class="prop-input" min="0.05" max="1" step="0.01"
											value={selEffect.viewSourceEndW ?? 1}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceEndW: +(e.target as HTMLInputElement).value })}
										/>
									</div>
									<div class="prop-field">
										<label class="prop-label">H</label>
										<input type="number" class="prop-input" min="0.05" max="1" step="0.01"
											value={selEffect.viewSourceEndH ?? 1}
											onchange={(e) => updateEffectEntry(selEffect.id, { viewSourceEndH: +(e.target as HTMLInputElement).value })}
										/>
									</div>
								{/if}
								<div class="prop-field">
									<label class="prop-label" style="font-weight:600;color:#63b3ed;margin-top:4px">Destination</label>
								</div>
								<div class="prop-field">
									<label class="prop-label">X</label>
									<input type="number" class="prop-input" min="0" max="1" step="0.01"
										value={selEffect.viewDestX ?? 0}
										onchange={(e) => updateEffectEntry(selEffect.id, { viewDestX: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Y</label>
									<input type="number" class="prop-input" min="0" max="1" step="0.01"
										value={selEffect.viewDestY ?? 0}
										onchange={(e) => updateEffectEntry(selEffect.id, { viewDestY: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">W</label>
									<input type="number" class="prop-input" min="0.05" max="1" step="0.01"
										value={selEffect.viewDestW ?? 1}
										onchange={(e) => updateEffectEntry(selEffect.id, { viewDestW: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">H</label>
									<input type="number" class="prop-input" min="0.05" max="1" step="0.01"
										value={selEffect.viewDestH ?? 1}
										onchange={(e) => updateEffectEntry(selEffect.id, { viewDestH: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Dest Presets</label>
									<div style="display:flex;gap:3px;flex-wrap:wrap">
										<button class="btn-tl btn-tl-sm" onclick={() => updateEffectEntry(selEffect.id, { viewDestX: 0, viewDestY: 0, viewDestW: 1, viewDestH: 1 })}>Full</button>
										<button class="btn-tl btn-tl-sm" onclick={() => updateEffectEntry(selEffect.id, { viewDestX: 0, viewDestY: 0, viewDestW: 1, viewDestH: 0.64 })}>Top</button>
										<button class="btn-tl btn-tl-sm" onclick={() => updateEffectEntry(selEffect.id, { viewDestX: 0, viewDestY: 0.64, viewDestW: 1, viewDestH: 0.36 })}>Bottom</button>
										<button class="btn-tl btn-tl-sm" onclick={() => updateEffectEntry(selEffect.id, { viewDestX: 0.72, viewDestY: 0.72, viewDestW: 0.26, viewDestH: 0.26 })}>PiP</button>
									</div>
								</div>
								<div class="prop-field">
									<label class="prop-label">Z-Order</label>
									<input type="number" class="prop-input" min="0" step="1"
										value={selEffect.viewZOrder ?? 0}
										onchange={(e) => updateEffectEntry(selEffect.id, { viewZOrder: +(e.target as HTMLInputElement).value })}
									/>
								</div>
							{:else if isChatPanel}
								<div class="prop-field">
									<label class="prop-label">Panel Width (px)</label>
									<input
										type="number"
										class="prop-input"
										min="100"
										max="1920"
										step="10"
										value={selEffect.panelWidth ?? 340}
										onchange={(e) => updateEffectEntry(selEffect.id, { panelWidth: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Panel Height (px)</label>
									<input
										type="number"
										class="prop-input"
										min="100"
										max="1920"
										step="10"
										value={selEffect.panelHeight ?? 1080}
										onchange={(e) => updateEffectEntry(selEffect.id, { panelHeight: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Chat Offset (s)</label>
									<input
										type="number"
										class="prop-input"
										step="1"
										value={selEffect.chatOffset ?? 0}
										onchange={(e) => updateEffectEntry(selEffect.id, { chatOffset: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Scale</label>
									<input
										type="number"
										class="prop-input"
										min="0.1"
										max="5"
										step="0.1"
										value={selEffect.chatScale ?? 1}
										onchange={(e) => updateEffectEntry(selEffect.id, { chatScale: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Font Weight</label>
									<input
										type="number"
										class="prop-input"
										min="100"
										max="900"
										step="100"
										value={selEffect.chatFontWeight ?? 400}
										onchange={(e) => updateEffectEntry(selEffect.id, { chatFontWeight: +(e.target as HTMLInputElement).value })}
									/>
								</div>
							{:else if isSubtitle}
								<div class="prop-field">
									<label class="prop-label">Text</label>
									<textarea
										class="prop-input prop-textarea"
										rows="3"
										value={selEffect.subtitleText ?? ''}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleText: (e.target as HTMLTextAreaElement).value })}
									></textarea>
								</div>
								<div class="prop-field">
									<label class="prop-label">Font Family</label>
									<select
										class="prop-input"
										value={selEffect.subtitleFontFamily ?? 'Inter'}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleFontFamily: (e.target as HTMLSelectElement).value })}
									>
										<option value="Inter">Inter</option>
										<option value="Arial">Arial</option>
										<option value="Impact">Impact</option>
										<option value="Georgia">Georgia</option>
										<option value="Times New Roman">Times New Roman</option>
										<option value="Courier New">Courier New</option>
										<option value="Verdana">Verdana</option>
										<option value="Comic Sans MS">Comic Sans MS</option>
										<option value="Trebuchet MS">Trebuchet MS</option>
									</select>
								</div>
								<div class="prop-field">
									<label class="prop-label">Font Size (px)</label>
									<input
										type="number"
										class="prop-input"
										min="12"
										max="200"
										step="2"
										value={selEffect.subtitleFontSize ?? 48}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleFontSize: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Font Color</label>
									<input
										type="color"
										class="prop-input"
										value={selEffect.subtitleFontColor ?? '#FFFFFF'}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleFontColor: (e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Outline Color</label>
									<input
										type="color"
										class="prop-input"
										value={selEffect.subtitleOutlineColor ?? '#000000'}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleOutlineColor: (e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Outline Width (px)</label>
									<input
										type="number"
										class="prop-input"
										min="0"
										max="20"
										step="1"
										value={selEffect.subtitleOutlineWidth ?? 4}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleOutlineWidth: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Font Weight</label>
									<input
										type="number"
										class="prop-input"
										min="100"
										max="900"
										step="100"
										value={selEffect.subtitleFontWeight ?? 700}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleFontWeight: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Max Width (px)</label>
									<input
										type="number"
										class="prop-input"
										min="100"
										max="1920"
										step="10"
										value={selEffect.subtitleMaxWidth ?? 900}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleMaxWidth: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Text Align</label>
									<select
										class="prop-input"
										value={selEffect.subtitleTextAlign ?? 'center'}
										onchange={(e) => updateEffectEntry(selEffect.id, { subtitleTextAlign: (e.target as HTMLSelectElement).value as 'left' | 'center' | 'right' })}
									>
										<option value="left">Left</option>
										<option value="center">Center</option>
										<option value="right">Right</option>
									</select>
								</div>
							{:else if isImage}
								{#if selEffect.imageId}
									<div class="prop-field">
										<label class="prop-label">Preview</label>
										<img src="/api/overlay-image/{selEffect.imageId}" alt="overlay" style="max-width: 100%; max-height: 80px; border-radius: 4px; margin-top: 2px" />
									</div>
								{/if}
								<div class="prop-field">
									<label class="prop-label">Scale</label>
									<input
										type="number"
										class="prop-input"
										min="0.1"
										max="5"
										step="0.1"
										value={selEffect.imageScale ?? 1}
										onchange={(e) => updateEffectEntry(selEffect.id, { imageScale: +(e.target as HTMLInputElement).value })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Opacity</label>
									<input
										type="range"
										class="prop-input"
										min="0"
										max="1"
										step="0.05"
										value={selEffect.imageOpacity ?? 1}
										oninput={(e) => updateEffectEntry(selEffect.id, { imageOpacity: +(e.target as HTMLInputElement).value })}
									/>
									<span style="font-size: 0.6rem; color: #94a3b8">{(selEffect.imageOpacity ?? 1).toFixed(2)}</span>
								</div>
							{:else if isAudio}
								{#if selEffect.audioId}
									<div class="prop-field">
										<label class="prop-label">Preview</label>
										<!-- svelte-ignore a11y_media_has_caption -->
										<audio controls src="/api/overlay-audio/{selEffect.audioId}" style="width: 100%; height: 28px; margin-top: 2px"></audio>
									</div>
								{/if}
								<div class="prop-field">
									<label class="prop-label">Volume</label>
									<input
										type="range"
										class="prop-input"
										min="0"
										max="1"
										step="0.05"
										value={selEffect.audioVolume ?? 1}
										oninput={(e) => updateEffectEntry(selEffect.id, { audioVolume: +(e.target as HTMLInputElement).value })}
									/>
									<span style="font-size: 0.6rem; color: #94a3b8">{((selEffect.audioVolume ?? 1) * 100).toFixed(0)}%</span>
								</div>
								<div class="prop-field">
									<label class="prop-label">Audio Start (s)</label>
									<input
										type="number"
										class="prop-input"
										min="0"
										step="0.1"
										value={selEffect.audioOffset ?? 0}
										onchange={(e) => updateEffectEntry(selEffect.id, { audioOffset: Math.max(0, +(e.target as HTMLInputElement).value) })}
									/>
								</div>
								{#if selEffect.audioDuration}
									<div class="prop-field">
										<label class="prop-label">File Duration</label>
										<span class="props-value">{selEffect.audioDuration.toFixed(1)}s</span>
									</div>
								{/if}
							{/if}
						</div>

						{#if !isAudio}
						<div class="props-section">
							<div class="prop-field" style="margin-top: 4px">
								<label class="prop-label" style="font-weight:600;color:#94a3b8">Animation</label>
							</div>
							<div class="prop-field">
								<label class="prop-label">In Effect</label>
								<select
									class="prop-input"
									value={selEffect.animIn ?? 'none'}
									onchange={(e) => updateEffectEntry(selEffect.id, { animIn: (e.target as HTMLSelectElement).value as any })}
								>
									<option value="none">None</option>
									<option value="fade">Fade In</option>
									<option value="grow">Grow</option>
									<option value="shrink">Shrink</option>
									<option value="slide-up">Slide Up</option>
									<option value="slide-down">Slide Down</option>
									<option value="slide-left">Slide Left</option>
									<option value="slide-right">Slide Right</option>
								</select>
							</div>
							{#if (selEffect.animIn ?? 'none') !== 'none'}
							<div class="prop-field">
								<label class="prop-label">In Easing</label>
								<select
									class="prop-input"
									value={selEffect.animInEasing ?? 'ease-out'}
									onchange={(e) => updateEffectEntry(selEffect.id, { animInEasing: (e.target as HTMLSelectElement).value as any })}
								>
									<option value="linear">Linear</option>
									<option value="ease-in">Ease In</option>
									<option value="ease-out">Ease Out</option>
									<option value="ease-in-out">Ease In-Out</option>
									<option value="bounce">Bounce</option>
								</select>
							</div>
							{/if}
							<div class="prop-field">
								<label class="prop-label">Out Effect</label>
								<select
									class="prop-input"
									value={selEffect.animOut ?? 'none'}
									onchange={(e) => updateEffectEntry(selEffect.id, { animOut: (e.target as HTMLSelectElement).value as any })}
								>
									<option value="none">None</option>
									<option value="fade">Fade Out</option>
									<option value="grow">Grow</option>
									<option value="shrink">Shrink</option>
									<option value="slide-up">Slide Up</option>
									<option value="slide-down">Slide Down</option>
									<option value="slide-left">Slide Left</option>
									<option value="slide-right">Slide Right</option>
								</select>
							</div>
							{#if (selEffect.animOut ?? 'none') !== 'none'}
							<div class="prop-field">
								<label class="prop-label">Out Easing</label>
								<select
									class="prop-input"
									value={selEffect.animOutEasing ?? 'ease-in'}
									onchange={(e) => updateEffectEntry(selEffect.id, { animOutEasing: (e.target as HTMLSelectElement).value as any })}
								>
									<option value="linear">Linear</option>
									<option value="ease-in">Ease In</option>
									<option value="ease-out">Ease Out</option>
									<option value="ease-in-out">Ease In-Out</option>
									<option value="bounce">Bounce</option>
								</select>
							</div>
							{/if}
							<div class="prop-field">
								<label class="prop-label">Anim Duration (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0.1"
									max="2"
									step="0.05"
									value={selEffect.animDuration ?? 0.3}
									onchange={(e) => updateEffectEntry(selEffect.id, { animDuration: +(e.target as HTMLInputElement).value })}
								/>
							</div>
						</div>
						{/if}

						<div class="props-section">
							<div class="prop-field" style="margin-top: 4px">
								<label class="prop-label" style="font-weight:600;color:#94a3b8">Shadow</label>
							</div>
							<div class="prop-field">
								<label class="prop-label">
									<input
										type="checkbox"
										checked={!!selEffect.shadow}
										onchange={() => {
											if (selEffect.shadow) {
												updateEffectEntry(selEffect.id, { shadow: undefined } as any);
											} else {
												updateEffectEntry(selEffect.id, { shadow: { color: 'rgba(0,0,0,0.8)', blur: 4, offsetX: 2, offsetY: 2 } });
											}
										}}
									/>
									Enable Shadow
								</label>
							</div>
							{#if selEffect.shadow}
								<div class="prop-field">
									<label class="prop-label">Color</label>
									<input
										type="color"
										class="prop-input"
										value={(() => { const m = selEffect.shadow!.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (m) { return '#' + [m[1],m[2],m[3]].map(v => (+v).toString(16).padStart(2,'0')).join(''); } return selEffect.shadow!.color; })()}
										onchange={(e) => {
											const hex = (e.target as HTMLInputElement).value;
											const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
											const m = selEffect.shadow!.color.match(/([\d.]+)\)$/);
											const a = m ? m[1] : '0.8';
											updateEffectEntry(selEffect.id, { shadow: { ...selEffect.shadow!, color: `rgba(${r},${g},${b},${a})` } });
										}}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Opacity</label>
									<input
										type="range"
										class="prop-input"
										min="0"
										max="1"
										step="0.05"
										value={parseFloat(selEffect.shadow!.color.match(/([\d.]+)\)$/)?.[1] ?? '0.8')}
										oninput={(e) => {
											const opacity = +(e.target as HTMLInputElement).value;
											const m = selEffect.shadow!.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
											const [r,g,b] = m ? [m[1],m[2],m[3]] : ['0','0','0'];
											updateEffectEntry(selEffect.id, { shadow: { ...selEffect.shadow!, color: `rgba(${r},${g},${b},${opacity})` } });
										}}
									/>
									<span style="font-size: 0.6rem; color: #94a3b8">{parseFloat(selEffect.shadow!.color.match(/([\d.]+)\)$/)?.[1] ?? '0.8').toFixed(2)}</span>
								</div>
								<div class="prop-field">
									<label class="prop-label">Blur</label>
									<input
										type="number"
										class="prop-input"
										min="0"
										max="50"
										step="1"
										value={selEffect.shadow!.blur}
										onchange={(e) => updateEffectEntry(selEffect.id, { shadow: { ...selEffect.shadow!, blur: +(e.target as HTMLInputElement).value } })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Offset X</label>
									<input
										type="number"
										class="prop-input"
										min="-50"
										max="50"
										step="1"
										value={selEffect.shadow!.offsetX}
										onchange={(e) => updateEffectEntry(selEffect.id, { shadow: { ...selEffect.shadow!, offsetX: +(e.target as HTMLInputElement).value } })}
									/>
								</div>
								<div class="prop-field">
									<label class="prop-label">Offset Y</label>
									<input
										type="number"
										class="prop-input"
										min="-50"
										max="50"
										step="1"
										value={selEffect.shadow!.offsetY}
										onchange={(e) => updateEffectEntry(selEffect.id, { shadow: { ...selEffect.shadow!, offsetY: +(e.target as HTMLInputElement).value } })}
									/>
								</div>
							{/if}
						</div>

						{#if !isChatPanel && !isView && !isSubtitle && !isImage && msg}
							<div class="props-section">
								<label class="prop-label">Message Preview</label>
								<div class="effect-msg-preview">
									<span class="bubble-user" style="color: {msg.color || usernameColor(msg.username)}">{msg.username}</span>:
									{msg.text}
								</div>
							</div>
						{/if}

						<button class="btn-remove-clip" onclick={() => removeEffectEntry(selEffect.id)}>
							Remove Effect
						</button>
					{/if}
				{:else if selectedIndex !== null && entries[selectedIndex]}
					{@const selEntry = entries[selectedIndex]}
					{@const selClip = resolveClip(selEntry.clipId)}
					<div class="props-header">
						<h3 class="props-title">Clip Properties</h3>
						<button class="btn-deselect" onclick={() => selectedIndex = null} title="Deselect">×</button>
					</div>

					{#if selClip}
						<div class="props-info">
							<div class="props-row">
								<span class="props-label">Channel</span>
								<span class="props-value">{clipChannel(selClip)}</span>
							</div>
							<div class="props-row">
								<span class="props-label">Title</span>
								<span class="props-value">{selClip.title || 'Untitled'}</span>
							</div>
							<div class="props-row">
								<span class="props-label">Duration</span>
								<span class="props-value">{formatDuration(clipRawDuration(selClip))}</span>
							</div>
						</div>

						<div class="props-section">
							<div class="prop-field">
								<label class="prop-label">Trim Start (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									max={clipRawDuration(selClip)}
									step="0.1"
									value={selEntry.trimStart ?? 0}
									onchange={(e) => updateEntry(selectedIndex!, { trimStart: +(e.target as HTMLInputElement).value || undefined })}
								/>
							</div>
							<div class="prop-field">
								<label class="prop-label">Trim End (s)</label>
								<input
									type="number"
									class="prop-input"
									min="0"
									max={clipRawDuration(selClip)}
									step="0.1"
									value={selEntry.trimEnd ?? 0}
									onchange={(e) => updateEntry(selectedIndex!, { trimEnd: +(e.target as HTMLInputElement).value || undefined })}
								/>
							</div>
						</div>

						<button class="btn-remove-clip" onclick={() => removeEntry(selectedIndex!)}>
							Remove Clip
						</button>
					{:else}
						<div class="props-info">
							<span class="props-missing">Missing clip: {selEntry.clipId}</span>
						</div>
					{/if}
				{:else}
					<!-- No selection: show video metadata -->
					<div class="props-header">
						<h3 class="props-title">Video</h3>
					</div>

					<div class="props-section">
						<div class="prop-field">
							<label class="prop-label" for="v-title">Title</label>
							<input id="v-title" type="text" class="prop-input" bind:value={title} placeholder="Video title..." />
						</div>
						<div class="prop-field">
							<label class="prop-label" for="v-desc">Description</label>
							<textarea id="v-desc" class="prop-input prop-textarea" bind:value={description} placeholder="Description..." rows="3"></textarea>
						</div>
						<div class="prop-field">
							<label class="prop-label">Layout Presets</label>
							<div style="display:flex;gap:4px;flex-wrap:wrap">
								<button class="btn-tl btn-tl-sm" onclick={() => addViewEffect('top-bottom')} title="Gameplay top, camera bottom">Top/Bottom</button>
								<button class="btn-tl btn-tl-sm" onclick={() => addViewEffect('pip')} title="Full frame + camera PiP">PiP</button>
								<button class="btn-tl btn-tl-sm" onclick={() => addViewEffect('full')} title="Single full-frame view">Full</button>
							</div>
						</div>
					</div>

					<div class="props-section">
						<button class="prop-label censor-toggle" onclick={() => censorExpanded = !censorExpanded}>
							Censor Terms ({censorTerms.length}) {censorExpanded ? '\u25B4' : '\u25BE'}
						</button>
						{#if censorExpanded}
							<div class="censor-add">
								<input
									type="text"
									class="prop-input"
									placeholder="Add term..."
									bind:value={newCensorTerm}
									onkeydown={(e) => { if (e.key === 'Enter') handleAddCensorTerm(); }}
								/>
								<button class="btn-censor-add" onclick={handleAddCensorTerm}>+</button>
							</div>
							{#if censorTerms.length > 0}
								<div class="censor-list">
									{#each censorTerms as term}
										<div class="censor-item">
											<span class="censor-term">{term}</span>
											<button class="btn-censor-del" onclick={() => handleRemoveCensorTerm(term)}>&times;</button>
										</div>
									{/each}
								</div>
							{:else}
								<span class="censor-empty">No terms added</span>
							{/if}
						{/if}
					</div>

					<div class="props-summary">
						<span>{entries.length} clip{entries.length !== 1 ? 's' : ''}</span>
						<span class="props-dot">&middot;</span>
						<span>{formatDuration(totalDuration)}</span>
					</div>

					<div class="props-actions">
						<button class="btn-props btn-export" onclick={handleExport} disabled={exporting || entries.length === 0}>
							{exporting ? 'Queueing...' : 'Export Video'}
						</button>
						<button class="btn-props btn-delete" onclick={handleDeleteVideo}>Delete</button>
					</div>

					{#if exportResult}
						<div class="export-result" class:success={exportResult.success} class:error={!exportResult.success}>
							{exportResult.message}
						</div>
					{/if}

					<div class="save-status">
						{#if saving}
							<span class="save-dot saving"></span> Saving...
						{:else if lastSavedAt}
							<span class="save-dot saved"></span> Saved
						{/if}
					</div>
				{/if}
			</div>

			<!-- BOTTOM: Timeline -->
			<div class="timeline-area">
				<!-- Toolbar -->
				<div class="tl-toolbar">
					<button class="btn-tl" onclick={togglePreviewPlay} title={previewPlaying ? 'Pause' : 'Play'}>
						{previewPlaying ? '\u23F8' : '\u25B6'}
					</button>
					<span class="vid-speed">{previewPlaybackRate}x</span>
					<span class="tl-time">{formatDuration(compositionTime)}</span>
					<span class="tl-sep">/</span>
					<span class="tl-time">{formatDuration(totalDuration)}</span>
					{#if entries.length > 0}
						<span class="tl-sep" style="color: #333">|</span>
						<span class="tl-time tl-time-clip">{clipCurrentTimeText}</span>
						<span class="tl-sep tl-sep-clip">/</span>
						<span class="tl-time tl-time-clip">{clipDurationText}</span>
						<span class="transport-clip-info">
							Clip {currentPreviewIndex + 1}/{entries.length}
							{#if resolveClip(entries[currentPreviewIndex]?.clipId ?? '')}
								{@const curClip = resolveClip(entries[currentPreviewIndex]?.clipId ?? '')!}
								— {curClip.title || clipChannel(curClip)}
							{/if}
						</span>
					{/if}
					<div class="tl-spacer"></div>
					<button class="btn-tl btn-tl-sm" onclick={() => { showClipPicker = !showClipPicker; }} title="Add clips">
						{showClipPicker ? 'Done' : '+ Add Clips'}
					</button>
					<button class="btn-tl btn-tl-sm btn-fx" onclick={() => { addingEffect = !addingEffect; }} title="Add chat message effect">
						{addingEffect ? 'Cancel' : '+ Chat Msg'}
					</button>
					<button class="btn-tl btn-tl-sm btn-fx-chat" onclick={addTwitchChatEffect} title="Add scrolling chat panel effect">
						+ Chat Panel
					</button>
					<button class="btn-tl btn-tl-sm btn-fx-zoom" onclick={() => addViewEffect()} title="Add view effect">
						+ View
					</button>
					<button class="btn-tl btn-tl-sm btn-fx-subtitle" onclick={addSubtitleEffect} title="Add subtitle text overlay">
						+ Subtitle
					</button>
					<span class="btn-tl btn-tl-sm btn-fx-image" title="Drag an image file onto the video preview to add an image overlay" style="cursor: default; opacity: 0.7">+ Image (Drop)</span>
					<button class="btn-tl btn-tl-sm" class:btn-chat-active={chatPanelOpen} onclick={() => { chatPanelOpen = !chatPanelOpen; }} title="Toggle chat panel">
						{chatPanelOpen ? 'Hide Chat' : 'Chat'}
					</button>
					<div class="tl-spacer"></div>
					<button class="btn-tl btn-tl-sm" onclick={doZoomOut} title="Zoom out (-)">−</button>
					<span class="tl-zoom">{pixelsPerSecond.toFixed(0)} px/s</span>
					<button class="btn-tl btn-tl-sm" onclick={doZoomIn} title="Zoom in (+)">+</button>
				</div>

				<!-- Clip picker overlay -->
				{#if showClipPicker}
					<div class="clip-picker-overlay">
						<input
							type="text"
							class="picker-search"
							bind:value={pickerFilter}
							placeholder="Search clips..."
						/>
						<div class="picker-list">
							{#each pickerClips as clip (clip.id)}
								<div class="picker-item">
									<span class="picker-channel">{clipChannel(clip)}</span>
									<span class="picker-title">{clip.title || 'Untitled'}</span>
									<span class="picker-dur">{formatDuration(clip.endTime - clip.startTime)}</span>
									<button class="btn-picker-add" onclick={() => addClip(clip.id)}>Add</button>
								</div>
							{/each}
							{#if pickerClips.length === 0}
								<div class="picker-empty">No clips available</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Add effect input -->
				{#if addingEffect}
					<div class="add-effect-bar">
						<span class="add-effect-label">Twitch Message ID:</span>
						<input
							type="text"
							class="add-effect-input"
							bind:value={addEffectTwitchId}
							placeholder="Paste twitchId and press Enter..."
							onkeydown={(e) => {
								if (e.key === 'Enter' && addEffectTwitchId.trim()) {
									addEffectEntry(addEffectTwitchId.trim());
									addEffectTwitchId = '';
									addingEffect = false;
								} else if (e.key === 'Escape') {
									addingEffect = false;
								}
							}}
						/>
					</div>
				{/if}

				<!-- Timeline body -->
				<div class="tl-body">
					<!-- Track labels -->
					<div class="tl-labels">
						<div class="tl-ruler-spacer"></div>
						{#each { length: effectTrackCount } as _, i}
							{@const trackIdx = effectTrackCount - 1 - i}
							<div class="tl-label-row" style="height: 30px"><span class="tl-label-icon" style="color: #38bdf8">[FX{trackIdx > 0 ? trackIdx : ''}]</span><span class="tl-label-text">Effects</span></div>
						{/each}
						{#each { length: videoTrackCount } as _, i}
							{@const vTrackIdx = videoTrackCount - 1 - i}
							<div class="tl-label-row" style="height: 64px"><span class="tl-label-icon">[V{vTrackIdx > 0 ? vTrackIdx : ''}]</span><span class="tl-label-text">Video</span></div>
						{/each}
					</div>

					<!-- Scrollable timeline area -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="tl-scroll-area"
						bind:this={scrollAreaEl}
						onscroll={handleScroll}
						onmousedown={handleTimelineClick}
						onmousemove={handleTimelineMouseMove}
						onmouseleave={handleTimelineMouseLeave}
					>
						<div class="tl-content" style="width: {contentWidth}px">
							<!-- Time ruler -->
							<div class="tl-ruler">
								{#each ticks as t}
									<div class="tl-tick" style="left: {t.x}px">
										<div class="tl-tick-line"></div>
										<span class="tl-tick-label">{t.label}</span>
									</div>
								{/each}
							</div>

							<!-- [FX] Effects Tracks (highest track at top = renders on top) -->
							{#each { length: effectTrackCount } as _, i}
								{@const trackIdx = effectTrackCount - 1 - i}
								<div class="tl-track tl-track-effects" style="height: 30px">
									{#each effectEntries.filter((e) => (e.track ?? 0) === trackIdx) as entry (entry.id)}
										{@const leftPx = entry.startTime * pixelsPerSecond}
										{@const widthPx = entry.duration * pixelsPerSecond}
										{@const isVisible = leftPx + widthPx > viewportLeft - CULL_MARGIN && leftPx < viewportLeft + viewportWidth + CULL_MARGIN}
										{@const isSelected = selectedEffectId === entry.id}
										{@const emsg = entry.twitchId ? chatMessageCache.get(entry.twitchId) : undefined}
										{@const isChatPanel = entry.type === 'twitch-chat'}
										{#if isVisible}
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div
												class="effect-block"
												class:selected={isSelected}
												class:effect-chat-panel={isChatPanel}
												class:effect-view={entry.type === 'view'}
												class:effect-subtitle={entry.type === 'subtitle'}
												class:effect-image={entry.type === 'image'}
												class:effect-audio={entry.type === 'audio'}
												style="left: {leftPx}px; width: {widthPx}px"
												onclick={(e) => handleEffectClick(e, entry.id)}
												onmousedown={(e) => handleEffectMoveStart(e, entry.id)}
											>
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div class="trim-handle trim-handle-start" onmousedown={(e) => handleEffectTrimStart(e, entry.id)}></div>
												<span class="clip-label" style="font-size: 0.55rem">
													{#if entry.type === 'view'}
														View{entry.viewSourceType ? ` (${entry.viewSourceType})` : ''}
													{:else if isChatPanel}
														Chat Panel
													{:else if entry.type === 'subtitle'}
														{entry.subtitleText?.slice(0, 20) ?? 'Subtitle'}{(entry.subtitleText?.length ?? 0) > 20 ? '...' : ''}
													{:else if entry.type === 'image'}
														Image
													{:else if entry.type === 'audio'}
														Audio
													{:else}
														{emsg?.username ?? entry.twitchId?.slice(0, 8) ?? '?'}
													{/if}
												</span>
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div class="trim-handle trim-handle-end" onmousedown={(e) => handleEffectTrimEnd(e, entry.id)}></div>
											</div>
										{/if}
									{/each}
								</div>
							{/each}

							<!-- [V] Video Tracks (highest track at top) -->
							{#each { length: videoTrackCount } as _, vi}
								{@const vTrackIdx = videoTrackCount - 1 - vi}
								{@const vTrackLayout = trackLayouts.get(vTrackIdx) ?? []}
								<div class="tl-track tl-track-video" style="height: 64px">
									{#each vTrackLayout as cl (cl.entry.clipId + '-' + cl.index)}
										{@const leftPx = cl.startOffset * pixelsPerSecond}
										{@const widthPx = cl.effectiveDuration * pixelsPerSecond}
										{@const isVisible = leftPx + widthPx > viewportLeft - CULL_MARGIN && leftPx < viewportLeft + viewportWidth + CULL_MARGIN}
										{@const isSelected = selectedIndex === cl.index}
										{@const isDragging = (dragMode === 'reorder' || dragMode === 'move-track') && dragEntryIndex === cl.index}
										{#if isVisible}
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div
												class="clip-block"
												class:selected={isSelected}
												class:dragging={isDragging}
												style="left: {leftPx + (isDragging ? dragPreviewDelta : 0)}px; width: {widthPx}px; background: {cl.color};"
												onclick={(e) => handleClipClick(e, cl.index)}
												onmousedown={(e) => handleReorderStart(e, cl.index)}
											>
												<canvas
													class="clip-waveform-canvas"
													use:clipWaveformAction={() => cl.index}
												></canvas>
												<!-- Trim handles -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div class="trim-handle trim-handle-start" onmousedown={(e) => handleTrimStart(e, cl.index)}></div>
												<span class="clip-label">
													{#if cl.clip}
														<span class="clip-ch">{clipChannel(cl.clip)}</span>
														{cl.clip.title || ''}
													{:else}
														Missing
													{/if}
												</span>
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div class="trim-handle trim-handle-end" onmousedown={(e) => handleTrimEnd(e, cl.index)}></div>
											</div>
										{/if}
									{/each}

									<!-- Drop indicator for reorder (track 0 only) -->
									{#if vTrackIdx === 0 && dragMode === 'reorder' && dragInsertIndex !== null}
										{@const insertOffset = dragInsertIndex < clipLayout.length ? clipLayout[dragInsertIndex].startOffset : totalDuration}
										<div class="drop-indicator" style="left: {insertOffset * pixelsPerSecond}px"></div>
									{/if}
								</div>
							{/each}

							<!-- Ghost playhead (mouse hover) -->
							{#if ghostX !== null}
								<div class="tl-ghost-playhead" style="left: {ghostX}px"></div>
							{/if}

							<!-- Playhead -->
							<div class="tl-playhead" style="left: {playheadX}px"></div>
						</div>
					</div>
				</div>

				{#if entries.length === 0}
					<div class="tl-empty">
						No clips — click "+ Add Clips" to start building your composition
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.editor-page {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}

	.editor-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 12px;
		color: #888;
		font-size: 0.85rem;
	}

	.btn-back {
		color: #a78bfa;
		text-decoration: none;
		font-size: 0.8rem;
	}

	.btn-back:hover {
		color: #c4b5fd;
	}

	/* ============================================================
	   NLE GRID LAYOUT
	   ============================================================ */
	.nle-layout {
		display: grid;
		grid-template-columns: 1fr 320px;
		grid-template-rows: 1fr auto;
		height: 100%;
		width: 100%;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}

	/* --- 9:16 vertical layout: Timeline | Properties | Preview --- */
	.nle-layout-vertical {
		grid-template-columns: 1fr 300px auto;
		grid-template-rows: 1fr;
	}

	.nle-layout-vertical .timeline-area {
		grid-column: 1;
		grid-row: 1;
		height: auto;
		border-top: none;
		border-right: 1px solid #2a2a4a;
	}

	.nle-layout-vertical .tl-toolbar {
		flex-wrap: wrap;
	}

	.nle-layout-vertical .properties-panel {
		grid-column: 2;
		grid-row: 1;
		border-bottom: none;
		border-right: 1px solid #1a1a2e;
	}

	.nle-layout-vertical .preview-panel {
		grid-column: 3;
		grid-row: 1;
		border-right: none;
		border-left: 1px solid #1a1a2e;
		flex-direction: column;
		overflow: hidden;
		height: 100%;
		max-height: 100%;
		aspect-ratio: 9 / 16;
	}

	/* ============================================================
	   PREVIEW PANEL (top-left)
	   ============================================================ */
	.preview-panel {
		grid-column: 1;
		grid-row: 1;
		display: flex;
		flex-direction: row;
		overflow: hidden;
		min-height: 0;
		min-width: 0;
		border-right: 1px solid #1a1a2e;
		background: #0a0a1a;
	}

	.preview-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.preview-player-area {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #000;
		min-height: 0;
		position: relative;
	}

	.preview-video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}

	.preview-video-hidden {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.vertical-preview-canvas {
		max-width: 100%;
		max-height: 100%;
		aspect-ratio: 9 / 16;
		display: block;
		background: #000;
	}

	.video-controls {
		display: flex;
		flex-direction: column;
		background: #0a0a1a;
		flex-shrink: 0;
	}

	.transport-clip-info {
		font-size: 0.7rem;
		color: #888;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ============================================================
	   PROPERTIES PANEL (top-right)
	   ============================================================ */
	.properties-panel {
		grid-column: 2;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		min-height: 0;
		padding: 16px;
		background: #0d0d1f;
		border-bottom: 1px solid #1a1a2e;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0d0d1f;
	}

	.props-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.props-title {
		font-size: 0.8rem;
		font-weight: 700;
		color: #e0e0ff;
		margin: 0;
	}

	.btn-deselect {
		background: none;
		border: 1px solid #2a2a4a;
		color: #888;
		width: 22px;
		height: 22px;
		border-radius: 3px;
		cursor: pointer;
		font-size: 0.8rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.btn-deselect:hover {
		background: #2a2a4a;
		color: #fff;
	}

	.props-info {
		margin-bottom: 16px;
	}

	.props-row {
		display: flex;
		justify-content: space-between;
		padding: 4px 0;
		font-size: 0.7rem;
	}

	.props-label {
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 600;
		font-size: 0.6rem;
	}

	.props-value {
		color: #ccc;
		text-align: right;
	}

	.props-missing {
		color: #f87171;
		font-size: 0.7rem;
	}

	.props-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 16px;
	}

	.prop-field {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.prop-label {
		font-size: 0.6rem;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 600;
	}

	.prop-input,
	.prop-select {
		width: 100%;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 5px 8px;
		border-radius: 4px;
		outline: none;
		font-family: inherit;
	}

	.prop-input:focus,
	.prop-select:focus {
		border-color: #7c3aed;
	}

	.prop-textarea {
		resize: vertical;
	}

	.btn-remove-clip {
		margin-top: 12px;
		background: #3a1a1a;
		border: 1px solid #5a2a2a;
		color: #c88;
		font-size: 0.7rem;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		width: 100%;
	}

	.btn-remove-clip:hover {
		background: #5a2a2a;
		color: #faa;
	}

	.props-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.7rem;
		color: #888;
		margin-bottom: 16px;
	}

	.props-dot {
		color: #555;
	}

	.props-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}

	.btn-props {
		font-size: 0.7rem;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		border: none;
		font-weight: 600;
		text-decoration: none;
		text-align: center;
		display: block;
	}

	.btn-export {
		background: #7c3aed;
		color: #fff;
	}

	.btn-export:hover {
		background: #6d28d9;
	}

	.btn-export:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-delete {
		background: #3a1a1a;
		border: 1px solid #5a2a2a;
		color: #c88;
	}

	.btn-delete:hover {
		background: #5a2a2a;
		color: #faa;
	}

	.export-result {
		margin-top: 8px;
		padding: 6px 10px;
		font-size: 0.7rem;
		border-radius: 4px;
	}

	.export-result.success {
		color: #4ade80;
		background: rgba(22, 163, 74, 0.08);
	}

	.export-result.error {
		color: #f87171;
		background: rgba(220, 38, 38, 0.08);
	}

	.save-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.65rem;
		color: #888;
		margin-top: 8px;
	}

	.save-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.save-dot.saving {
		background: #f59e0b;
	}

	.save-dot.saved {
		background: #4ade80;
	}

	/* Censor terms UI */
	.censor-toggle {
		cursor: pointer;
		background: none;
		border: none;
		width: 100%;
		text-align: left;
		padding: 0;
	}

	.censor-add {
		display: flex;
		gap: 4px;
		margin-bottom: 6px;
	}

	.censor-add .prop-input {
		flex: 1;
	}

	.btn-censor-add {
		background: #3b82f6;
		color: #fff;
		border: none;
		border-radius: 4px;
		width: 28px;
		cursor: pointer;
		font-size: 16px;
	}

	.btn-censor-add:hover {
		background: #2563eb;
	}

	.censor-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.censor-item {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		background: #374151;
		border-radius: 4px;
		padding: 2px 6px;
		font-size: 0.7rem;
		color: #d1d5db;
	}

	.btn-censor-del {
		background: none;
		border: none;
		color: #9ca3af;
		cursor: pointer;
		font-size: 14px;
		padding: 0 2px;
		line-height: 1;
	}

	.btn-censor-del:hover {
		color: #ef4444;
	}

	.censor-empty {
		font-size: 0.65rem;
		color: #6b7280;
	}

	/* ============================================================
	   TIMELINE AREA (bottom, spans both columns)
	   ============================================================ */
	.timeline-area {
		grid-column: 1 / -1;
		grid-row: 2;
		display: flex;
		flex-direction: column;
		height: 280px;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		background: #0a0a1a;
		border-top: 1px solid #2a2a4a;
		user-select: none;
		position: relative;
	}

	/* --- Toolbar --- */
	.tl-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
	}

	.btn-tl {
		background: #2a2a4a;
		border: none;
		color: #ccc;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.btn-tl:hover {
		background: #3a3a5a;
		color: #fff;
	}

	.btn-tl-sm {
		padding: 2px 8px;
		font-size: 0.75rem;
	}

	.vid-speed {
		font-size: 0.7rem;
		color: #7c3aed;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
		min-width: 3em;
		text-align: center;
	}

	.tl-time {
		font-size: 0.8rem;
		color: #e0e0ff;
		font-variant-numeric: tabular-nums;
		font-family: monospace;
	}

	.tl-sep {
		color: #555;
		font-size: 0.7rem;
	}

	.tl-time-clip {
		color: #888;
		font-size: 0.7rem;
	}

	.tl-sep-clip {
		color: #444;
	}

	.tl-spacer {
		flex: 1;
	}

	.tl-zoom {
		font-size: 0.65rem;
		color: #666;
		font-variant-numeric: tabular-nums;
		min-width: 4em;
		text-align: center;
	}

	/* --- Clip picker overlay --- */
	.clip-picker-overlay {
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		padding: 8px 12px;
		max-height: 200px;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
	}

	.picker-search {
		width: 100%;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 5px 10px;
		border-radius: 4px;
		outline: none;
		margin-bottom: 6px;
	}

	.picker-search:focus {
		border-color: #7c3aed;
	}

	.picker-list {
		overflow-y: auto;
		flex: 1;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0f0f23;
	}

	.picker-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		border-bottom: 1px solid #1a1a2e;
	}

	.picker-channel {
		font-size: 0.65rem;
		color: #7c3aed;
		font-weight: 600;
		flex-shrink: 0;
	}

	.picker-title {
		font-size: 0.7rem;
		color: #ccc;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.picker-dur {
		font-size: 0.6rem;
		color: #666;
		font-family: monospace;
		flex-shrink: 0;
	}

	.picker-empty {
		text-align: center;
		color: #555;
		font-size: 0.75rem;
		padding: 12px;
	}

	.btn-picker-add {
		background: #2a2a4a;
		border: 1px solid #3a3a5a;
		color: #ccc;
		font-size: 0.6rem;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		flex-shrink: 0;
	}

	.btn-picker-add:hover {
		background: #3a3a5a;
		color: #fff;
	}

	/* --- Timeline body (labels + scroll area) --- */
	.tl-body {
		flex: 1;
		display: flex;
		min-height: 0;
		overflow: hidden;
	}

	.tl-labels {
		width: 80px;
		flex-shrink: 0;
		background: #0f0f23;
		border-right: 1px solid #1a1a2e;
		overflow: hidden;
	}

	.tl-ruler-spacer {
		height: 24px;
		border-bottom: 1px solid #1a1a2e;
	}

	.tl-label-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 8px;
		border-bottom: 1px solid #111;
	}

	.tl-label-icon {
		font-size: 0.6rem;
		color: #7c3aed;
		font-weight: 700;
		font-family: monospace;
	}

	.tl-label-text {
		font-size: 0.65rem;
		color: #888;
	}

	/* --- Scroll area --- */
	.tl-scroll-area {
		flex: 1;
		overflow-x: auto;
		overflow-y: hidden;
		position: relative;
		cursor: crosshair;
		scrollbar-width: thin;
		scrollbar-color: #2a2a4a #0a0a1a;
	}

	.tl-scroll-area::-webkit-scrollbar {
		height: 6px;
	}

	.tl-scroll-area::-webkit-scrollbar-track {
		background: #0a0a1a;
	}

	.tl-scroll-area::-webkit-scrollbar-thumb {
		background: #2a2a4a;
		border-radius: 3px;
	}

	.tl-content {
		position: relative;
		min-height: 100%;
	}

	/* --- Ruler --- */
	.tl-ruler {
		height: 24px;
		position: sticky;
		top: 0;
		z-index: 5;
		border-bottom: 1px solid #1a1a2e;
		background: #0d0d1f;
	}

	.tl-tick {
		position: absolute;
		top: 0;
		height: 100%;
	}

	.tl-tick-line {
		width: 1px;
		height: 8px;
		background: #444;
		position: absolute;
		bottom: 0;
	}

	.tl-tick-label {
		font-size: 0.6rem;
		color: #666;
		position: absolute;
		top: 2px;
		left: 4px;
		white-space: nowrap;
	}

	/* --- Tracks --- */
	.tl-track {
		position: relative;
		border-bottom: 1px solid #111;
	}

	/* --- Video track: clip blocks --- */
	.clip-block {
		position: absolute;
		top: 3px;
		height: calc(100% - 6px);
		border-radius: 4px;
		cursor: grab;
		overflow: hidden;
		display: flex;
		align-items: flex-end;
		transition: opacity 0.1s;
	}

	.clip-waveform-canvas {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		border-radius: 4px;
	}

	.clip-block:hover {
		filter: brightness(1.15);
	}

	.clip-block.selected {
		outline: 2px solid #fff;
		outline-offset: -1px;
		z-index: 2;
	}

	.clip-block.dragging {
		opacity: 0.5;
		cursor: grabbing;
		z-index: 3;
	}

	.clip-label {
		position: relative;
		z-index: 1;
		font-size: 0.6rem;
		color: rgba(255, 255, 255, 0.9);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
		padding: 0 10px 4px;
		line-height: 1.2;
		flex: 1;
		min-width: 0;
	}

	.clip-ch {
		font-weight: 700;
		margin-right: 4px;
	}

	/* --- Trim handles --- */
	.trim-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 4;
		background: rgba(255, 255, 255, 0);
		transition: background 0.15s;
	}

	.trim-handle:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	.trim-handle-start {
		left: 0;
		border-radius: 4px 0 0 4px;
	}

	.trim-handle-end {
		right: 0;
		border-radius: 0 4px 4px 0;
	}

	/* --- Drop indicator --- */
	.drop-indicator {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		z-index: 5;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.5);
	}

	/* --- Playhead --- */
	.tl-ghost-playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: rgba(255, 255, 255, 0.15);
		pointer-events: none;
		z-index: 9;
	}

	.tl-playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #fff;
		pointer-events: none;
		z-index: 10;
		box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
	}

	/* --- Empty state --- */
	.tl-empty {
		position: absolute;
		bottom: 50%;
		left: 50%;
		transform: translate(-50%, 50%);
		color: #555;
		font-size: 0.8rem;
		pointer-events: none;
	}

	/* ============================================================
	   EFFECTS TRACK & OVERLAYS
	   ============================================================ */

	/* --- Add effect bar --- */
	.add-effect-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background: #0f0f23;
		border-bottom: 1px solid #1a1a2e;
		flex-shrink: 0;
	}

	.add-effect-label {
		font-size: 0.7rem;
		color: #38bdf8;
		white-space: nowrap;
		font-weight: 600;
	}

	.add-effect-input {
		flex: 1;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		color: #e0e0ff;
		font-size: 0.75rem;
		padding: 5px 10px;
		border-radius: 4px;
		outline: none;
		font-family: monospace;
	}

	.add-effect-input:focus {
		border-color: #38bdf8;
	}

	/* --- Effect blocks on timeline --- */
	.tl-track-effects {
		background: rgba(56, 189, 248, 0.03);
	}

	.effect-block {
		position: absolute;
		top: 3px;
		height: calc(100% - 6px);
		border-radius: 4px;
		cursor: grab;
		overflow: hidden;
		display: flex;
		align-items: center;
		background: rgba(56, 189, 248, 0.3);
		border: 1px solid rgba(56, 189, 248, 0.4);
		transition: opacity 0.1s;
	}

	.effect-block:hover {
		filter: brightness(1.15);
	}

	.effect-block.selected {
		outline: 2px solid #fff;
		outline-offset: -1px;
		z-index: 2;
	}

	.btn-fx {
		color: #38bdf8;
		border: 1px solid rgba(56, 189, 248, 0.3);
		background: rgba(56, 189, 248, 0.1);
	}

	.btn-fx:hover {
		background: rgba(56, 189, 248, 0.2);
		color: #7dd3fc;
	}

	.btn-fx-chat {
		color: #c084fc;
		border: 1px solid rgba(192, 132, 252, 0.3);
		background: rgba(192, 132, 252, 0.1);
	}

	.btn-fx-chat:hover {
		background: rgba(192, 132, 252, 0.2);
		color: #d8b4fe;
	}

	.effect-chat-panel {
		background: rgba(168, 85, 247, 0.3);
		border-color: rgba(168, 85, 247, 0.4);
	}

	.btn-fx-zoom {
		color: #fbbf24;
		border: 1px solid rgba(251, 191, 36, 0.3);
		background: rgba(251, 191, 36, 0.1);
	}

	.btn-fx-zoom:hover {
		background: rgba(251, 191, 36, 0.2);
		color: #fde68a;
	}

	.btn-fx-subtitle {
		color: #34d399;
		border: 1px solid rgba(52, 211, 153, 0.3);
		background: rgba(52, 211, 153, 0.1);
	}

	.btn-fx-subtitle:hover {
		background: rgba(52, 211, 153, 0.2);
		color: #6ee7b7;
	}

	.effect-view {
		background: rgba(99, 179, 237, 0.3);
		border-color: rgba(99, 179, 237, 0.4);
	}

	.effect-subtitle {
		background: rgba(52, 211, 153, 0.3);
		border-color: rgba(52, 211, 153, 0.4);
	}

	.effect-image {
		background: rgba(245, 158, 11, 0.3);
		border-color: rgba(245, 158, 11, 0.4);
	}

	.effect-audio {
		background: rgba(6, 182, 212, 0.3);
		border-color: rgba(6, 182, 212, 0.4);
	}

	.btn-fx-image {
		color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.3);
		background: rgba(245, 158, 11, 0.1);
	}

	/* Image overlay on video preview */
	.image-overlay {
		position: absolute;
		cursor: grab;
		pointer-events: auto;
		line-height: 0;
	}

	.image-overlay.bubble-selected {
		outline: 2px solid #f59e0b;
		outline-offset: 2px;
		border-radius: 2px;
	}

	.image-overlay img {
		display: block;
		pointer-events: none;
	}

	/* Drop zone visual feedback */
	.image-drop-active {
		outline: 2px dashed #f59e0b;
		outline-offset: -2px;
		background: rgba(245, 158, 11, 0.1);
	}

	/* Zoom preview overlay */
	.zoom-overlay {
		position: absolute;
		inset: 0;
		pointer-events: auto;
		cursor: pointer;
	}

	.zoom-dim {
		position: absolute;
		background: rgba(0, 0, 0, 0.5);
	}

	.zoom-dim-top {
		top: 0;
		left: 0;
		width: 100%;
	}

	.zoom-dim-bottom {
		bottom: 0;
		left: 0;
		width: 100%;
	}

	.zoom-dim-left {
		left: 0;
	}

	.zoom-dim-right {
		right: 0;
	}

	.zoom-region {
		position: absolute;
		border: 2px solid #fbbf24;
		border-radius: 2px;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
	}

	.zoom-selected .zoom-region {
		border-color: #fff;
		box-shadow: 0 0 8px rgba(251, 191, 36, 0.6), 0 0 0 1px rgba(0, 0, 0, 0.3);
	}

	.chat-panel-placeholder {
		position: absolute;
		background: rgba(168, 85, 247, 0.2);
		border: 2px dashed rgba(168, 85, 247, 0.6);
		border-radius: 4px;
		overflow: hidden;
		cursor: move;
		pointer-events: auto;
		touch-action: none;
	}

	.chat-panel-scaler {
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.chat-panel-placeholder.bubble-selected {
		border-color: #fff;
		box-shadow: 0 0 8px rgba(168, 85, 247, 0.5);
	}

	.chat-panel-label {
		color: rgba(255, 255, 255, 0.6);
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		pointer-events: none;
	}

	.btn-chat-active {
		background: rgba(145, 71, 255, 0.2);
		border: 1px solid rgba(145, 71, 255, 0.4);
		color: #bf94ff;
	}

	/* --- Effect overlay on video --- */
	.effect-overlay-container {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		pointer-events: none;
	}

	.chat-bubble {
		position: absolute;
		pointer-events: auto;
		background: rgba(24, 24, 27, 0.85);
		padding: 4px 8px;
		max-width: 400px;
		font-size: 13px;
		line-height: 1.4;
		word-break: break-word;
		cursor: grab;
		user-select: none;
		touch-action: none;
		color: #efeff1;
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
	}

	.chat-bubble.bubble-selected {
		outline: 2px solid #38bdf8;
		outline-offset: 1px;
	}

	.subtitle-overlay {
		position: absolute;
		pointer-events: auto;
		padding: 4px 8px;
		width: max-content;
		white-space: pre-wrap;
		word-wrap: break-word;
		cursor: grab;
		line-height: 1.3;
		user-select: none;
		touch-action: none;
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
	}

	.subtitle-overlay.bubble-selected {
		outline: 2px solid #34d399;
		outline-offset: 2px;
	}

	.bubble-badge {
		display: inline-block;
		width: 18px;
		height: 18px;
		vertical-align: middle;
		margin-right: 3px;
		border-radius: 2px;
	}

	.bubble-user {
		font-weight: 700;
		font-size: 13px;
	}

	.bubble-sep {
		color: #efeff1;
		margin-right: 4px;
	}

	.bubble-text {
		color: #efeff1;
	}

	.bubble-emote {
		display: inline-block;
		height: 1.75em;
		vertical-align: middle;
		margin: -2px 2px;
	}

	.effect-msg-preview {
		background: #1a1a2e;
		padding: 6px 8px;
		border-radius: 4px;
		font-size: 0.7rem;
		color: #ccc;
		line-height: 1.3;
		word-break: break-word;
	}
</style>
