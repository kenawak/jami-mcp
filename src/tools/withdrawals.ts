import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	AUTO_PAYOUT_CAP_MINOR,
	computeWithdrawalQuote,
	DAILY_PAYOUT_CAP_MINOR,
	DEFAULT_WITHDRAWAL_FEE_RATE,
	MIN_WITHDRAWAL_MINOR,
	type JamiWithdrawal
} from 'jami-sdk';
import { z } from 'zod';
import { modeLabel, type ToolContext } from '../context.js';
import { guard } from '../errors.js';
import { fail, formatDate, formatEtb, formatPercent, ok, pageInfo, PageInfoShape, ResponseFormat, table } from '../format.js';

const STATUSES = ['pending', 'reviewing', 'approved', 'rejected', 'processing', 'completed'] as const;

const Gateway = z.enum(['telebirr', 'mpesa', 'cbe']).describe("Payout method: 'telebirr' | 'mpesa' | 'cbe'");

const AmountMinor = z
	.number()
	.int('amount_minor must be a whole number of santim')
	.positive()
	.describe('Gross amount in integer santim — the fee is cut from this. 10000 = 100.00 ETB (the minimum).');

function toWithdrawal(w: JamiWithdrawal) {
	return {
		withdrawal_id: String(w._id),
		status: w.status,
		amount_minor: w.amount,
		fee_minor: w.feeAmount,
		tax_minor: w.taxAmount,
		net_minor: w.netAmount,
		amount: formatEtb(w.amount),
		net: formatEtb(w.netAmount),
		gateway: w.gateway,
		account: w.account,
		created_at: w.createdAt ?? null,
		...(typeof w.note === 'string' ? { note: w.note } : {}),
		...(typeof w.idempotencyKey === 'string' ? { idempotency_key: w.idempotencyKey } : {})
	};
}

const WithdrawalShape = {
	withdrawal_id: z.string(),
	status: z.enum(STATUSES),
	amount_minor: z.number().int().describe('Gross santim debited'),
	fee_minor: z.number().int(),
	tax_minor: z.number().int(),
	net_minor: z.number().int().describe('Santim that reaches the destination'),
	amount: z.string(),
	net: z.string(),
	gateway: z.string(),
	account: z.string(),
	created_at: z.string().nullable(),
	note: z.string().optional(),
	idempotency_key: z.string().optional()
};

const STATUS_MEANING: Record<string, string> = {
	pending: 'held for manual review (over 10,000 ETB)',
	reviewing: 'under review',
	approved: 'approved, waiting to be paid out',
	rejected: 'rejected or the payout failed — funds return to the balance',
	processing: 'being paid out by the gateway',
	completed: 'paid — the net amount reached the account'
};

function withdrawalMarkdown(w: ReturnType<typeof toWithdrawal>, env: ToolContext['environment']): string {
	return [
		`## Withdrawal ${w.withdrawal_id}${modeLabel(env)}`,
		'',
		`**${w.status}** — ${STATUS_MEANING[w.status] ?? w.status}.`,
		'',
		table(
			['Gross', 'Fee', 'Tax', 'Net to account', 'To'],
			[[w.amount, formatEtb(w.fee_minor), formatEtb(w.tax_minor), w.net, `${w.gateway} ${w.account}`]]
		),
		'',
		`Created ${formatDate(w.created_at)}${w.note ? ` · Note: ${w.note}` : ''}`
	].join('\n');
}

export function registerWithdrawalTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		'jami_get_balance',
		{
			title: 'Get balance',
			description: `Get the organization's withdrawable JamiDev earnings — the ceiling on what jami_create_withdrawal can pay out.

Returns: { balance_minor, balance, eligible, currency }.
eligible is false (and balance 0) when the org can't withdraw yet: it's a sandbox org, Developer Mode is off, or KYC isn't approved.
The money itself sits in the owner's unified Jami wallet, so a withdrawal can still fail with 402 if that wallet was spent elsewhere.`,
			inputSchema: z.object({ response_format: ResponseFormat }).strict(),
			outputSchema: {
				balance_minor: z.number().int(),
				balance: z.string(),
				eligible: z.boolean(),
				currency: z.literal('ETB')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ response_format }) =>
			guard(async () => {
				const b = await ctx.client().getBalance();
				const structured = {
					balance_minor: b.balanceMinor,
					balance: formatEtb(b.balanceMinor),
					eligible: b.eligible,
					currency: b.currency
				};
				const md = b.eligible
					? `**${structured.balance}** withdrawable${modeLabel(ctx.environment)}.`
					: `**Not eligible to withdraw yet**${modeLabel(ctx.environment)}. Withdrawals need a production organization, Developer Mode on, and approved KYC.`;
				return ok(structured, md, response_format);
			})
	);

	server.registerTool(
		'jami_quote_withdrawal',
		{
			title: 'Quote withdrawal',
			description: `Preview what reaches the destination for a withdrawal — offline, no API call, works without a token.

The JamiDev usage fee (${formatPercent(DEFAULT_WITHDRAWAL_FEE_RATE)} unless Jami set a custom rate on the account) and any government tax are cut FROM the amount: you withdraw amount, the account receives net. Rounding is round-half-up per component. The server is authoritative; the real breakdown comes back on the withdrawal.

Args:
  - amount_minor: gross santim (min ${MIN_WITHDRAWAL_MINOR} = 100.00 ETB).
  - fee_rate / tax_rate: optional overrides (0–1) if you know the account's real rates.

Returns the breakdown plus whether the amount auto-pays (≤ 10,000 ETB) or goes to manual review, and the per-org 100,000 ETB rolling-24h cap.`,
			inputSchema: z
				.object({
					amount_minor: AmountMinor,
					fee_rate: z.number().min(0).max(1).optional(),
					tax_rate: z.number().min(0).max(1).optional(),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: {
				amount_minor: z.number().int(),
				fee_minor: z.number().int(),
				tax_minor: z.number().int(),
				net_minor: z.number().int(),
				fee_rate: z.number(),
				tax_rate: z.number(),
				meets_minimum: z.boolean(),
				auto_payout: z.boolean().describe('true when ≤ 10,000 ETB — paid out without manual review'),
				within_daily_cap: z.boolean()
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
		},
		({ amount_minor, fee_rate, tax_rate, response_format }) =>
			guard(async () => {
				const q = computeWithdrawalQuote(amount_minor, {
					...(fee_rate !== undefined ? { feeRate: fee_rate } : {}),
					...(tax_rate !== undefined ? { taxRate: tax_rate } : {})
				});
				const structured = {
					amount_minor: q.amount,
					fee_minor: q.feeAmount,
					tax_minor: q.taxAmount,
					net_minor: q.netAmount,
					fee_rate: q.feeRate,
					tax_rate: q.taxRate,
					meets_minimum: q.amount >= MIN_WITHDRAWAL_MINOR,
					auto_payout: q.amount <= AUTO_PAYOUT_CAP_MINOR,
					within_daily_cap: q.amount <= DAILY_PAYOUT_CAP_MINOR
				};
				const notes = [
					!structured.meets_minimum && `Below the ${formatEtb(MIN_WITHDRAWAL_MINOR)} minimum — the API will reject it.`,
					structured.auto_payout
						? 'Pays out automatically (≤ 10,000.00 ETB).'
						: 'Over 10,000.00 ETB — held for manual review before payout.',
					!structured.within_daily_cap && 'Exceeds the 100,000.00 ETB rolling-24h cap per organization.'
				].filter(Boolean);
				const md = [
					`## Withdrawal quote`,
					'',
					table(
						['Withdraw', `Fee (${formatPercent(q.feeRate)})`, `Tax (${formatPercent(q.taxRate)})`, 'Net to account'],
						[[formatEtb(q.amount), formatEtb(q.feeAmount), formatEtb(q.taxAmount), formatEtb(q.netAmount)]]
					),
					'',
					...notes.map((n) => `- ${n}`),
					'- Estimate only — the server applies the account’s real rates.'
				].join('\n');
				return ok(structured, md, response_format);
			})
	);

	if (ctx.config.withdrawals && !ctx.config.readOnly) {
		server.registerTool(
			'jami_create_withdrawal',
			{
				title: 'Create withdrawal',
				description: `Pay out the organization's earnings to a Telebirr, M-Pesa or CBE Birr account. This moves REAL money — confirm the amount and destination with the user first.

Requires a production org (jamidev_live_ token) with Developer Mode on and approved KYC. Minimum 100.00 ETB. ≤ 10,000 ETB pays out automatically; more is held for manual review. Per-org cap: 100,000 ETB per rolling 24h.

Args:
  - amount_minor: gross santim; the fee is cut from it (use jami_quote_withdrawal to preview).
  - gateway: 'telebirr' | 'mpesa' | 'cbe'.
  - account: destination phone, e.g. "251911223344".
  - idempotency_key: stable key for this payout intent (8–255 chars). Retrying with the same key returns the original withdrawal and never pays twice.

Returns the withdrawal: { withdrawal_id, status, amount_minor, fee_minor, tax_minor, net_minor, gateway, account, … }.`,
				inputSchema: z
					.object({
						amount_minor: AmountMinor.min(MIN_WITHDRAWAL_MINOR, `Minimum withdrawal is ${MIN_WITHDRAWAL_MINOR} santim (100.00 ETB)`),
						gateway: Gateway,
						account: z.string().min(9).max(16).describe('Destination phone, e.g. "251911223344"'),
						idempotency_key: z
							.string()
							.min(8)
							.max(255)
							.describe('Stable per-payout key, e.g. "payout-2026-10-16-001"'),
						response_format: ResponseFormat
					})
					.strict(),
				outputSchema: WithdrawalShape,
				annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
			},
			({ amount_minor, gateway, account, idempotency_key, response_format }) =>
				guard(async () => {
					if (ctx.environment === 'test') {
						return fail(
							'Withdrawals need a production organization — this server is using a sandbox (jamidev_test_) token, and sandbox earnings are simulated. Switch the org to production and use a jamidev_live_ token.'
						);
					}
					const quote = computeWithdrawalQuote(amount_minor);

					// Ask the human directly when the client supports elicitation.
					if (server.server.getClientCapabilities()?.elicitation) {
						const answer = await server.server.elicitInput({
							message: `Withdraw ${formatEtb(amount_minor)} to ${gateway} ${account}? About ${formatEtb(quote.netAmount)} arrives after the ${formatPercent(quote.feeRate)} fee. This sends real money.`,
							requestedSchema: {
								type: 'object',
								properties: {
									confirm: { type: 'boolean', title: 'Send this payout', default: false }
								},
								required: ['confirm']
							}
						});
						if (answer.action !== 'accept' || answer.content?.confirm !== true) {
							return fail('Withdrawal not sent — the user declined the confirmation. Nothing was debited.');
						}
					}

					const w = toWithdrawal(
						await ctx.client().createWithdrawal({ amount: amount_minor, gateway, account, idempotencyKey: idempotency_key })
					);
					return ok(w, withdrawalMarkdown(w, ctx.environment), response_format);
				})
		);
	}

	server.registerTool(
		'jami_get_withdrawal',
		{
			title: 'Get withdrawal',
			description: `Fetch one withdrawal by id to track it from pending → processing → completed (or rejected).

Args:
  - withdrawal_id: from jami_create_withdrawal or jami_list_withdrawals.`,
			inputSchema: z
				.object({
					withdrawal_id: z.string().regex(/^[a-f0-9]{24}$/, 'withdrawal_id is a 24-character hex id'),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: WithdrawalShape,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ withdrawal_id, response_format }) =>
			guard(async () => {
				const w = toWithdrawal(await ctx.client().getWithdrawal(withdrawal_id));
				return ok(w, withdrawalMarkdown(w, ctx.environment), response_format);
			})
	);

	server.registerTool(
		'jami_list_withdrawals',
		{
			title: 'List withdrawals',
			description: `List the organization's withdrawals, newest first.

Args:
  - status: ${STATUSES.map((s) => `'${s}'`).join(' | ')} (optional).
  - page (default 1), limit 1–100 (default 20).

Returns: { withdrawals: [...], total, page, limit, count, has_more, next_page }.`,
			inputSchema: z
				.object({
					status: z.enum(STATUSES).optional(),
					page: z.number().int().min(1).default(1),
					limit: z.number().int().min(1).max(100).default(20),
					response_format: ResponseFormat
				})
				.strict(),
			outputSchema: { withdrawals: z.array(z.object(WithdrawalShape)), ...PageInfoShape },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
		},
		({ status, page, limit, response_format }) =>
			guard(async () => {
				const res = await ctx.client().listWithdrawals({ page, limit, ...(status ? { status } : {}) });
				const withdrawals = res.items.map(toWithdrawal);
				const info = pageInfo(res.total, res.page ?? page, res.limit ?? limit, withdrawals.length);
				const md =
					withdrawals.length === 0
						? `No ${status ? `${status} ` : ''}withdrawals${modeLabel(ctx.environment)}.`
						: [
								`## Withdrawals${status ? ` · ${status}` : ''}${modeLabel(ctx.environment)}`,
								'',
								`Showing ${withdrawals.length} of ${info.total} (page ${info.page}).`,
								'',
								table(
									['Withdrawal', 'Status', 'Gross', 'Net', 'To', 'Created'],
									withdrawals.map((w) => [
										`\`${w.withdrawal_id}\``,
										w.status,
										w.amount,
										w.net,
										`${w.gateway} ${w.account}`,
										formatDate(w.created_at)
									])
								),
								...(info.has_more ? ['', `More results: call again with page=${info.next_page}.`] : [])
							].join('\n');
				return ok({ withdrawals, ...info }, md, response_format);
			})
	);
}
