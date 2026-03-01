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
	type: 'chat-message' | 'twitch-chat' | 'zoom' | 'subtitle';
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
	/** Effects track index (0-based, default 0). Higher tracks render on top. */
	track?: number;
	/** For zoom type: start crop region (normalized 0-1). Width = height fraction (aspect-ratio locked). */
	zoomStartX?: number;
	zoomStartY?: number;
	zoomStartW?: number;  // fraction of video width (default 1 = full frame)
	/** For zoom type: end crop region (normalized 0-1). */
	zoomEndX?: number;
	zoomEndY?: number;
	zoomEndW?: number;
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
	/** For subtitle type: entrance animation (default 'none'). */
	subtitleAnimIn?: SubtitleAnimation;
	/** For subtitle type: exit animation (default 'none'). */
	subtitleAnimOut?: SubtitleAnimation;
	/** For subtitle type: animation duration in seconds (default 0.3). */
	subtitleAnimDuration?: number;
}

export type SubtitleAnimation =
	| 'none'
	| 'fade'
	| 'pop'
	| 'slide-up'
	| 'slide-down'
	| 'slide-left'
	| 'slide-right'
	| 'bounce';

/** Per-clip entry in a video composition. */
export interface ClipEntry {
	clipId: string;
	trimStart?: number; // seconds offset into clip to start (default 0)
	trimEnd?: number; // seconds offset from clip end to stop (default 0 = full duration)
	speed?: number; // playback speed multiplier (default 1)
	transition?: 'none' | 'crossfade' | 'fade-black'; // transition INTO this clip
	transitionDuration?: number; // seconds (default 0.5)
}

export type VerticalSlotType = 'full' | 'camera' | 'custom';

export interface VerticalSlot {
	type: VerticalSlotType;
	/** Custom crop region (normalized 0-1). Only used when type === 'custom'. */
	cropX?: number;
	cropY?: number;
	cropW?: number;
	cropH?: number;
}

export interface VerticalLayout {
	top: VerticalSlot;
	bottom: VerticalSlot;
}

/** Video composition — an ordered collection of clips with effects. */
export interface VideoRecord {
	id: string;
	title: string;
	description?: string;
	clipEntries: ClipEntry[];
	format: 'standard' | 'mobile_short';
	effectEntries?: EffectEntry[];
	verticalLayout?: VerticalLayout;
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
	platform: 'twitch' | 'douyu';
}
