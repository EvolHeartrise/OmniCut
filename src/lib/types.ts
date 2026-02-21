/** Clip region marked on the timeline. */
export interface ClipRegion {
	id: string;
	streamId: string;
	startTime: number; // master time (epoch seconds)
	endTime: number;   // master time (epoch seconds)
	createdBy?: 'human' | 'ai'; // who created this clip (default: human)
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
