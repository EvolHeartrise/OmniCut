/** Clip region marked by the user on the timeline. */
export interface ClipRegion {
	id: string;
	streamId: string;
	startTime: number; // master time (epoch seconds)
	endTime: number;   // master time (epoch seconds)
}

/** Twitch channel info returned by the lookup API. */
export interface ChannelInfo {
	login: string;
	displayName: string | null;
	profileImageUrl: string | null;
	isLive: boolean;
	title: string | null;
	gameName: string | null;
	viewerCount: number | null;
	startedAt: string | null;
}
