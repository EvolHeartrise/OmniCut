/**
 * YouTube API client module (multi-account).
 * Wraps googleapis for OAuth2, video upload, playlists, and categories.
 * Each function takes an accountId and builds a per-account OAuth2 client.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import * as fs from 'node:fs';
import { newYouTubeAccountId } from '../ids.js';
import * as db from './db/index.js';
import type { YouTubeAccount } from './db/index.js';

// --- Environment ---

function getClientId(): string {
	return process.env.YOUTUBE_CLIENT_ID ?? '';
}

function getClientSecret(): string {
	return process.env.YOUTUBE_CLIENT_SECRET ?? '';
}

function getRedirectUri(): string {
	return process.env.YOUTUBE_REDIRECT_URI ?? 'http://localhost:5173/api/youtube/callback';
}

/** Check if YouTube integration is configured (env vars present). */
export function isConfigured(): boolean {
	return !!(getClientId() && getClientSecret());
}

// --- OAuth2 client factory ---

function createBaseOAuth2Client(): OAuth2Client {
	return new google.auth.OAuth2(getClientId(), getClientSecret(), getRedirectUri());
}

/**
 * Build an OAuth2Client pre-loaded with an account's tokens.
 * Attaches an `on('tokens')` listener to auto-persist refreshed tokens.
 */
export function getOAuth2ClientForAccount(accountId: string): OAuth2Client {
	const account = db.loadYouTubeAccount(accountId);
	if (!account) throw new Error(`YouTube account not found: ${accountId}`);

	const client = createBaseOAuth2Client();
	client.setCredentials({
		access_token: account.accessToken,
		refresh_token: account.refreshToken,
		expiry_date: account.expiryDate,
		scope: account.scope,
		token_type: account.tokenType
	});

	// Auto-persist refreshed tokens
	client.on('tokens', (tokens) => {
		db.updateYouTubeAccountTokens(
			accountId,
			tokens.access_token!,
			tokens.expiry_date!,
			tokens.refresh_token ?? undefined
		);
	});

	return client;
}

// --- Auth flow ---

/** Generate a Google consent URL for connecting a new account. */
export function getAuthUrl(): string {
	const client = createBaseOAuth2Client();
	return client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: [
			'https://www.googleapis.com/auth/youtube.upload',
			'https://www.googleapis.com/auth/youtube.readonly'
		]
	});
}

/**
 * Exchange an authorization code for tokens, fetch channel info,
 * and save (or update) the YouTube account.
 */
export async function handleAuthCallback(code: string): Promise<YouTubeAccount> {
	const client = createBaseOAuth2Client();
	const { tokens } = await client.getToken(code);
	client.setCredentials(tokens);

	// Fetch channel info
	const youtube = google.youtube({ version: 'v3', auth: client });
	const channelRes = await youtube.channels.list({
		part: ['snippet'],
		mine: true
	});

	const channel = channelRes.data.items?.[0];
	if (!channel) throw new Error('No YouTube channel found for this account');

	const channelId = channel.id!;
	const channelName = channel.snippet?.title ?? 'Unknown';
	const channelThumbnail = channel.snippet?.thumbnails?.medium?.url
		?? channel.snippet?.thumbnails?.default?.url
		?? undefined;

	// Check if this channel is already connected
	const existing = db.loadYouTubeAccountByChannelId(channelId);
	const now = Math.floor(Date.now() / 1000);

	if (existing) {
		// Update tokens for existing account
		db.updateYouTubeAccountTokens(
			existing.id,
			tokens.access_token!,
			tokens.expiry_date!,
			tokens.refresh_token ?? undefined
		);
		const updated = db.loadYouTubeAccount(existing.id)!;
		return updated;
	}

	// Create new account
	const account: YouTubeAccount = {
		id: newYouTubeAccountId(),
		channelId,
		channelName,
		...(channelThumbnail && { channelThumbnail }),
		accessToken: tokens.access_token!,
		refreshToken: tokens.refresh_token!,
		expiryDate: tokens.expiry_date!,
		...(tokens.scope && { scope: tokens.scope }),
		tokenType: tokens.token_type ?? 'Bearer',
		createdAt: now,
		updatedAt: now
	};

	db.saveYouTubeAccount(account);
	return account;
}

// --- YouTube Data API ---

/** Fetch video categories for a region. */
export async function getVideoCategories(regionCode = 'US'): Promise<Array<{ id: string; title: string }>> {
	const client = createBaseOAuth2Client();
	// Categories endpoint doesn't require user auth, but needs an API key or OAuth client
	client.setCredentials({ access_token: '' });
	const youtube = google.youtube({ version: 'v3', auth: client });

	try {
		const res = await youtube.videoCategories.list({
			part: ['snippet'],
			regionCode,
			key: getClientId() // fallback — may not work without proper API key
		});
		return (res.data.items ?? [])
			.filter((c) => c.snippet?.assignable)
			.map((c) => ({ id: c.id!, title: c.snippet!.title! }));
	} catch {
		// If unauthenticated call fails, try with first available account
		const accounts = db.loadAllYouTubeAccounts();
		if (accounts.length === 0) return [];
		const authClient = getOAuth2ClientForAccount(accounts[0].id);
		const yt = google.youtube({ version: 'v3', auth: authClient });
		const res = await yt.videoCategories.list({
			part: ['snippet'],
			regionCode
		});
		return (res.data.items ?? [])
			.filter((c) => c.snippet?.assignable)
			.map((c) => ({ id: c.id!, title: c.snippet!.title! }));
	}
}

/** Fetch playlists for a specific account. */
export async function getUserPlaylists(
	accountId: string
): Promise<Array<{ id: string; title: string; itemCount: number }>> {
	const client = getOAuth2ClientForAccount(accountId);
	const youtube = google.youtube({ version: 'v3', auth: client });

	const playlists: Array<{ id: string; title: string; itemCount: number }> = [];
	let pageToken: string | undefined;

	do {
		const res = await youtube.playlists.list({
			part: ['snippet', 'contentDetails'],
			mine: true,
			maxResults: 50,
			pageToken
		});

		for (const item of res.data.items ?? []) {
			playlists.push({
				id: item.id!,
				title: item.snippet?.title ?? 'Untitled',
				itemCount: item.contentDetails?.itemCount ?? 0
			});
		}

		pageToken = res.data.nextPageToken ?? undefined;
	} while (pageToken);

	return playlists;
}

/**
 * Get a valid access token for an account, refreshing if needed.
 */
async function getAccessToken(accountId: string): Promise<string> {
	const client = getOAuth2ClientForAccount(accountId);
	const { token } = await client.getAccessToken();
	if (!token) throw new Error('Failed to get access token');
	return token;
}

// 8 MiB upload chunks — must be a multiple of 256 KiB per YouTube API spec
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Upload a video to YouTube using the resumable upload protocol directly
 * via fetch + chunked file reads. Avoids googleapis/gaxios streaming which
 * causes Bun to buffer the entire file in memory and crash.
 */
export async function uploadVideo(
	accountId: string,
	filePath: string,
	metadata: {
		title: string;
		description?: string;
		privacy?: string;
		tags?: string[];
		categoryId?: string;
	},
	onProgress?: (progress: number) => void
): Promise<string> {
	const accessToken = await getAccessToken(accountId);
	const fileSize = fs.statSync(filePath).size;

	// Step 1: Initiate resumable upload session
	const initUrl = new URL('https://www.googleapis.com/upload/youtube/v3/videos');
	initUrl.searchParams.set('uploadType', 'resumable');
	initUrl.searchParams.set('part', 'snippet,status');

	const body = {
		snippet: {
			title: metadata.title,
			description: metadata.description ?? '',
			tags: metadata.tags,
			categoryId: metadata.categoryId
		},
		status: {
			privacyStatus: metadata.privacy ?? 'private',
			selfDeclaredMadeForKids: false
		}
	};

	const initRes = await fetch(initUrl.toString(), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json; charset=UTF-8',
			'X-Upload-Content-Length': String(fileSize),
			'X-Upload-Content-Type': 'video/mp4'
		},
		body: JSON.stringify(body)
	});

	if (!initRes.ok) {
		const errText = await initRes.text();
		throw new Error(`Failed to initiate upload (${initRes.status}): ${errText}`);
	}

	const uploadUrl = initRes.headers.get('location');
	if (!uploadUrl) throw new Error('No upload URL returned from resumable init');

	// Step 2: Upload file in chunks
	const fd = fs.openSync(filePath, 'r');
	try {
		let offset = 0;
		while (offset < fileSize) {
			const chunkSize = Math.min(UPLOAD_CHUNK_SIZE, fileSize - offset);
			const buffer = Buffer.alloc(chunkSize);
			fs.readSync(fd, buffer, 0, chunkSize, offset);

			const rangeEnd = offset + chunkSize - 1;
			const contentRange = `bytes ${offset}-${rangeEnd}/${fileSize}`;

			const chunkRes = await fetch(uploadUrl, {
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Length': String(chunkSize),
					'Content-Type': 'video/mp4',
					'Content-Range': contentRange
				},
				body: buffer
			});

			if (chunkRes.status === 308) {
				// Incomplete — keep going
				offset += chunkSize;
				if (onProgress && fileSize > 0) {
					onProgress(Math.min(offset / fileSize, 0.99));
				}
				continue;
			}

			if (chunkRes.ok) {
				// Upload complete
				const data = (await chunkRes.json()) as { id?: string };
				if (!data.id) throw new Error('Upload succeeded but no video ID returned');
				onProgress?.(1);
				return data.id;
			}

			// Error
			const errText = await chunkRes.text();
			throw new Error(`Upload chunk failed (${chunkRes.status}): ${errText}`);
		}

		throw new Error('Upload loop ended without completion');
	} finally {
		fs.closeSync(fd);
	}
}

/** Add a video to a playlist. */
export async function addToPlaylist(
	accountId: string,
	videoId: string,
	playlistId: string
): Promise<void> {
	const client = getOAuth2ClientForAccount(accountId);
	const youtube = google.youtube({ version: 'v3', auth: client });

	await youtube.playlistItems.insert({
		part: ['snippet'],
		requestBody: {
			snippet: {
				playlistId,
				resourceId: {
					kind: 'youtube#video',
					videoId
				}
			}
		}
	});
}
