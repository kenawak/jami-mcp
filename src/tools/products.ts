import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CreateProductParams, JamiProduct, UpdateProductParams } from 'jami-sdk';
import { z } from 'zod';
import { modeLabel, type ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { formatEtb, ok, pageInfo, PageInfoShape, ResponseFormat, table } from '../format.js';

const ProductRef = z
	.string()
	.regex(/^(p_[A-Za-z0-9_-]+|[a-f0-9]{24})$/, 'Use the product’s p_… token or its 24-character id')
	.describe('Product p_… token or id');

function toProduct(p: JamiProduct) {
	return {
		product_id: p.id,
		token: p.token,
		url: p.url,
		title: p.title,
		status: p.status,
		pricing_model: p.pricingModel,
		price: p.pricingModel === 'fixed' ? formatEtb(p.price.amount) : p.pricingModel === 'pwyw' ? `from ${formatEtb(p.price.minimumAmount)}` : 'Free',
		amount_minor: p.price.amount,
		minimum_amount_minor: p.price.minimumAmount
	};
}

const ProductShape = {
	product_id: z.string(),
	token: z.string().describe('Use as product_id in jami_create_checkout'),
	url: z.string().nullable().describe('Public Jami page where anyone can buy it (published only)'),
	title: z.string(),
	status: z.enum(['draft', 'published', 'archived']),
	pricing_model: z.enum(['fixed', 'pwyw', 'free']),
	price: z.string(),
	amount_minor: z.number().int().nullable(),
	minimum_amount_minor: z.number().int().nullable()
};

const productLine = (p: ReturnType<typeof toProduct>) =>
	`**${p.title}** — ${p.price} · ${p.status}\n- Token: \`${p.token}\`${p.url ? `\n- Page: ${p.url}` : ''}`;

export function registerProductTools(server: McpServer, ctx: ToolContext): void {
	if (!ctx.config.readOnly) {
		server.registerTool(
			'jami_create_product',
			{
				title: 'Create product',
				description: `Create a product the organization sells, and get its public Jami page (url) and p_… token. Published by default, so the page and checkouts work immediately.

Pricing (can't be changed after creation; the amounts can):
  - fixed: amount_minor is the price, e.g. 250000 = 2,500.00 ETB.
  - pwyw (flexible): minimum_amount_minor; each checkout then sends its own amount.
  - free: no price.

Args: title (1–120 chars), pricing_model, amount_minor / minimum_amount_minor, description?, status? ('published' | 'draft').

Returns: { product_id, token, url, title, status, pricing_model, price }. To charge for it, call jami_create_checkout with product_id = token (omit gateway for a payment link).`,
				inputSchema: z
					.object({
						title: z.string().min(1).max(120),
						pricing_model: z.enum(['fixed', 'pwyw', 'free']),
						amount_minor: z.number().int().positive().optional().describe('Fixed price in santim'),
						minimum_amount_minor: z.number().int().min(0).optional().describe('Flexible price floor in santim'),
						description: z.string().max(5000).optional(),
						status: z.enum(['published', 'draft']).default('published'),
						response_format: ResponseFormat
					})
					.strict()
					.superRefine((v, issue) => {
						if (v.pricing_model === 'fixed' && v.amount_minor === undefined) {
							issue.addIssue({ code: 'custom', path: ['amount_minor'], message: 'A fixed-price product needs amount_minor' });
						}
						if (v.pricing_model === 'pwyw' && v.minimum_amount_minor === undefined) {
							issue.addIssue({ code: 'custom', path: ['minimum_amount_minor'], message: 'A flexible-price product needs minimum_amount_minor' });
						}
					}),
				outputSchema: ProductShape,
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
			},
			(args) =>
				guard(async () => {
					const base = {
						title: args.title,
						status: args.status,
						...(args.description ? { description: args.description } : {})
					};
					const params: CreateProductParams =
						args.pricing_model === 'fixed'
							? { ...base, pricingModel: 'fixed', price: { amount: args.amount_minor! } }
							: args.pricing_model === 'pwyw'
								? { ...base, pricingModel: 'pwyw', price: { minimumAmount: args.minimum_amount_minor! } }
								: { ...base, pricingModel: 'free' };
					const p = toProduct(await ctx.client().products.create(params));
					return ok(p, `**Product created**${modeLabel(ctx.environment)}\n\n${productLine(p)}`, args.response_format);
				})
		);

		server.registerTool(
			'jami_update_product',
			{
				title: 'Update product',
				description: `Change a product's title, description, status or price amount. The pricing model itself is locked.

Args: product_id (p_… token or id), and any of: title, description, status ('published' | 'draft' | 'archived' — archived stops new sales), amount_minor (fixed price), minimum_amount_minor (flexible floor).`,
				inputSchema: z
					.object({
						product_id: ProductRef,
						title: z.string().min(1).max(120).optional(),
						description: z.string().max(5000).optional(),
						status: z.enum(['published', 'draft', 'archived']).optional(),
						amount_minor: z.number().int().positive().optional(),
						minimum_amount_minor: z.number().int().min(0).optional(),
						response_format: ResponseFormat
					})
					.strict(),
				outputSchema: ProductShape,
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
			},
			(args) =>
				guard(async () => {
					const price = {
						...(args.amount_minor !== undefined ? { amount: args.amount_minor } : {}),
						...(args.minimum_amount_minor !== undefined ? { minimumAmount: args.minimum_amount_minor } : {})
					};
					const params: UpdateProductParams = {
						...(args.title ? { title: args.title } : {}),
						...(args.description !== undefined ? { description: args.description } : {}),
						...(args.status ? { status: args.status } : {}),
						...(Object.keys(price).length ? { price } : {})
					};
					const p = toProduct(await ctx.client().products.update(args.product_id, params));
					return ok(p, `**Product updated**${modeLabel(ctx.environment)}\n\n${productLine(p)}`, args.response_format);
				})
		);
	}

	server.registerTool(
		'jami_get_product',
		{
			title: 'Get product',
			description: 'Fetch one product by its p_… token or id: price, status, and its public page url.',
			inputSchema: z.object({ product_id: ProductRef, response_format: ResponseFormat }).strict(),
			outputSchema: ProductShape,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ product_id, response_format }) =>
			guard(async () => {
				const p = toProduct(await ctx.client().products.get(product_id));
				return ok(p, productLine(p), response_format);
			})
	);

	server.registerTool(
		'jami_list_products',
		{
			title: 'List products',
			description: `List the organization's products, newest first.

Args: status ('published' | 'draft' | 'archived', optional), page (default 1), limit 1–100 (default 20).

Returns: { products: [{ product_id, token, url, title, status, pricing_model, price }], total, page, limit, count, has_more, next_page }.`,
			inputSchema: z
				.object({
					status: z.enum(['published', 'draft', 'archived']).optional(),
					page: z.number().int().min(1).default(1),
					limit: z.number().int().min(1).max(100).default(20),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: { products: z.array(z.object(ProductShape)), ...PageInfoShape },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ status, page, limit, response_format }) =>
			guard(async () => {
				const res = await ctx.client().products.list({ page, limit, ...(status ? { status } : {}) });
				const products = res.items.map(toProduct);
				const info = pageInfo(res.total, res.page ?? page, res.limit ?? limit, products.length);
				const md =
					products.length === 0
						? `No ${status ? `${status} ` : ''}products${modeLabel(ctx.environment)}. Create one with jami_create_product.`
						: [
								`## Products${modeLabel(ctx.environment)}`,
								'',
								table(
									['Title', 'Price', 'Status', 'Token'],
									products.map((p) => [p.title, p.price, p.status, `\`${p.token}\``])
								),
								...(info.has_more ? ['', `More: call again with page=${info.next_page}.`] : [])
							].join('\n');
				return ok({ products, ...info }, md, response_format);
			})
	);
}
