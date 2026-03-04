/** Clip region marked on the timeline. */
export interface ClipRegion {
	id: string;
	streamId: string;
	startTime: number; // master time (epoch seconds)
	endTime: number; // master time (epoch seconds)
	createdBy?: 'human' | 'ai'; // who created this clip (default: human)
	title?: string; // short clip label
	notes?: string; // longer description/context
	favourite?: boolean; // user-marked favourite
}

/** Per-channel camera bounds at a point in time. */
export interface CameraBoundsEntry {
	id: number;
	channel: string;
	timestamp: number; // master time (epoch seconds)
	camX: number; // normalized 0-1
	camY: number;
	camW: number;
	camH: number;
}

/** An effect placed on the composition timeline. */
export interface EffectEntry {
	id: string;               // unique ID (nanoid)
	type: 'chat-message' | 'twitch-chat' | 'subtitle' | 'image' | 'audio' | 'view' | 'zoom-pan' | 'silence';
	/** Composition-time start (seconds from composition start). */
	startTime: number;
	/** Duration the effect is visible (seconds). */
	duration: number;
	/** Normalized position on video (0-1). */
	x: number;
	y: number;
	/** For chat-message type: Twitch message ID. */
	twitchId?: string;
	/** For twitch-chat type: panel width in pixels (default 340). */
	panelWidth?: number;
	/** For twitch-chat type: panel height in pixels (default 1080). */
	panelHeight?: number;
	/** For twitch-chat type: shift the chat timeline in seconds (default 0). */
	chatOffset?: number;
	/** For twitch-chat type: uniform scale multiplier (default 1). */
	chatScale?: number;
	/** For twitch-chat type: CSS font-weight for chat text (default 400). */
	chatFontWeight?: number;
	/** For twitch-chat type: DB IDs of chat messages to hide from the panel. */
	chatIgnoredIds?: number[];
	/** Effects track index (0-based, default 0). Higher tracks render on top. */
	track?: number;
	/** For view type: preset source region ('full' = entire frame, 'camera' = webcam bounds). Omit for custom/animated. */
	viewSourceType?: 'full' | 'camera';
	/** For view type: animated source crop start region (normalized 0-1). */
	viewSourceStartX?: number;
	viewSourceStartY?: number;
	viewSourceStartW?: number;
	viewSourceStartH?: number;
	/** For view type: animated source crop end region (normalized 0-1). */
	viewSourceEndX?: number;
	viewSourceEndY?: number;
	viewSourceEndW?: number;
	viewSourceEndH?: number;
	/** For view type: destination rect on output canvas (normalized 0-1). */
	viewDestX?: number;
	viewDestY?: number;
	viewDestW?: number;
	viewDestH?: number;
	/** For view type: z-order for layering when views overlap (default 0). */
	viewZOrder?: number;
	/** For view type: which video track to source from (default 0 = primary track). */
	viewSourceTrack?: number;
	/** For subtitle type: the text to display. */
	subtitleText?: string;
	/** For subtitle type: font size in pixels (default 48). */
	subtitleFontSize?: number;
	/** For subtitle type: font color as CSS color string (default '#FFFFFF'). */
	subtitleFontColor?: string;
	/** For subtitle type: text outline/stroke color (default '#000000'). */
	subtitleOutlineColor?: string;
	/** For subtitle type: text outline width in pixels (default 4). */
	subtitleOutlineWidth?: number;
	/** For subtitle type: CSS font-weight (default 700). */
	subtitleFontWeight?: number;
	/** For subtitle type: maximum width in pixels (default 900). */
	subtitleMaxWidth?: number;
	/** For subtitle type: text alignment (default 'center'). */
	subtitleTextAlign?: 'left' | 'center' | 'right';
	/** For subtitle type: font family (default 'Inter'). */
	subtitleFontFamily?: string;
	/** For image type: ID of the uploaded image (filename in data/overlays/). */
	imageId?: string;
	/** For image type: display scale multiplier (default 1). */
	imageScale?: number;
	/** For image type: opacity 0-1 (default 1). */
	imageOpacity?: number;
	/** For image type: natural width in pixels (stored on upload). */
	imageWidth?: number;
	/** For image type: natural height in pixels (stored on upload). */
	imageHeight?: number;
	/** For audio type: ID of the uploaded audio file (filename in data/audio/). */
	audioId?: string;
	/** For audio type: volume level 0-1 (default 1). */
	audioVolume?: number;
	/** For audio type: natural duration in seconds (stored on upload). */
	audioDuration?: number;
	/** For audio type: start offset into the audio file in seconds (default 0). */
	audioOffset?: number;
	/** For zoom-pan type: start zoom level (1 = no zoom, >1 = zoom in). Default 1. */
	zoomStartScale?: number;
	/** For zoom-pan type: end zoom level. Default 1.5. */
	zoomEndScale?: number;
	/** For zoom-pan type: start pan center X (0-1, 0.5 = center). Default 0.5. */
	zoomStartX?: number;
	/** For zoom-pan type: start pan center Y. Default 0.5. */
	zoomStartY?: number;
	/** For zoom-pan type: end pan center X. Default 0.5. */
	zoomEndX?: number;
	/** For zoom-pan type: end pan center Y. Default 0.5. */
	zoomEndY?: number;
	/** For zoom-pan type: easing for zoom/pan interpolation. Default 'linear'. */
	zoomEasing?: EasingFunction;
	/** When true, overlay is composited AFTER zoom-pan (stays fixed on screen). Default false (zooms with video). */
	drawAfterZoom?: boolean;
	/** Entrance animation for overlay effects (default 'none'). */
	animIn?: OverlayAnimation;
	/** Exit animation for overlay effects (default 'none'). */
	animOut?: OverlayAnimation;
	/** Animation duration in seconds (default 0.3). */
	animDuration?: number;
	/** Easing function for entrance animation (default 'ease-out'). */
	animInEasing?: EasingFunction;
	/** Easing function for exit animation (default 'ease-in'). */
	animOutEasing?: EasingFunction;
	/** Optional drop shadow for overlay effects. */
	shadow?: {
		color: string;      // CSS color, e.g. 'rgba(0,0,0,0.8)'
		blur: number;       // blur radius in pixels
		offsetX: number;    // horizontal offset in pixels
		offsetY: number;    // vertical offset in pixels
	};
}

export type OverlayAnimation =
	| 'none'
	| 'fade'
	| 'grow'
	| 'shrink'
	| 'slide-up'
	| 'slide-down'
	| 'slide-left'
	| 'slide-right';

export type EasingFunction =
	| 'linear'
	| 'ease-in'
	| 'ease-out'
	| 'ease-in-out'
	| 'bounce';

/** Per-clip entry in a video composition. */
export interface ClipEntry {
	clipId: string;
	trimStart?: number; // seconds offset into clip to start (default 0)
	trimEnd?: number; // seconds offset from clip end to stop (default 0 = full duration)
	transition?: 'none' | 'crossfade' | 'fade-black'; // transition INTO this clip
	transitionDuration?: number; // seconds (default 0.5)
	track?: number; // video track index (default 0 = primary sequential track)
	startTime?: number; // absolute composition-time position (seconds); tracks 1+ only
}

/** Video composition — an ordered collection of clips with effects. */
export interface VideoRecord {
	id: string;
	title: string;
	description?: string;
	clipEntries: ClipEntry[];
	effectEntries?: EffectEntry[];
	createdAt: number;
	updatedAt: number;
}

/** VOD info returned by the channel vods API. */
export interface VodInfo {
	id: string;
	title: string | null;
	createdAt: string | null;
	durationSeconds: number | null;
	thumbnailUrl: string | null;
	viewCount: number | null;
}

/** Channel info returned by the lookup API. */
export interface ChannelInfo {
	login: string;
	displayName: string | null;
	profileImageUrl: string | null;
	isLive: boolean;
	title: string | null;
	gameName: string | null;
	viewerCount: number | null;
	startedAt: string | null;
	hasVod: boolean;
	platform: 'twitch';
}
