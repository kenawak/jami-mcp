import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { CHARACTER_LIMIT, fail, ok } from '../format.js';

export function registerDocsTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'jami_search_docs',
		{
			title: 'Search Jami docs',
			description: `Search the official JamiDev developer docs (${ctx.config.docsUrl}/docs) — the source of truth for integrating Jami payments. Works without an API token.

Use this before writing integration code: SDK usage, REST endpoints, webhooks and signature checks, sandbox magic numbers, Sign in with Jami (OAuth/OIDC), the wallet API, the browser storefront, fees and limits.

Args:
  - query: what you need, e.g. "verify webhook signature express", "pay what you want amount", "withdrawal fee".
  - limit: 1–10 results (default 5).

Returns: { results: [{ title, path, url, snippet }] }. Read a full page with jami_read_doc(path).`,
			inputSchema: z
				.object({
					query: z.string().min(2).max(200),
					limit: z.number().int().min(1).max(10).default(5)
				})
				.strict(),
			outputSchema: {
				results: z.array(
					z.object({ title: z.string(), path: z.string(), url: z.string(), snippet: z.string() })
				)
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ query, limit }) =>
			guard(async () => {
				const hits = await ctx.docs.search(query, limit);
				const results = hits.map(({ title, path, url, snippet }) => ({ title, path, url, snippet }));
				if (results.length === 0) {
					const pages = await ctx.docs.pages();
					return ok(
						{ results },
						`No docs match "${query}". Try fewer or different words. Pages: ${pages.map((p) => `\`${p.path}\``).join(', ')}`
					);
				}
				return ok(
					{ results },
					results.map((r, i) => `${i + 1}. **${r.title}** — \`${r.path}\`\n   ${r.snippet}`).join('\n\n') +
						'\n\nRead a page with `jami_read_doc`.'
				);
			})
	);

	server.registerTool(
		'jami_read_doc',
		{
			title: 'Read Jami doc page',
			description: `Read one JamiDev docs page as markdown, with every code sample intact.

Args:
  - path: a docs path from jami_search_docs, e.g. "/docs/webhooks", "api/checkout", or a full URL. Use "/docs" for the overview.
  - offset: character offset for long pages (default 0); the result says where to continue.

Returns: { title, url, markdown, offset, next_offset? }.`,
			inputSchema: z
				.object({
					path: z.string().min(1).max(300),
					offset: z.number().int().min(0).default(0)
				})
				.strict(),
			outputSchema: {
				title: z.string(),
				url: z.string(),
				markdown: z.string(),
				offset: z.number().int(),
				next_offset: z.number().int().optional()
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ path, offset }) =>
			guard(async () => {
				const page = await ctx.docs.get(path);
				if (!page) {
					const pages = await ctx.docs.pages();
					return fail(
						`No docs page at "${path}". Available: ${pages.map((p) => `\`${p.path}\``).join(', ')}`
					);
				}
				const end = offset + CHARACTER_LIMIT - 500;
				const markdown = page.markdown.slice(offset, end);
				const more = end < page.markdown.length;
				const structured = {
					title: page.title,
					url: page.url,
					markdown,
					offset,
					...(more ? { next_offset: end } : {})
				};
				return {
					content: [
						{
							type: 'text',
							text: `# ${page.title}\n<${page.url}>\n\n${markdown}${more ? `\n\n…continues — call again with offset=${end}.` : ''}`
						}
					],
					structuredContent: structured
				};
			})
	);
}
