import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CheckoutStatus, CreateCheckoutParams } from 'jami-sdk';
import { z } from 'zod';
import { modeLabel, type ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { formatDate, formatEtb, ok, ResponseFormat } from '../format.js';

const PRODUCT_ID_RE = /^(p_[A-Za-z0-9_-]+|[a-f0-9]{24})$/;
const SESSION_ID_RE = /^[a-f0-9]{24}$/;

const SessionId = z
	.string()
	.regex(SESSION_ID_RE, 'session_id is the 24-character hex id returned by jami_create_checkout')
	.describe('Checkout session id returned by jami_create_checkout, e.g. "6710c2e8b1a2f0012ab34cd9"');

/** What each failure code means for the next step — shown alongside expired sessions. */
const FAILURE_ADVICE: Record<string, string> = {
	payment_rejected:
		'The provider refused it before the buyer saw a prompt. Retry in a few minutes or offer another gateway.',
	payment_failed: 'Failed after the prompt (wrong PIN, cancel on the phone, low balance). Ask the buyer to retry.',
	payment_canceled: 'The buyer canceled. Offer to start a new checkout.',
	payment_timed_out: "The buyer didn't answer the prompt in time. Start a new checkout when they're ready.",
	initiate_failed: "The payment couldn't be started — read the message for the provider's reason.",
	session_expired: 'The 30-minute session ran out. Start a new checkout.'
};

const FailureShape = z
	.object({ code: z.string(), message: z.string() })
	.nullable()
	.describe('Why the session ended without an order; null unless status is "expired"');

const StatusShape = {
	session_id: z.string(),
	status: z.enum(['open', 'completed', 'expired']),
	order_id: z.string().nullable(),
	order_status: z.enum(['pending', 'paid', 'failed']).nullable(),
	amount_minor: z.number().int().nullable().describe('Integer santim (100 = 1.00 ETB)'),
	amount: z.string().describe('Human-readable amount, e.g. "150.00 ETB"'),
	expires_at: z.string(),
	failure: FailureShape
};

function toStatus(s: CheckoutStatus) {
	return {
		session_id: s.sessionId,
		status: s.status,
		order_id: s.orderId,
		order_status: s.orderStatus,
		amount_minor: s.amount,
		amount: formatEtb(s.amount),
		expires_at: s.expiresAt,
		failure: s.failure ?? null
	};
}

function statusMarkdown(s: ReturnType<typeof toStatus>, env: ToolContext['environment']): string {
	const lines = [`## Checkout ${s.session_id}${modeLabel(env)}`, ''];
	if (s.status === 'completed' || s.order_id) {
		lines.push(`**Paid.** Order \`${s.order_id}\` (${s.order_status ?? 'paid'}) for ${s.amount}.`);
	} else if (s.status === 'expired') {
		const code = s.failure?.code ?? 'session_expired';
		lines.push(`**Not paid** — \`${code}\`: ${s.failure?.message ?? 'The session ended without a payment.'}`);
		lines.push('', `Next: ${FAILURE_ADVICE[code] ?? FAILURE_ADVICE.payment_failed}`);
	} else {
		lines.push(
			`**Waiting for the buyer** — ${s.amount}, session expires ${formatDate(s.expires_at)}.`,
			'',
			'Next: call `jami_wait_for_checkout` to wait for the outcome.'
		);
	}
	return lines.join('\n');
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});

export function registerCheckoutTools(server: McpServer, ctx: ToolContext): void {
	if (!ctx.config.readOnly) {
		server.registerTool(
			'jami_create_checkout',
			{
				title: 'Create checkout',
				description: `Start a checkout and get back how the buyer pays — either for one of the organization's published products, or for ANY amount with no product ("charge this buyer 1,237 ETB for order #1042").

Buyers pay in ETB via Telebirr, M-Pesa or CBE Birr; nothing is added on top. In LIVE mode a "direct" checkout pushes a real payment prompt to the buyer's phone, so only call this when the user actually wants to charge someone.

What to charge:
  - Product: product_id (p_… token or 24-char id, must be published). amount_minor only for flexible-price (pwyw) products.
  - Custom amount: omit product_id, pass amount_minor (≥ 100 = 1.00 ETB) and description (what the buyer sees, ≤ 120 chars).

How to collect it:
  - Direct push: pass gateway + customer_email + customer_phone. The prompt goes straight to the buyer's phone (kind 'direct').
  - Payment link: omit gateway. You get a Jami link in checkout_url (kind 'redirect') to send the buyer by SMS/Telegram/email; they pick the method and enter their details there, and can retry a failed attempt until the link expires (30 min). customer_* is optional.

Args:
  - customer_email / customer_phone: required for a direct push; optional for a link. Phone like "251911223344" or "0911223344". Sandbox magic numbers: 251900000001 = instant success, 251900000002 = instant failure.
  - gateway: 'telebirr' | 'mpesa' | 'cbe'. Omit for a payment link.
  - amount_minor: integer santim. 123700 = 1,237.00 ETB.
  - metadata: optional string map (e.g. { "orderId": "1042" }) stored on the order and sent back on order webhooks.

Returns: { session_id, kind: 'free' | 'redirect' | 'direct', checkout_url, order_id }.
  - free: completed instantly; order_id is set.
  - redirect: send the buyer to checkout_url.
  - direct: the buyer confirms on their phone; call jami_wait_for_checkout next.`,
				inputSchema: z
					.object({
						product_id: z
							.string()
							.regex(PRODUCT_ID_RE, 'product_id must be a p_… product token or a 24-character id')
							.optional()
							.describe('Product token (p_…) or id. Omit for a custom-amount checkout.'),
						description: z
							.string()
							.min(1)
							.max(120)
							.optional()
							.describe('Custom amount only: what the buyer is paying for, e.g. "Order #1042"'),
						metadata: z
							.record(z.string(), z.string().max(500))
							.optional()
							.describe('Your own key/values, returned on order webhooks (max 20 keys)'),
						customer_email: z
							.string()
							.email()
							.optional()
							.describe('Buyer email for the receipt. Required with gateway; optional for a payment link'),
						customer_phone: z.string().min(9).max(16).optional().describe('Buyer phone, e.g. "251911223344"'),
						customer_name: z.string().max(120).optional(),
						customer_external_id: z
							.string()
							.max(200)
							.optional()
							.describe('Your own user id, stored on the customer record'),
						gateway: z.enum(['telebirr', 'mpesa', 'cbe']).optional().describe('Payment method for paid products'),
						amount_minor: z
							.number()
							.int()
							.positive()
							.optional()
							.describe('Integer santim. Required for custom amounts (≥ 100) and pay-what-you-want products; ignored for fixed prices'),
						checkout_link: z
							.string()
							.regex(/^cl_[A-Za-z0-9_-]+$/)
							.optional()
							.describe('Checkout link token (cl_…) to attribute this session to'),
						success_url: z.string().url().optional().describe('Where to send the buyer after paying'),
						collected_fields: z
							.record(z.string(), z.unknown())
							.optional()
							.describe("Answers to the product's checkout fields, keyed by field id")
					})
					.strict()
					.superRefine((v, issue) => {
						if (v.gateway && (!v.customer_email || !v.customer_phone)) {
							issue.addIssue({
								code: 'custom',
								path: ['customer_phone'],
								message: 'A direct push (gateway set) needs customer_email and customer_phone. Omit gateway to get a payment link instead.'
							});
						}
						if (v.product_id) {
							if (v.description) {
								issue.addIssue({ code: 'custom', path: ['description'], message: 'description is only for custom-amount checkouts — omit product_id to charge a custom amount' });
							}
							return;
						}
						if (v.amount_minor === undefined || v.amount_minor < 100) {
							issue.addIssue({ code: 'custom', path: ['amount_minor'], message: 'Without product_id, amount_minor is required and must be at least 100 (1.00 ETB)' });
						}
						if (!v.description) {
							issue.addIssue({ code: 'custom', path: ['description'], message: 'Without product_id, description is required (what the buyer is paying for)' });
						}
						if (v.checkout_link || v.collected_fields) {
							issue.addIssue({ code: 'custom', path: ['product_id'], message: 'checkout_link and collected_fields need a product_id' });
						}
					}),
				outputSchema: {
					session_id: z.string(),
					kind: z.enum(['free', 'redirect', 'direct']),
					checkout_url: z.string().nullable(),
					order_id: z.string().nullable()
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true
				}
			},
			(args) =>
				guard(async () => {
					const customer = args.customer_email
						? {
								email: args.customer_email,
								...(args.customer_phone ? { phone: args.customer_phone } : {}),
								...(args.customer_name ? { name: args.customer_name } : {}),
								...(args.customer_external_id ? { externalId: args.customer_external_id } : {})
							}
						: undefined;
					const shared = {
						...(customer ? { customer } : {}),
						...(args.gateway ? { gateway: args.gateway } : {}),
						...(args.success_url ? { successUrl: args.success_url } : {}),
						...(args.metadata ? { metadata: args.metadata } : {})
					};
					const params: CreateCheckoutParams = args.product_id
						? {
								...shared,
								productId: args.product_id,
								...(args.amount_minor !== undefined ? { amount: args.amount_minor } : {}),
								...(args.checkout_link ? { checkoutLink: args.checkout_link } : {}),
								...(args.collected_fields ? { collectedFields: args.collected_fields } : {})
							}
						: { ...shared, amount: args.amount_minor!, description: args.description! };
					const result = await ctx.client().createCheckout(params);

					if ('orderId' in result) {
						return ok(
							{ session_id: result.sessionId, kind: 'free', checkout_url: null, order_id: result.orderId },
							`**Free product — order \`${result.orderId}\` completed instantly**${modeLabel(ctx.environment)}. Session \`${result.sessionId}\`.`
						);
					}
					const structured = {
						session_id: result.sessionId,
						kind: result.mode,
						checkout_url: result.checkoutUrl,
						order_id: null
					};
					if (result.mode === 'redirect') {
						return ok(
							structured,
							`**Payment link ready**${modeLabel(ctx.environment)}\n\n${result.checkoutUrl}\n\nSend it to the buyer. They pick Telebirr, M-Pesa or CBE Birr there and can retry if a payment fails; the link expires in 30 minutes. Call \`jami_wait_for_checkout\` with session \`${result.sessionId}\` to wait for it.`
						);
					}
					return ok(
						structured,
						`**Prompt sent**${modeLabel(ctx.environment)}\n\n- Session: \`${result.sessionId}\`\n\nThe buyer confirms the ${args.gateway ?? 'payment'} prompt on their phone. Call \`jami_wait_for_checkout\` with this session_id.`
					);
				})
		);
	}

	server.registerTool(
		'jami_get_checkout_status',
		{
			title: 'Get checkout status',
			description: `Check a checkout session once. The server reconciles with the payment provider on every call, so this resolves even when webhooks are late.

Args:
  - session_id: from jami_create_checkout.

Returns: { session_id, status: 'open' | 'completed' | 'expired', order_id, order_status, amount_minor, amount, expires_at, failure }.
When status is 'expired', failure.code explains why: payment_rejected · payment_failed · payment_canceled · payment_timed_out · initiate_failed · session_expired.

Use jami_wait_for_checkout instead if you want to block until the buyer finishes.`,
			inputSchema: z.object({ session_id: SessionId, response_format: ResponseFormat }).strict(),
			outputSchema: StatusShape,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ session_id, response_format }) =>
			guard(async () => {
				const s = toStatus(await ctx.client().getCheckoutStatus(session_id));
				return ok(s, statusMarkdown(s, ctx.environment), response_format);
			})
	);

	server.registerTool(
		'jami_wait_for_checkout',
		{
			title: 'Wait for checkout',
			description: `Poll a checkout session until it's paid or ends, up to timeout_seconds. Reports progress while it waits.

If the buyer hasn't finished when the timeout hits, this returns status 'open' (not an error) — call it again to keep waiting. Sessions expire 30 minutes after creation.

Args:
  - session_id: from jami_create_checkout.
  - timeout_seconds: 5–300 (default 90).
  - interval_seconds: 2–30 between polls (default 3).

Returns the same shape as jami_get_checkout_status.`,
			inputSchema: z
				.object({
					session_id: SessionId,
					timeout_seconds: z.number().int().min(5).max(300).default(90),
					interval_seconds: z.number().int().min(2).max(30).default(3),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: StatusShape,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ session_id, timeout_seconds, interval_seconds, response_format }, extra) =>
			guard(async () => {
				const client = ctx.client();
				const progressToken = extra._meta?.progressToken;
				const started = Date.now();
				const deadline = started + timeout_seconds * 1000;

				for (let poll = 1; ; poll++) {
					const s = toStatus(await client.getCheckoutStatus(session_id));
					const done = s.status !== 'open' || s.order_id !== null;
					if (done || Date.now() + interval_seconds * 1000 > deadline) {
						const md = statusMarkdown(s, ctx.environment);
						const waited = Math.round((Date.now() - started) / 1000);
						return ok(
							s,
							done ? md : `${md}\n\nStill open after ${waited}s — call \`jami_wait_for_checkout\` again to keep waiting.`,
							response_format
						);
					}
					if (progressToken !== undefined) {
						await extra.sendNotification({
							method: 'notifications/progress',
							params: {
								progressToken,
								progress: Math.round((Date.now() - started) / 1000),
								total: timeout_seconds,
								message: `Waiting for the buyer (poll ${poll})`
							}
						});
					}
					await sleep(interval_seconds * 1000, extra.signal);
				}
			})
	);
}
