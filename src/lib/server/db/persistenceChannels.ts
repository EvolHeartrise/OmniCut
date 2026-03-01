import { getDb } from './persistenceBase.js';

// --- Ignored Channels ---

export function addIgnoredChannel(login: string): void {
	const d = getDb();
	d.run('INSERT OR IGNORE INTO ignored_channels (login) VALUES (?)', [login.toLowerCase()]);
}

export function removeIgnoredChannel(login: string): void {
	const d = getDb();
	d.run('DELETE FROM ignored_channels WHERE login = ?', [login.toLowerCase()]);
}

export function loadIgnoredChannels(): string[] {
	const d = getDb();
	const rows = d.query('SELECT login FROM ignored_channels ORDER BY ignored_at').all() as { login: string }[];
	return rows.map((r) => r.login);
}

// --- Channel Settings ---

export function getChannelSettings(login: string): { login: string; language: string | null } | null {
	const d = getDb();
	const row = d.query('SELECT login, language FROM channel_settings WHERE login = ?').get(login.toLowerCase()) as {
		login: string;
		language: string | null;
	} | null;
	return row ?? null;
}

export function saveChannelSettings(login: string, language: string | null): void {
	const d = getDb();
	d.run(
		`INSERT INTO channel_settings (login, language, updated_at) VALUES (?, ?, unixepoch())
		 ON CONFLICT(login) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at`,
		[login.toLowerCase(), language]
	);
}

export function loadAllChannelSettings(): { login: string; language: string | null }[] {
	const d = getDb();
	const rows = d.query('SELECT login, language FROM channel_settings ORDER BY login').all() as {
		login: string;
		language: string | null;
	}[];
	return rows;
}

// --- Watchlist ---

export function loadWatchlist(): Array<{ login: string; platform: string }> {
	const d = getDb();
	const rows = d.query('SELECT login, platform FROM watchlist ORDER BY added_at').all() as {
		login: string;
		platform: string;
	}[];
	return rows;
}

export function addToWatchlist(login: string, platform: string): void {
	const d = getDb();
	d.run('INSERT OR IGNORE INTO watchlist (login, platform) VALUES (?, ?)', [login, platform]);
}

export function removeFromWatchlist(login: string, platform: string): void {
	const d = getDb();
	d.run('DELETE FROM watchlist WHERE login = ? AND platform = ?', [login, platform]);
}
