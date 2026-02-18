import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

interface ChannelInfo {
	login: string;
	displayName: string | null;
	profileImageUrl: string | null;
	isLive: boolean;
	title: string | null;
	viewerCount: number | null;
	startedAt: string | null;
}

const CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';

const GQL_QUERY = `query($login: String!) {
	user(login: $login) {
		displayName
		profileImageURL(width: 70)
		stream {
			viewersCount
			title
			createdAt
		}
	}
}`;

async function fetchChannel(login: string): Promise<ChannelInfo> {
	try {
		const res = await fetch('https://gql.twitch.tv/gql', {
			method: 'POST',
			headers: {
				'Client-ID': CLIENT_ID,
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
				viewerCount: null,
				startedAt: null
			};
		}
		const stream = user.stream;
		return {
			login,
			displayName: user.displayName ?? null,
			profileImageUrl: user.profileImageURL ?? null,
			isLive: !!stream,
			title: stream?.title ?? null,
			viewerCount: stream?.viewersCount ?? null,
			startedAt: stream?.createdAt ?? null
		};
	} catch {
		return {
			login,
			displayName: null,
			profileImageUrl: null,
			isLive: false,
			title: null,
			viewerCount: null,
			startedAt: null
		};
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const channels: string[] = body.channels;

	if (!Array.isArray(channels) || channels.length === 0) {
		return json({ channels: [] });
	}

	const results = await Promise.all(channels.map(fetchChannel));
	return json({ channels: results });
};
