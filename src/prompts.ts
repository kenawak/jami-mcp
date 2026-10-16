import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	AUTO_PAYOUT_CAP_MINOR,
	DAILY_PAYOUT_CAP_MINOR,
	DEFAULT_WITHDRAWAL_FEE_RATE,
	MIN_WITHDRAWAL_MINOR
} from 'jami-sdk';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { formatEtb, formatPercent } from './format.js';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

/** Facts every Jami integration depends on; served as a resource and folded into prompts. */
export function referenceMarkdown(docsUrl: string): string {
	return `# JamiDev reference

## Money
- Every amount is an integer in ETB minor units (santim): 10000 = 100.00 ETB. Never floats.
- Buyers pay exactly the listed price. Nothing is added at checkout.
- Withdrawals: the JamiDev usage fee (${formatPercent(DEFAULT_WITHDRAWAL_FEE_RATE)} by default, or a custom rate Jami set on the account) and any government tax are cut from the amount withdrawn. Read feeAmount / taxAmount / netAmount on the withdrawal; the server is authoritative.
- Minimum withdrawal ${formatEtb(MIN_WITHDRAWAL_MINOR)}. Up to ${formatEtb(AUTO_PAYOUT_CAP_MINOR)} pays out automatically; more is held for manual review. Cap ${formatEtb(DAILY_PAYOUT_CAP_MINOR)} per organization per rolling 24h (HTTP 429).

## Environments
- Sandbox orgs issue jamidev_test_ tokens: simulated payments, webhooks carry livemode: false.
- Production orgs issue jamidev_live_ tokens: real Telebirr, M-Pesa and CBE Birr charges.
- A token stops working when its org switches environment (401 with a hint). Issue a new one.
- Sandbox phones: 251900000001 = instant success, 251900000002 = instant failure, anything else opens a simulator.

## Checkout
- productId accepts the public p_… token or the product's id. The product must be published.
- Results: free → orderId right away; redirect → send the buyer to checkoutUrl; direct → buyer confirms on their phone, then poll.
- Sessions expire after 30 minutes. Polling reconciles with the provider, so it always resolves.
- Failure codes on expired sessions: payment_rejected, payment_failed, payment_canceled, payment_timed_out, initiate_failed, session_expired. Treat unknown codes like payment_failed.

## Webhooks
- Header X-JamiDev-Signature: t=<unix>,v1=<hex>, where v1 = HMAC-SHA256(secret, "{t}.{rawBody}"). Verify the raw body; reject if older than 300s.
- Events: order.created, order.completed, benefit.granted, checkout.session.expired, withdrawal.paid, withdrawal.failed. Order, benefit and session events carry data.sessionId.
- Reply 2xx within 10s. Retries: 1m → 5m → 30m → 2h → 12h (5 attempts). Deduplicate on event.id.

## Rate limits
- POST /checkout with a token: a per-token bucket (burst 200, refilling 20/s). Without a token (hosted checkout page): 40 per 5 minutes per IP.

Full docs: ${docsUrl}/docs · All pages as text: ${docsUrl}/llms-full.txt`;
}

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
	const docs = ctx.config.docsUrl;

	server.registerResource(
		'jami-reference',
		'jami://reference',
		{
			title: 'JamiDev reference',
			description: 'Money units, fees, limits, environments, failure codes and webhook rules in one page.',
			mimeType: 'text/markdown'
		},
		async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: referenceMarkdown(docs) }] })
	);

	server.registerPrompt(
		'integrate_jami',
		{
			title: 'Integrate Jami payments',
			description: 'Plan and build a complete JamiDev checkout integration in the current project.',
			argsSchema: {
				stack: z.string().optional().describe('Framework and language, e.g. "Next.js 15 + TypeScript"'),
				use_case: z.string().optional().describe('What you sell, e.g. "course access", "tips", "license keys"')
			}
		},
		({ stack, use_case }) =>
			user(`Integrate JamiDev payments into this project${stack ? ` (${stack})` : ''}${use_case ? ` for ${use_case}` : ''}.

Work in this order and verify each step before moving on:

1. Read the current docs first: call jami_search_docs / jami_read_doc for "/docs/quickstart", "/docs/sdk" and "/docs/webhooks". Don't rely on memory.
2. Install the official SDK (npm install jami-sdk) and create one server-side client from JAMI_TOKEN. Never ship the token to a browser.
3. Add a server route that creates a checkout (jami.createCheckout) and handles all three results: free (orderId), redirect (checkoutUrl) and direct (poll with waitForCheckout or the status endpoint).
4. Add a webhook route that verifies the RAW body with jami.webhooks.verify and JAMI_WEBHOOK_SECRET, deduplicates on event.id, fulfills on order.completed, and returns 2xx fast.
5. Test end to end in sandbox: use jami_create_checkout with phone 251900000001 (success) and 251900000002 (failure), then jami_wait_for_checkout. Use jami_create_test_webhook to fire signed events at the local webhook route.
6. Add the env vars to .env.example and write a short README section on going live.

Rules: amounts are integer santim; persist the sessionId you get back and use it to match webhooks; never mark an order paid from the browser redirect alone.`)
	);

	server.registerPrompt(
		'go_live_checklist',
		{
			title: 'Go-live checklist',
			description: 'Check an existing integration is ready to take real money.'
		},
		() =>
			user(`Audit this project's JamiDev integration for going live. For each item, show the file and line that proves it, or say it's missing:

- Tokens: JAMI_TOKEN comes from env, is server-only, and production will use a fresh jamidev_live_ token (test tokens stop working after the environment switch).
- Webhooks: a production webhook endpoint is registered (subscriptions are per organization); the handler verifies the RAW body, rejects stale timestamps, is idempotent on event.id, and replies 2xx within 10 seconds.
- Fulfillment happens on order.completed (or a verified status poll), never on the redirect back to the site.
- Expired sessions are handled: failure.code drives the message shown to the buyer.
- Amounts are integer santim everywhere; no floats, no client-supplied prices for fixed products.
- Errors: JamiAuthError, JamiValidationError and JamiRateLimitError are caught and logged with requestId.
- Withdrawals (if used): idempotency keys on every call; 402 and 429 are handled.

Use jami_read_doc("/docs/quickstart") section "Go live" as the reference.`)
	);

	server.registerPrompt(
		'debug_payment',
		{
			title: 'Debug a payment',
			description: "Find out why a checkout didn't complete and what to tell the buyer.",
			argsSchema: { session_id: z.string().describe('Checkout session id') }
		},
		({ session_id }) =>
			user(`A buyer says their payment didn't go through. Session: ${session_id}.

1. Call jami_get_checkout_status for the session.
2. If it's still open, call jami_wait_for_checkout (60s) once.
3. If it expired, explain failure.code in plain words and say what the buyer should do next (retry later, use another method, or start a new checkout).
4. If it completed, find the order in jami_list_orders and confirm the amount and buyer email.

Keep the answer short: what happened, and the next step.`)
	);
}
