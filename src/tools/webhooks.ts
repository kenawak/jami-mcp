import { createHmac, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { verifyWebhookSignature, type JamiWebhookEventType } from 'jami-sdk';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { fail, ok } from '../format.js';

const EVENT_TYPES = [
	'order.created',
	'order.completed',
	'benefit.granted',
	'checkout.session.expired',
	'withdrawal.paid',
	'withdrawal.failed'
] as const satisfies readonly JamiWebhookEventType[];

const objectId = () => randomBytes(12).toString('hex');

/** Realistic `data` for each event, matching what the API sends. */
function sampleData(type: (typeof EVENT_TYPES)[number]): Record<string, unknown> {
	const sessionId = objectId();
	const orderId = objectId();
	const now = new Date().toISOString();
	switch (type) {
		case 'order.created':
		case 'order.completed':
			return {
				orderId,
				sessionId,
				productId: objectId(),
				customerId: objectId(),
				customerEmail: 'buyer@example.com',
				customerExternalId: null,
				amount: 15000,
				currency: 'ETB',
				status: type === 'order.completed' ? 'paid' : 'pending',
				metadata: {},
				paidAt: type === 'order.completed' ? now : null
			};
		case 'benefit.granted':
			return {
				grantId: objectId(),
				benefitId: objectId(),
				benefitType: 'license_key',
				orderId,
				sessionId,
				customerId: objectId(),
				payload: { licenseKey: 'JAMI-TEST-1234-5678' }
			};
		case 'checkout.session.expired':
			return {
				sessionId,
				failure: {
					code: 'payment_timed_out',
					message: "The buyer didn't respond to the payment prompt in time."
				}
			};
		case 'withdrawal.paid':
		case 'withdrawal.failed': {
			const id = objectId();
			return {
				_id: id,
				withdrawalId: id,
				status: type === 'withdrawal.paid' ? 'completed' : 'rejected',
				amount: 10000,
				feeAmount: 700,
				taxAmount: 0,
				netAmount: 9300,
				currency: 'ETB',
				gateway: 'telebirr',
				account: '251911223344',
				createdAt: now,
				...(type === 'withdrawal.failed' ? { note: 'Gateway payout failed' } : {})
			};
		}
	}
}

/** Same scheme the dispatcher uses: `t=<unix>,v1=HMAC-SHA256(secret, "{t}.{body}")`. */
function sign(body: string, secret: string, timestamp: number): string {
	const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
	return `t=${timestamp},v1=${v1}`;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function registerWebhookTools(server: McpServer, ctx: ToolContext): void {
	const secretHelp =
		'Pass `secret` (the subscription secret from JamiDev → Automation → Webhooks — not your API token) or set JAMI_WEBHOOK_SECRET.';

	server.registerTool(
		'jami_verify_webhook',
		{
			title: 'Verify webhook',
			description: `Check whether a webhook delivery is genuine — the same timing-safe HMAC check and replay guard the SDK runs. Use it to debug "signature mismatch" errors in a handler.

Args:
  - payload: the RAW request body exactly as received (not re-serialized JSON — whitespace matters).
  - signature: the X-JamiDev-Signature header, "t=<unix>,v1=<hex>".
  - secret: the subscription's webhook secret (defaults to JAMI_WEBHOOK_SECRET).
  - tolerance_seconds: max age of the timestamp (default 300). Raise it to check an old captured delivery.

Returns: { valid, reason, event_type, event_id, livemode }. An invalid signature is a normal result (valid: false), not an error.`,
			inputSchema: z
				.object({
					payload: z.string().min(2).describe('Raw request body'),
					signature: z.string().min(5).describe('X-JamiDev-Signature header value'),
					secret: z.string().min(1).optional(),
					tolerance_seconds: z.number().int().min(1).max(31_536_000).default(300)
				})
				.strict(),
			outputSchema: {
				valid: z.boolean(),
				reason: z.string().nullable(),
				event_type: z.string().nullable(),
				event_id: z.string().nullable(),
				livemode: z.boolean().nullable()
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
		},
		({ payload, signature, secret, tolerance_seconds }) =>
			guard(async () => {
				const key = secret ?? ctx.config.webhookSecret;
				if (!key) return fail(`No webhook secret. ${secretHelp}`);
				try {
					const event = await verifyWebhookSignature({
						payload,
						signature,
						secret: key,
						toleranceSec: tolerance_seconds
					});
					return ok(
						{ valid: true, reason: null, event_type: event.type, event_id: event.id, livemode: event.livemode },
						`**Valid** \`${event.type}\` delivery \`${event.id}\` (${event.livemode ? 'live' : 'sandbox'}).`
					);
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					const tip = /mismatch/i.test(reason)
						? ' Most often the body was parsed and re-serialized before verifying, or the secret belongs to a different subscription/environment.'
						: /tolerance/i.test(reason)
							? ' The delivery is older than tolerance_seconds; raise it if you are checking a captured request.'
							: '';
					return ok(
						{ valid: false, reason, event_type: null, event_id: null, livemode: null },
						`**Invalid** — ${reason}.${tip}`
					);
				}
			})
	);

	const allowDelivery = ctx.config.allowWebhookDelivery !== false && !ctx.config.readOnly;

	server.registerTool(
		'jami_create_test_webhook',
		{
			title: 'Create test webhook',
			description: `Build a correctly signed JamiDev webhook delivery for testing a handler locally — no real event needed.

Args:
  - type: ${EVENT_TYPES.map((t) => `'${t}'`).join(' | ')}.
  - secret: signing secret (defaults to JAMI_WEBHOOK_SECRET; any string works for a local test).
  - data: optional fields to merge over the realistic sample payload.
  - livemode: default false (sandbox).${
				allowDelivery
					? `
  - target_url: optional. When set, the delivery is POSTed there (e.g. "http://localhost:3000/webhooks/jami") and the response status is reported.`
					: ''
			}

Returns: { payload, signature, headers, curl } — the exact body and X-JamiDev-Signature to send${allowDelivery ? ', plus delivery_status when target_url is set' : ''}. Handlers must verify the RAW body and reply 2xx within 10 seconds.`,
			inputSchema: z
				.object({
					type: z.enum(EVENT_TYPES),
					secret: z.string().min(1).optional(),
					data: z.record(z.string(), z.unknown()).optional(),
					livemode: z.boolean().default(false),
					...(allowDelivery ? { target_url: z.string().url().optional() } : {})
				})
				.strict(),
			outputSchema: {
				payload: z.string(),
				signature: z.string(),
				headers: z.record(z.string(), z.string()),
				curl: z.string(),
				delivery_status: z.number().int().optional(),
				delivery_error: z.string().optional()
			},
			annotations: {
				readOnlyHint: !allowDelivery,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: allowDelivery
			}
		},
		(args) =>
			guard(async () => {
				const key = args.secret ?? ctx.config.webhookSecret;
				if (!key) return fail(`No signing secret. ${secretHelp}`);

				const event = {
					id: objectId(),
					type: args.type,
					created: new Date().toISOString(),
					livemode: args.livemode,
					data: { ...sampleData(args.type), ...(args.data ?? {}) }
				};
				const payload = JSON.stringify(event);
				const signature = sign(payload, key, Math.floor(Date.now() / 1000));
				const headers = {
					'Content-Type': 'application/json',
					'X-JamiDev-Signature': signature,
					'X-JamiDev-Event': args.type
				};
				const target = (args as { target_url?: string }).target_url;
				const curl = [
					`curl -X POST ${shellQuote(target ?? 'http://localhost:3000/webhooks/jami')}`,
					...Object.entries(headers).map(([k, v]) => `  -H ${shellQuote(`${k}: ${v}`)}`),
					`  --data-raw ${shellQuote(payload)}`
				].join(' \\\n');

				const structured: Record<string, unknown> = { payload, signature, headers, curl };
				let deliveryLine = '';
				if (target) {
					try {
						const res = await ctx.fetch(target, {
							method: 'POST',
							headers,
							body: payload,
							signal: AbortSignal.timeout(10_000)
						});
						structured.delivery_status = res.status;
						deliveryLine = res.ok
							? `\n\nDelivered to ${target} → **${res.status}** (accepted).`
							: `\n\nDelivered to ${target} → **${res.status}**. JamiDev treats non-2xx as a failure and retries (1m → 5m → 30m → 2h → 12h).`;
					} catch (err) {
						structured.delivery_error = err instanceof Error ? err.message : String(err);
						deliveryLine = `\n\nCouldn't reach ${target}: ${structured.delivery_error}. Is the server running?`;
					}
				}
				return ok(
					structured,
					`**Signed \`${args.type}\` test delivery** (expires from the replay window in 300s).\n\n\`\`\`bash\n${curl}\n\`\`\`${deliveryLine}`
				);
			})
	);
}
