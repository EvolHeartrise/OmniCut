/**
 * Shared types for the video export pipeline.
 * All exporter modules import types from here to avoid circular dependencies.
 */

import type { ClipRegion, ClipEntry, OverlayAnimation, EasingFunction } from '../types.js';
import type { FrameSink } from './chatEffectRenderer.js';

/** A clip on a non-zero video track with its composition position. */
export interface OtherTrackClip {
	clip: ClipRegion;
	entry?: ClipEntry;
	track: number;
	compStart: number; // composition-time start (seconds)
	compEnd: number;   // composition-time end (seconds)
}

/** Resolved stream info needed for encoding a clip from raw segments. */
export interface StreamLookup {
	recordingDir: string;
	startedAt: number;
	offset: number;
}

export interface ShadowConfig {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

export interface ResolvedEffect {
	pngPath?: string;    // for chat-message (static PNG)
	videoPath?: string;  // for twitch-chat (raw RGBA or encoded video)
	x: number;
	y: number;
	localStart: number;
	localEnd: number;
	scale?: number;      // uniform scale multiplier (default 1)
	/** If set, videoPath is a raw RGBA file — needs explicit format args on input. */
	rawVideo?: { width: number; height: number; fps: number };
	/** Rendered overlay dimensions (used to compute animation slide distances). */
	overlayWidth: number;
	overlayHeight: number;
	/** In/out animation config — set when the effect has non-none animations. */
	animation?: {
		animIn: OverlayAnimation;
		animOut: OverlayAnimation;
		animDuration: number;
		animInEasing: EasingFunction;
		animOutEasing: EasingFunction;
		width: number;   // rendered overlay width (for slide calculations)
		height: number;  // rendered overlay height
	};
	/** Deferred frame renderer — streams raw RGBA to a pipe instead of reading from a file. */
	deferredRender?: (sink: FrameSink) => Promise<void>;
	/** When true, overlay is composited AFTER zoom-pan (stays fixed on screen). */
	drawAfterZoom?: boolean;
}

/** Info about a clip needed for resolving twitch-chat effects. */
export interface ClipContext {
	streamId: string;
	channel: string;
	/** Stream-local start time (seconds since capture startedAt). */
	streamLocalStart: number;
	/** Stream-local end time. */
	streamLocalEnd: number;
}

export interface ResolvedView {
	localStart: number;
	localEnd: number;
	/** Source type: 'full', 'camera', or undefined for custom/animated */
	sourceType?: 'full' | 'camera';
	/** Animated source crop (normalized 0-1) */
	srcStartX: number; srcStartY: number; srcStartW: number; srcStartH: number;
	srcEndX: number; srcEndY: number; srcEndW: number; srcEndH: number;
	/** Destination rect on output canvas (normalized 0-1) */
	destX: number; destY: number; destW: number; destH: number;
	/** Z-order for layering */
	zOrder: number;
	/** Which video track to source from (default 0 = primary track) */
	sourceTrack: number;
}

export interface ResolvedZoomPan {
	localStart: number;
	localEnd: number;
	startScale: number;
	endScale: number;
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	easing: EasingFunction;
}
