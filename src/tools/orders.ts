import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JamiOrder } from 'jami-sdk';
import { z } from 'zod';
import { modeLabel, type ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { formatDate, formatEtb, ok, pageInfo, PageInfoShape, ResponseFormat, table } from '../format.js';

function toOrder(o: JamiOrder) {
	// `productId` / `customerId` come back populated objects, bare ids, or null.
	const product = o.productId && typeof o.productId === 'object' ? o.productId : null;
	const customer = o.customerId && typeof o.customerId === 'object' ? o.customerId : null;
	return {
		order_id: String(o._id),
		status: o.status,
		amount_minor: o.amount,
		amount: formatEtb(o.amount),
		product: {
			id: product?._id ?? (typeof o.productId === 'string' ? o.productId : null),
			...(product?.title ? { title: product.title } : {})
		},
		customer: {
			id: customer?._id ?? (typeof o.customerId === 'string' ? o.customerId : null),
			...(customer?.email ? { email: customer.email } : {}),
			...(customer?.name ? { name: customer.name } : {})
		},
		paid_at: o.paidAt ?? null,
		created_at: o.createdAt ?? null,
		...(o.environment ? { environment: o.environment } : {}),
		...(o.metadata && Object.keys(o.metadata).length ? { metadata: o.metadata } : {})
	};
}

const OrderShape = z.object({
	order_id: z.string(),
	status: z.enum(['pending', 'paid', 'failed']),
	amount_minor: z.number().int(),
	amount: z.string(),
	product: z.object({ id: z.string().nullable(), title: z.string().optional() }),
	customer: z.object({ id: z.string().nullable(), email: z.string().optional(), name: z.string().optional() }),
	paid_at: z.string().nullable(),
	created_at: z.string().nullable(),
	environment: z.enum(['sandbox', 'production']).optional(),
	metadata: z.record(z.string(), z.string()).optional()
});

export function registerOrderTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'jami_list_orders',
		{
			title: 'List orders',
			description: `List the organization's orders, newest first, one page at a time.

Args:
  - status: 'paid' | 'pending' | 'failed' (optional filter).
  - page: 1-based page (default 1).
  - limit: 1–100 per page (default 20).

Returns: { orders: [{ order_id, status, amount_minor, amount, product: { id, title }, customer: { id, email, name }, paid_at, created_at, metadata }], total, page, limit, count, has_more, next_page }.

To total revenue or find a specific buyer, page through with next_page until has_more is false. Amounts are integer santim (100 = 1.00 ETB); this is what buyers paid, before any withdrawal fee.`,
			inputSchema: z
				.object({
					status: z.enum(['paid', 'pending', 'failed']).optional(),
					page: z.number().int().min(1).default(1),
					limit: z.number().int().min(1).max(100).default(20),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: { orders: z.array(OrderShape), ...PageInfoShape },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ status, page, limit, response_format }) =>
			guard(async () => {
				const res = await ctx.client().listOrders({ page, limit, ...(status ? { status } : {}) });
				const orders = res.items.map(toOrder);
				const info = pageInfo(res.total, res.page ?? page, res.limit ?? limit, orders.length);
				const structured = { orders, ...info };

				if (orders.length === 0) {
					return ok(
						structured,
						`No ${status ? `${status} ` : ''}orders${page > 1 ? ` on page ${page}` : ''}${modeLabel(ctx.environment)}.`,
						response_format
					);
				}
				const md = [
					`## Orders${status ? ` · ${status}` : ''}${modeLabel(ctx.environment)}`,
					'',
					`Showing ${orders.length} of ${info.total} (page ${info.page}).`,
					'',
					table(
						['Order', 'Status', 'Amount', 'Product', 'Customer', 'Paid'],
						orders.map((o) => [
							`\`${o.order_id}\``,
							o.status,
							o.amount,
							o.product.title ?? o.product.id ?? '—',
							o.customer.email ?? o.customer.name ?? o.customer.id ?? '—',
							formatDate(o.paid_at)
						])
					),
					...(info.has_more ? ['', `More results: call again with page=${info.next_page}.`] : [])
				].join('\n');
				return ok(structured, md, response_format, 'Use a smaller limit or response_format=markdown.');
			})
	);
}
