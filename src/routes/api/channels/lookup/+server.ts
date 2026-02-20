import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ChannelInfo } from '$lib/types.js';
import { TWITCH_CLIENT_ID } from '$lib/server/twitchApi.js';

const GQL_QUERY = `query($login: String!) {
	user(login: $login) {
		displayName
		profileImageURL(width: 70)
		stream {
			viewersCount
			title
			game { name }
			createdAt
			archiveVideo { id }
		}
	}
}`;

async function fetchChannel(login: string): Promise<ChannelInfo> {
	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: {
				'Client-ID': TWITCH_CLIENT_ID,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				query: GQL_QUERY,
				variables: { login }
			})
		});
		const data = await res.json();
		const user = data?.data?.user;
		if (!user) {
			return {
				login,
				displayName: null,
				profileImageUrl: null,
				isLive: false,
				title: null,
				gameName: null,
				viewerCount: null,
				startedAt: null,
				hasVod: false,
				platform: 'twitch'
			};
		}
		const stream = user.stream;
		return {
			login,
			displayName: user.displayName ?? null,
			profileImageUrl: user.profileImageURL ?? null,
			isLive: !!stream,
			title: stream?.title ?? null,
			gameName: stream?.game?.name ?? null,
			viewerCount: stream?.viewersCount ?? null,
			startedAt: stream?.createdAt ?? null,
			hasVod: !!stream?.archiveVideo?.id,
			platform: 'twitch'
		};
	} catch {
		return {
			login,
			displayName: null,
			profileImageUrl: null,
			isLive: false,
			title: null,
			gameName: null,
			viewerCount: null,
			startedAt: null,
			hasVod: false,
			platform: 'twitch'
		};
	}
}

async function fetchDouyuChannel(roomId: string): Promise<ChannelInfo> {
	try {
		const res = await fetch(`https://open.douyucdn.cn/api/RoomApi/room/${roomId}`);
		const data = await res.json();
		const room = data?.data;
		if (!room) {
			return {
				login: roomId,
				displayName: null,
				profileImageUrl: null,
				isLive: false,
				title: null,
				gameName: null,
				viewerCount: null,
				startedAt: null,
				hasVod: false,
				platform: 'douyu'
			};
		}
		const isLive = String(room.room_status) === '1';
		return {
			login: roomId,
			displayName: room.owner_name ?? null,
			profileImageUrl: room.avatar ?? null,
			isLive,
			title: room.room_name ?? null,
			gameName: room.cate_name ?? null,
			viewerCount: room.online ?? null,
			startedAt: isLive && room.start_time ? new Date(room.start_time + '+08:00').toISOString() : null,
			hasVod: false,
			platform: 'douyu'
		};
	} catch {
		return {
			login: roomId,
			displayName: null,
			profileImageUrl: null,
			isLive: false,
			title: null,
			gameName: null,
			viewerCount: null,
			startedAt: null,
			hasVod: false,
			platform: 'douyu'
		};
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const channels: string[] = body.channels;
	const platform: string = body.platform || 'twitch';

	if (!Array.isArray(channels) || channels.length === 0) {
		return json({ channels: [] });
	}

	const fetcher = platform === 'douyu' ? fetchDouyuChannel : fetchChannel;
	const results = await Promise.all(channels.map(fetcher));
	return json({ channels: results });
};
