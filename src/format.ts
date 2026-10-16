import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** Upper bound on a tool's text payload, so one call can't flood the model's context. */
export const CHARACTER_LIMIT = 25_000;

export const ResponseFormat = z
	.enum(['markdown', 'json'])
	.default('markdown')
	.describe("'markdown' (default) for a readable summary, 'json' for the full structured payload");
export type ResponseFormat = z.infer<typeof ResponseFormat>;

const etb = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `123456` santim → `"1,234.56 ETB"`. */
export function formatEtb(minor: number | null | undefined): string {
	if (minor === null || minor === undefined || !Number.isFinite(minor)) return '—';
	return `${etb.format(minor / 100)} ETB`;
}

/** `0.07` → `"7%"`, `0.075` → `"7.5%"` (no float noise). */
export function formatPercent(rate: number): string {
	return `${Number((rate * 100).toFixed(2))}%`;
}

/** ISO timestamp → `"2026-10-16 09:30 UTC"`, or `—`. */
export function formatDate(iso: string | null | undefined): string {
	if (!iso) return '—';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return String(iso);
	return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Keep a string under `limit`, cutting at a line boundary and saying so. */
export function truncate(text: string, limit = CHARACTER_LIMIT, hint = ''): string {
	if (text.length <= limit) return text;
	const cut = text.lastIndexOf('\n', limit);
	const body = text.slice(0, cut > limit / 2 ? cut : limit);
	return `${body}\n\n…truncated (${text.length - body.length} more characters).${hint ? ` ${hint}` : ''}`;
}

/**
 * A successful tool result: `structuredContent` always carries the typed payload;
 * the text block is either the markdown summary or the same payload as JSON.
 */
export function ok<T extends Record<string, unknown>>(
	structured: T,
	markdown: string,
	format: ResponseFormat = 'markdown',
	truncateHint?: string
): CallToolResult {
	const text = format === 'json' ? JSON.stringify(structured, null, 2) : markdown;
	return {
		content: [{ type: 'text', text: truncate(text, CHARACTER_LIMIT, truncateHint) }],
		structuredContent: structured
	};
}

/** A tool-level error the model can read and act on (not a protocol error). */
export function fail(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Markdown table from rows; cells are escaped so a `|` in data can't break the layout. */
export function table(headers: string[], rows: string[][]): string {
	const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	return [
		`| ${headers.join(' | ')} |`,
		`| ${headers.map(() => '---').join(' | ')} |`,
		...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)
	].join('\n');
}

/** Shared pagination shape for list tools. */
export function pageInfo(total: number, page: number, limit: number, count: number) {
	const hasMore = (page - 1) * limit + count < total;
	return {
		total,
		page,
		limit,
		count,
		has_more: hasMore,
		...(hasMore ? { next_page: page + 1 } : {})
	};
}

export const PageInfoShape = {
	total: z.number().int().describe('Total matching records'),
	page: z.number().int(),
	limit: z.number().int(),
	count: z.number().int().describe('Records in this page'),
	has_more: z.boolean(),
	next_page: z.number().int().optional().describe('Pass as `page` to fetch the next page')
};
