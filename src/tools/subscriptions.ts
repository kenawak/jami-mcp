import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JamiSubscription, JamiSubscriptionCharge } from 'jami-sdk';
import { z } from 'zod';
import { modeLabel, type ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { fail, formatCadence, formatDate, formatEtb, ok, pageInfo, PageInfoShape, ResponseFormat, table } from '../format.js';

const STATUSES = ['active', 'past_due', 'canceled'] as const;

const SubscriptionId = z
	.string()
	.regex(/^(sub_[A-Za-z0-9_-]+|[a-f0-9]{24})$/, 'subscription_id is the sub_… id (or its 24-character id)')
	.describe('Subscription id, e.g. "sub_9f2kQ…" from jami_list_subscriptions or a subscription.* webhook');

const ProductRef = z
	.string()
	.regex(/^(p_[A-Za-z0-9_-]+|[a-f0-9]{24})$/, 'Use the product’s p_… token or its 24-character id')
	.describe('Recurring product p_… token or id');

/** What each status means for the next step. */
const STATUS_MEANING: Record<string, string> = {
	active: 'paid up',
	past_due: 'a renewal failed and is being retried (1, 3 and 7 days after the due date)',
	canceled: 'ended — it will never be charged again'
};

const CANCEL_REASON: Record<string, string> = {
	customer: 'the customer canceled',
	merchant: 'you canceled',
	payment_failed: 'the last renewal retry failed',
	merchant_closed: 'the organization was closed'
};

const FailureShape = z.object({ code: z.string(), message: z.string(), at: z.string().nullable().optional() }).nullable();

const SubscriptionShape = {
	subscription_id: z.string(),
	status: z.enum(STATUSES),
	product_id: z.string(),
	product_title: z.string(),
	customer_id: z.string(),
	customer_email: z.string().nullable(),
	customer_external_id: z.string().nullable(),
	amount_minor: z.number().int().describe('Charged every period, integer santim (locked at approval)'),
	amount: z.string(),
	interval: z.enum(['week', 'month', 'year']),
	interval_count: z.number().int(),
	cadence: z.string().describe('e.g. "monthly", "every 3 months"'),
	current_period_start: z.string().nullable(),
	current_period_end: z.string().nullable(),
	next_charge_at: z.string().nullable().describe('Next renewal or retry; null once canceled or set to end'),
	cancel_at_period_end: z.boolean(),
	canceled_at: z.string().nullable(),
	ended_at: z.string().nullable(),
	cancellation_reason: z.string().nullable(),
	failed_attempts: z.number().int(),
	last_failure: FailureShape,
	metadata: z.record(z.string(), z.string()),
	livemode: z.boolean(),
	created_at: z.string().nullable()
};

const ChargeShape = {
	charge_id: z.string(),
	sequence: z.number().int(),
	billing_reason: z.enum(['subscription_create', 'subscription_cycle']),
	status: z.enum(['pending', 'succeeded', 'failed']),
	amount_minor: z.number().int(),
	amount: z.string(),
	period_start: z.string().nullable(),
	period_end: z.string().nullable(),
	attempts: z.number().int(),
	failure: FailureShape,
	order_id: z.string().nullable(),
	paid_at: z.string().nullable()
};

function toSubscription(s: JamiSubscription) {
	return {
		subscription_id: s.id,
		status: s.status,
		product_id: s.productId,
		product_title: s.productTitle,
		customer_id: s.customerId,
		customer_email: s.customerEmail,
		customer_external_id: s.customerExternalId,
		amount_minor: s.amount,
		amount: formatEtb(s.amount),
		interval: s.interval,
		interval_count: s.intervalCount,
		cadence: formatCadence(s.interval, s.intervalCount),
		current_period_start: s.currentPeriodStart,
		current_period_end: s.currentPeriodEnd,
		next_charge_at: s.nextChargeAt,
		cancel_at_period_end: s.cancelAtPeriodEnd,
		canceled_at: s.canceledAt,
		ended_at: s.endedAt,
		cancellation_reason: s.cancellationReason,
		failed_attempts: s.failedAttempts,
		last_failure: s.lastFailure,
		metadata: s.metadata,
		livemode: s.livemode,
		created_at: s.createdAt
	};
}

function toCharge(c: JamiSubscriptionCharge) {
	return {
		charge_id: c.id,
		sequence: c.sequence,
		billing_reason: c.billingReason,
		status: c.status,
		amount_minor: c.amount,
		amount: formatEtb(c.amount),
		period_start: c.periodStart,
		period_end: c.periodEnd,
		attempts: c.attempts,
		failure: c.failure,
		order_id: c.orderId,
		paid_at: c.paidAt
	};
}

type Sub = ReturnType<typeof toSubscription>;

function stateLine(s: Sub): string {
	if (s.status === 'canceled') {
		const why = s.cancellation_reason ? CANCEL_REASON[s.cancellation_reason] ?? s.cancellation_reason : 'ended';
		return `**canceled** — ${why}${s.ended_at ? `, ended ${formatDate(s.ended_at)}` : ''}.`;
	}
	if (s.cancel_at_period_end) {
		return `**${s.status}**, set to end ${formatDate(s.current_period_end)} — no more charges.`;
	}
	const failure = s.last_failure ? ` Last failure: \`${s.last_failure.code}\` — ${s.last_failure.message}.` : '';
	return `**${s.status}** — ${STATUS_MEANING[s.status] ?? s.status}. Next charge ${formatDate(s.next_charge_at)}.${failure}`;
}

function subscriptionMarkdown(s: Sub, env: ToolContext['environment']): string {
	return [
		`## Subscription ${s.subscription_id}${modeLabel(env)}`,
		'',
		stateLine(s),
		'',
		table(
			['Plan', 'Amount', 'Customer', 'Current period'],
			[
				[
					s.product_title,
					`${s.amount} ${s.cadence}`,
					s.customer_email ?? s.customer_external_id ?? s.customer_id,
					`${formatDate(s.current_period_start)} → ${formatDate(s.current_period_end)}`
				]
			]
		)
	].join('\n');
}

export function registerSubscriptionTools(server: McpServer, ctx: ToolContext): void {
	if (!ctx.config.readOnly) {
		server.registerTool(
			'jami_create_subscription_link',
			{
				title: 'Create subscription link',
				description: `Create a hosted subscribe link for a recurring product (a plan made with jami_create_product product_type 'recurring'). Send the link to the payer.

Nothing is charged by this call. An API key can only PROPOSE a subscription: the payer opens the link, signs in to Jami, reviews the plan, amount and cadence, and approves with their Jami wallet PIN. Only then is the first period charged from their Jami wallet; Jami renews it every period after that until either side cancels. The link is single use and valid 24 hours.

Args:
  - product_id: the recurring product's p_… token or id (must be published).
  - customer_email: optional, prefills / tags the payer.
  - customer_external_id: optional, your own user id (≤ 200 chars); it comes back on the subscription and its webhooks, and jami_list_subscriptions can filter by it.
  - success_url / cancel_url: optional absolute http(s) URLs. success_url gets ?subscription_id=sub_… (and {SUBSCRIPTION_ID} is filled).
  - metadata: optional string map (≤ 20 keys) copied onto the subscription.

Returns: { checkout_id: 'sc_…', url, expires_at, livemode }. Watch for the subscription.created webhook, or call jami_list_subscriptions, to see the approval.`,
				inputSchema: z
					.object({
						product_id: ProductRef,
						customer_email: z.string().email().optional(),
						customer_external_id: z.string().min(1).max(200).optional(),
						success_url: z.string().url().optional(),
						cancel_url: z.string().url().optional(),
						metadata: z
							.record(z.string(), z.string().max(500))
							.optional()
							.refine((m) => !m || Object.keys(m).length <= 20, 'metadata can have at most 20 keys')
							.describe('Your own key/values, copied onto the subscription (max 20 keys)'),
						response_format: ResponseFormat
					})
					.strict(),
				outputSchema: {
					checkout_id: z.string().describe('sc_… subscribe-link id'),
					url: z.string().describe('Send the payer here to approve'),
					expires_at: z.string(),
					livemode: z.boolean()
				},
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
			},
			(args) =>
				guard(async () => {
					const customer = {
						...(args.customer_email ? { email: args.customer_email } : {}),
						...(args.customer_external_id ? { externalId: args.customer_external_id } : {})
					};
					const link = await ctx.client().subscriptions.createCheckout({
						productId: args.product_id,
						...(Object.keys(customer).length ? { customer } : {}),
						...(args.success_url ? { successUrl: args.success_url } : {}),
						...(args.cancel_url ? { cancelUrl: args.cancel_url } : {}),
						...(args.metadata ? { metadata: args.metadata } : {})
					});
					const structured = { checkout_id: link.id, url: link.url, expires_at: link.expiresAt, livemode: link.livemode };
					const md = [
						`**Subscribe link ready**${modeLabel(ctx.environment)}`,
						'',
						link.url,
						'',
						`Send it to the payer. They approve on Jami with their wallet PIN, and only then is the first period charged. Single use; expires ${formatDate(link.expiresAt)}.`,
						'',
						'Next: the subscription.created webhook fires on approval, or check jami_list_subscriptions.'
					].join('\n');
					return ok(structured, md, args.response_format);
				})
		);
	}

	server.registerTool(
		'jami_list_subscriptions',
		{
			title: 'List subscriptions',
			description: `List the organization's wallet subscriptions, newest first.

Args:
  - status: 'active' | 'past_due' | 'canceled' (optional). past_due = a renewal failed and is being retried.
  - product_id: optional p_… token or id of the plan.
  - customer_external_id: optional, your own user id passed when the link was created.
  - page (default 1), limit 1–100 (default 20).

Returns: { subscriptions: [{ subscription_id, status, product_title, amount_minor, cadence, next_charge_at, customer_email, … }], total, page, limit, count, has_more, next_page }.`,
			inputSchema: z
				.object({
					status: z.enum(STATUSES).optional(),
					product_id: ProductRef.optional(),
					customer_external_id: z.string().min(1).max(200).optional(),
					page: z.number().int().min(1).default(1),
					limit: z.number().int().min(1).max(100).default(20),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: { subscriptions: z.array(z.object(SubscriptionShape)), ...PageInfoShape },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ status, product_id, customer_external_id, page, limit, response_format }) =>
			guard(async () => {
				const res = await ctx.client().subscriptions.list({
					page,
					limit,
					...(status ? { status } : {}),
					...(product_id ? { productId: product_id } : {}),
					...(customer_external_id ? { customerExternalId: customer_external_id } : {})
				});
				const subscriptions = res.items.map(toSubscription);
				const info = pageInfo(res.total, res.page ?? page, res.limit ?? limit, subscriptions.length);
				const md =
					subscriptions.length === 0
						? `No ${status ? `${status.replace('_', ' ')} ` : ''}subscriptions${modeLabel(ctx.environment)}. Create a subscribe link with jami_create_subscription_link.`
						: [
								`## Subscriptions${status ? ` · ${status}` : ''}${modeLabel(ctx.environment)}`,
								'',
								`Showing ${subscriptions.length} of ${info.total} (page ${info.page}).`,
								'',
								table(
									['Subscription', 'Status', 'Plan', 'Amount', 'Customer', 'Next charge'],
									subscriptions.map((s) => [
										`\`${s.subscription_id}\``,
										s.cancel_at_period_end && s.status !== 'canceled' ? `${s.status} (ending)` : s.status,
										s.product_title,
										`${s.amount} ${s.cadence}`,
										s.customer_email ?? s.customer_external_id ?? '—',
										formatDate(s.next_charge_at)
									])
								),
								...(info.has_more ? ['', `More results: call again with page=${info.next_page}.`] : [])
							].join('\n');
				return ok({ subscriptions, ...info }, md, response_format);
			})
	);

	server.registerTool(
		'jami_get_subscription',
		{
			title: 'Get subscription',
			description: `Fetch one wallet subscription with its newest 24 charges (one per billing period) — use it to see why a renewal failed or when the next one runs.

Args:
  - subscription_id: the sub_… id.

Returns: { subscription: { subscription_id, status, amount_minor, cadence, current_period_end, next_charge_at, cancel_at_period_end, cancellation_reason, last_failure, … }, charges: [{ charge_id, sequence, status, amount_minor, failure, order_id, paid_at }] }. Failure codes: insufficient_funds, kyc_required, payer_unavailable, simulated_failure, internal_error.`,
			inputSchema: z.object({ subscription_id: SubscriptionId, response_format: ResponseFormat }).strict(),
			outputSchema: { subscription: z.object(SubscriptionShape), charges: z.array(z.object(ChargeShape)) },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ subscription_id, response_format }) =>
			guard(async () => {
				const detail = await ctx.client().subscriptions.get(subscription_id);
				const subscription = toSubscription(detail.subscription);
				const charges = detail.charges.map(toCharge);
				const md = [
					subscriptionMarkdown(subscription, ctx.environment),
					'',
					charges.length === 0
						? 'No charges yet.'
						: table(
								['#', 'Status', 'Amount', 'Period', 'Paid / failure'],
								charges.map((c) => [
									String(c.sequence),
									c.status,
									c.amount,
									`${formatDate(c.period_start)} → ${formatDate(c.period_end)}`,
									c.paid_at ? formatDate(c.paid_at) : c.failure ? `\`${c.failure.code}\` ${c.failure.message}` : '—'
								])
							)
				].join('\n');
				return ok({ subscription, charges }, md, response_format);
			})
	);

	if (!ctx.config.readOnly) {
		server.registerTool(
			'jami_cancel_subscription',
			{
				title: 'Cancel subscription',
				description: `Cancel a wallet subscription so the payer is not charged again. Confirm with the user first — a cancel the payer didn't ask for loses a customer, and there are no refunds.

Args:
  - subscription_id: the sub_… id.
  - at_period_end: default true — no more charges, and it ends at current_period_end (the payer keeps what they paid for). You can undo this kind of cancel before then with jami_resume_subscription. false ends it immediately (a past_due subscription always ends immediately).

Returns the updated subscription: { subscription_id, status, cancel_at_period_end, ended_at, cancellation_reason, … }. Idempotent: cancelling twice is harmless.`,
				inputSchema: z
					.object({
						subscription_id: SubscriptionId,
						at_period_end: z.boolean().default(true),
						response_format: ResponseFormat
					})
					.strict(),
				outputSchema: SubscriptionShape,
				annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
			},
			({ subscription_id, at_period_end, response_format }) =>
				guard(async () => {
					// Ask the human directly when the client supports elicitation.
					if (server.server.getClientCapabilities()?.elicitation) {
						const answer = await server.server.elicitInput({
							message: at_period_end
								? `Cancel subscription ${subscription_id} at the end of the current period? The payer won't be charged again.`
								: `Cancel subscription ${subscription_id} immediately? It ends now, with no refund for the current period.`,
							requestedSchema: {
								type: 'object',
								properties: {
									confirm: { type: 'boolean', title: 'Cancel this subscription', default: false }
								},
								required: ['confirm']
							}
						});
						if (answer.action !== 'accept' || answer.content?.confirm !== true) {
							return fail('Subscription not canceled — the user declined the confirmation. Nothing changed.');
						}
					}

					const s = toSubscription(
						await ctx.client().subscriptions.cancel(subscription_id, { atPeriodEnd: at_period_end })
					);
					return ok(s, subscriptionMarkdown(s, ctx.environment), response_format);
				})
		);

		server.registerTool(
			'jami_resume_subscription',
			{
				title: 'Resume subscription',
				description: `Undo a cancel that YOU scheduled (jami_cancel_subscription with at_period_end true), so the subscription keeps renewing at next_charge_at.

Only works on a cancel the organization scheduled and while the subscription hasn't ended yet. A cancel the customer made can't be undone by the organization (the payer has to subscribe again), and an ended subscription can't be resumed — both return 409 not_allowed.

Args:
  - subscription_id: the sub_… id.

Returns the updated subscription: { subscription_id, status, cancel_at_period_end: false, next_charge_at, … }. Idempotent: resuming an already-renewing subscription changes nothing.`,
				inputSchema: z.object({ subscription_id: SubscriptionId, response_format: ResponseFormat }).strict(),
				outputSchema: SubscriptionShape,
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
			},
			({ subscription_id, response_format }) =>
				guard(async () => {
					const s = toSubscription(await ctx.client().subscriptions.resume(subscription_id));
					return ok(s, subscriptionMarkdown(s, ctx.environment), response_format);
				})
		);

		server.registerTool(
			'jami_simulate_subscription_renewal',
			{
				title: 'Simulate subscription renewal',
				description: `Sandbox only: run a subscription's next renewal right now, succeeding or failing, to test subscription.renewed / subscription.payment_failed / subscription.canceled handling without waiting a billing period. No money moves.

Refused with a live (jamidev_live_) token — live renewals only run on schedule.

Args:
  - subscription_id: the sub_… id of a sandbox subscription.
  - outcome: 'success' (default) or 'failure'. Failures follow the real dunning schedule: retries at 1, 3 and 7 days, then the subscription is canceled with cancellation_reason payment_failed.

Returns: { result: 'renewed' | 'retry_scheduled' | 'canceled' | 'skipped' | 'deferred', subscription }.`,
				inputSchema: z
					.object({
						subscription_id: SubscriptionId,
						outcome: z.enum(['success', 'failure']).default('success'),
						response_format: ResponseFormat
					})
					.strict(),
				outputSchema: {
					result: z.enum(['renewed', 'retry_scheduled', 'canceled', 'skipped', 'deferred']),
					subscription: z.object(SubscriptionShape).nullable()
				},
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
			},
			({ subscription_id, outcome, response_format }) =>
				guard(async () => {
					if (ctx.environment === 'live') {
						return fail(
							'Renewals can only be simulated in a sandbox organization — this server is using a live (jamidev_live_) token, and live renewals only run on their schedule. Use a jamidev_test_ token from a sandbox org.'
						);
					}
					const res = await ctx.client().subscriptions.simulateRenewal(subscription_id, { outcome });
					const subscription = res.subscription ? toSubscription(res.subscription) : null;
					const md = [
						`**Simulated renewal: ${res.result}**${modeLabel(ctx.environment)}`,
						...(subscription ? ['', subscriptionMarkdown(subscription, ctx.environment)] : [])
					].join('\n');
					return ok({ result: res.result, subscription }, md, response_format);
				})
		);
	}
}
