/**
 * Live index over the JamiDev docs, built from `/llms-full.txt` (every page's
 * markdown in one file, each page headed `# Title (/docs/slug)`). One fetch,
 * cached, so search is instant and always matches the published docs.
 */

export interface DocPage {
	title: string;
	/** Site path, e.g. `/docs/webhooks`. */
	path: string;
	url: string;
	markdown: string;
}

export interface DocHit {
	title: string;
	path: string;
	url: string;
	score: number;
	snippet: string;
}

const PAGE_HEADER = /^# (.+?) \((\/docs[^)\s]*)\)\s*$/gm;
const TTL_MS = 10 * 60 * 1000;
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'how', 'do', 'i', 'my', 'with', 'what', 'jami', 'jamidev']);

const terms = (q: string) =>
	q
		.toLowerCase()
		.split(/[^a-z0-9_.@-]+/)
		.filter((t) => t.length > 1 && !STOP.has(t));

function count(haystack: string, needle: string): number {
	let n = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
	return n;
}

function snippet(markdown: string, words: string[], width = 280): string {
	const lower = markdown.toLowerCase();
	const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
	const start = Math.max(0, markdown.lastIndexOf('\n', Math.max(0, at - width / 3)) + 1);
	const text = markdown.slice(start, start + width).replace(/\s+/g, ' ').trim();
	return `${start > 0 ? '…' : ''}${text}${start + width < markdown.length ? '…' : ''}`;
}

export class DocsIndex {
	#pages: DocPage[] | undefined;
	#fetchedAt = 0;
	#inflight: Promise<DocPage[]> | undefined;

	constructor(
		readonly origin: string,
		private readonly fetchImpl: typeof fetch
	) {}

	async pages(): Promise<DocPage[]> {
		if (this.#pages && Date.now() - this.#fetchedAt < TTL_MS) return this.#pages;
		this.#inflight ??= this.#load().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	async #load(): Promise<DocPage[]> {
		const url = `${this.origin}/llms-full.txt`;
		let res: Response;
		try {
			res = await this.fetchImpl(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(15_000) });
		} catch (err) {
			// Serve stale docs over no docs when the site is briefly unreachable.
			if (this.#pages) return this.#pages;
			throw new Error(`Couldn't load the JamiDev docs from ${url}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!res.ok) {
			if (this.#pages) return this.#pages;
			throw new Error(`Couldn't load the JamiDev docs from ${url} (HTTP ${res.status})`);
		}
		const text = await res.text();
		const headers = [...text.matchAll(PAGE_HEADER)];
		const pages = headers.map((m, i) => {
			const bodyStart = (m.index ?? 0) + m[0].length;
			const bodyEnd = headers[i + 1]?.index ?? text.length;
			const path = m[2] ?? '/docs';
			return {
				title: m[1] ?? path,
				path,
				url: `${this.origin}${path}`,
				markdown: text.slice(bodyStart, bodyEnd).trim()
			};
		});
		this.#pages = pages;
		this.#fetchedAt = Date.now();
		return pages;
	}

	async search(query: string, limit: number): Promise<DocHit[]> {
		const words = terms(query);
		if (words.length === 0) return [];
		const phrase = query.toLowerCase().trim();
		const hits = (await this.pages())
			.map((p) => {
				const title = p.title.toLowerCase();
				const body = p.markdown.toLowerCase();
				const headings = (p.markdown.match(/^#{2,4} .+$/gm) ?? []).join('\n').toLowerCase();
				let score = 0;
				for (const w of words) {
					score += count(title, w) * 8 + count(headings, w) * 4 + Math.min(count(body, w), 12);
				}
				if (words.length > 1 && body.includes(phrase)) score += 10;
				return { page: p, score };
			})
			.filter((h) => h.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
		return hits.map(({ page, score }) => ({
			title: page.title,
			path: page.path,
			url: page.url,
			score,
			snippet: snippet(page.markdown, words)
		}));
	}

	/** Accepts `/docs/api/checkout`, `api/checkout`, a full URL, or a `.md` URL. */
	async get(pathOrSlug: string): Promise<DocPage | undefined> {
		let path = pathOrSlug.trim();
		try {
			path = new URL(path).pathname;
		} catch {
			/* not a URL */
		}
		path = path.replace(/\.md$/, '').replace(/\/+$/, '');
		if (!path.startsWith('/docs')) path = `/docs/${path.replace(/^\/+/, '')}`;
		path = path.replace(/\/+$/, '') || '/docs';
		const pages = await this.pages();
		return pages.find((p) => p.path === path);
	}
}
