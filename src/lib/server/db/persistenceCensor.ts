import { getDb } from './persistenceBase.js';

export function loadAllCensorTerms(): string[] {
	const d = getDb();
	const rows = d.query('SELECT term FROM censor_terms ORDER BY added_at').all() as { term: string }[];
	return rows.map((r) => r.term.toLowerCase());
}

export function addCensorTerm(term: string): void {
	const d = getDb();
	d.run(
		'INSERT OR IGNORE INTO censor_terms (term) VALUES (?)',
		[term.trim().toLowerCase()]
	);
}

export function removeCensorTerm(term: string): void {
	const d = getDb();
	d.run('DELETE FROM censor_terms WHERE term = ? COLLATE NOCASE', [term.trim()]);
}

export function clearCensorTerms(): void {
	const d = getDb();
	d.run('DELETE FROM censor_terms');
}
