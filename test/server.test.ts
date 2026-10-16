import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/config.js';
import { VERSION } from '../src/server.js';
import { connect, LIVE_TOKEN, TEST_TOKEN } from './helpers.js';

const API = 'https://jami.bio/api/jamidev';
const SESSION = '6710c2e8b1a2f0012ab34cd9';

describe('tool registry', () => {
	it('registers every tool with annotations, and gates writes', async () => {
		const names = async (cfg: Parameters<typeof connect>[0]) =>
			(await (await connect(cfg)).client.listTools()).tools.map((t) => t.name).sort();

		const all = await names({ withdrawals: true });
		expect(all).toEqual([
			'jami_create_checkout',
			'jami_create_test_webhook',
			'jami_create_withdrawal',
			'jami_get_balance',
			'jami_get_checkout_status',
			'jami_get_withdrawal',
			'jami_list_orders',
			'jami_list_withdrawals',
			'jami_quote_withdrawal',
			'jami_read_doc',
			'jami_search_docs',
			'jami_verify_webhook',
			'jami_wait_for_checkout'
		]);
		expect(await names({})).not.toContain('jami_create_withdrawal');
		const readOnly = await names({ readOnly: true, withdrawals: true });
		expect(readOnly).not.toContain('jami_create_checkout');
		expect(readOnly).not.toContain('jami_create_withdrawal');

		const { tools } = await (await connect({ withdrawals: true })).client.listTools();
		for (const t of tools) {
			expect(t.annotations, t.name).toBeDefined();
			expect(t.description!.length, t.name).toBeGreaterThan(80);
		}
		expect(tools.find((t) => t.name === 'jami_create_withdrawal')!.annotations!.destructiveHint).toBe(true);
	});

	it('keeps VERSION in sync with package.json', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
		const registry = JSON.parse(readFileSync('server.json', 'utf8'));
		expect(VERSION).toBe(pkg.version);
		expect(registry.version).toBe(pkg.version);
		expect(registry.packages[0].version).toBe(pkg.version);
		expect(registry.name).toBe(pkg.mcpName);
	});

	it('states the mode in server instructions', async () => {
		const { client } = await connect({ token: LIVE_TOKEN });
		expect(client.getInstructions()).toMatch(/PRODUCTION/);
	});
});

describe('auth', () => {
	it('explains how to add a token instead of failing opaquely', async () => {
		const { call, text } = await connect();
		const r = await call('jami_get_balance');
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/JAMI_TOKEN/);
		expect(text(r)).toMatch(/Developer → API Tokens/);
	});

	it('flags a malformed token', async () => {
		const { call, text } = await connect({ token: 'sk_nope' });
		expect(text(await call('jami_list_orders'))).toMatch(/isn't a valid JamiDev token/);
	});

	it('surfaces the environment-mismatch hint on 401', async () => {
		const { call, text } = await connect({ token: TEST_TOKEN }, () => ({
			status: 401,
			body: { error: 'This sandbox token cannot be used while the organization is in production — create a new token' }
		}));
		const r = await call('jami_get_balance');
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/other environment/);
		expect(text(r)).toMatch(/req_test/);
	});
});

describe('checkout', () => {
	it('creates a direct checkout and maps snake_case args onto the SDK', async () => {
		const { call, calls, text } = await connect({ token: TEST_TOKEN }, (c) =>
			c.url === `${API}/checkout` ? { body: { sessionId: SESSION, checkoutUrl: null, mode: 'direct' } } : undefined
		);
		const r = await call('jami_create_checkout', {
			product_id: 'p_AbC123',
			customer_email: 'buyer@example.com',
			customer_phone: '251900000001',
			gateway: 'telebirr'
		});
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toEqual({ session_id: SESSION, kind: 'direct', checkout_url: null, order_id: null });
		expect(text(r)).toMatch(/jami_wait_for_checkout/);
		expect(calls[0]!.body).toEqual({
			productId: 'p_AbC123',
			customer: { email: 'buyer@example.com', phone: '251900000001' },
			gateway: 'telebirr'
		});
		expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
	});

	it('charges a custom amount with no product', async () => {
		const { call, calls } = await connect({ token: TEST_TOKEN }, () => ({
			body: { sessionId: SESSION, checkoutUrl: 'https://jami.bio/jamidev/simulate/x', mode: 'redirect' }
		}));
		const r = await call('jami_create_checkout', {
			amount_minor: 123700,
			description: 'Order #1042',
			metadata: { orderId: '1042' },
			customer_email: 'buyer@example.com',
			customer_phone: '251900000001',
			gateway: 'telebirr'
		});
		expect(r.isError).toBeFalsy();
		expect(calls[0]!.body).toEqual({
			amount: 123700,
			description: 'Order #1042',
			metadata: { orderId: '1042' },
			customer: { email: 'buyer@example.com', phone: '251900000001' },
			gateway: 'telebirr'
		});
	});

	it('explains what a custom-amount checkout is missing', async () => {
		const { call, calls, text } = await connect({ token: TEST_TOKEN });
		const r = await call('jami_create_checkout', { amount_minor: 50, customer_email: 'a@b.co' });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/at least 100/);
		expect(text(r)).toMatch(/description is required/);
		expect(calls).toHaveLength(0);
	});

	it('handles free products', async () => {
		const { call } = await connect({ token: TEST_TOKEN }, () => ({ body: { sessionId: SESSION, orderId: 'ord_1' } }));
		const r = await call('jami_create_checkout', { product_id: 'p_free', customer_email: 'a@b.co' });
		expect(r.structuredContent).toMatchObject({ kind: 'free', order_id: 'ord_1' });
	});

	it('rejects a bad product id before calling the API', async () => {
		const { call, calls } = await connect({ token: TEST_TOKEN });
		const r = await call('jami_create_checkout', { product_id: 'shoes', customer_email: 'a@b.co' });
		expect(r.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it('explains a failed session with next steps', async () => {
		const { call, text } = await connect({ token: TEST_TOKEN }, () => ({
			body: {
				sessionId: SESSION,
				status: 'expired',
				expiresAt: '2026-10-16T10:00:00.000Z',
				amount: 15000,
				currency: 'ETB',
				orderId: null,
				orderStatus: null,
				failure: { code: 'payment_rejected', message: 'Rejected within seconds.' }
			}
		}));
		const r = await call('jami_get_checkout_status', { session_id: SESSION });
		expect(r.structuredContent).toMatchObject({ status: 'expired', amount: '150.00 ETB', failure: { code: 'payment_rejected' } });
		expect(text(r)).toMatch(/another gateway/);
	});

	it('waits until the session completes', async () => {
		let polls = 0;
		const { call } = await connect({ token: TEST_TOKEN }, () => {
			polls++;
			const done = polls >= 2;
			return {
				body: {
					sessionId: SESSION,
					status: done ? 'completed' : 'open',
					expiresAt: '2026-10-16T10:00:00.000Z',
					amount: 15000,
					currency: 'ETB',
					orderId: done ? 'ord_9' : null,
					orderStatus: done ? 'paid' : null
				}
			};
		});
		const r = await call('jami_wait_for_checkout', { session_id: SESSION, interval_seconds: 2, timeout_seconds: 10 });
		expect(polls).toBe(2);
		expect(r.structuredContent).toMatchObject({ status: 'completed', order_id: 'ord_9' });
	}, 10_000);
});

describe('orders', () => {
	it('paginates and flattens populated refs', async () => {
		const { call, calls, text } = await connect({ token: TEST_TOKEN }, () => ({
			body: {
				items: [
					{
						_id: 'o1',
						status: 'paid',
						amount: 250000,
						currency: 'ETB',
						productId: { _id: 'p1', title: 'Leather Bag' },
						customerId: { _id: 'c1', email: 'abebe@example.com' },
						paidAt: '2026-10-01T08:00:00.000Z'
					}
				],
				total: 41,
				page: 2,
				limit: 20
			}
		}));
		const r = await call('jami_list_orders', { status: 'paid', page: 2 });
		expect(calls[0]!.url).toBe(`${API}/orders?page=2&limit=20&status=paid`);
		expect(r.structuredContent).toMatchObject({
			total: 41,
			has_more: true,
			next_page: 3,
			orders: [{ order_id: 'o1', amount: '2,500.00 ETB', product: { title: 'Leather Bag' }, customer: { email: 'abebe@example.com' } }]
		});
		expect(text(r)).toMatch(/\| `o1` \| paid \| 2,500.00 ETB \| Leather Bag/);
	});
});

describe('withdrawals', () => {
	const withdrawal = {
		_id: 'a'.repeat(24),
		status: 'completed',
		amount: 10000,
		feeAmount: 700,
		taxAmount: 0,
		netAmount: 9300,
		currency: 'ETB',
		gateway: 'telebirr',
		account: '251911223344',
		createdAt: '2026-10-16T09:00:00.000Z'
	};
	const args = { amount_minor: 10000, gateway: 'telebirr', account: '251911223344', idempotency_key: 'payout-0001' };

	it('quotes offline with the 7% default', async () => {
		const { call, calls } = await connect();
		const r = await call('jami_quote_withdrawal', { amount_minor: 2_000_000 });
		expect(calls).toHaveLength(0);
		expect(r.structuredContent).toMatchObject({ fee_minor: 140_000, net_minor: 1_860_000, auto_payout: false, meets_minimum: true });
	});

	it('refuses sandbox payouts without calling the API', async () => {
		const { call, calls, text } = await connect({ token: TEST_TOKEN, withdrawals: true });
		const r = await call('jami_create_withdrawal', args);
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/production organization/);
		expect(calls).toHaveLength(0);
	});

	it('sends the idempotency key as a header', async () => {
		const { call, calls } = await connect({ token: LIVE_TOKEN, withdrawals: true }, () => ({ status: 201, body: withdrawal }));
		const r = await call('jami_create_withdrawal', args);
		expect(r.structuredContent).toMatchObject({ net_minor: 9300, status: 'completed' });
		expect(calls[0]!.headers['idempotency-key']).toBe('payout-0001');
		expect(calls[0]!.body).toEqual({ amount: 10000, gateway: 'telebirr', account: '251911223344' });
	});

	it('asks the user to confirm when the client supports elicitation', async () => {
		const { client, call, calls } = await connect({ token: LIVE_TOKEN, withdrawals: true }, () => ({ body: withdrawal }), {
			capabilities: { elicitation: {} }
		});
		let asked = '';
		client.setRequestHandler(ElicitRequestSchema, async (req) => {
			asked = req.params.message;
			return { action: 'decline' };
		});
		const r = await call('jami_create_withdrawal', args);
		expect(asked).toMatch(/100.00 ETB to telebirr 251911223344/);
		expect(r.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it('names the daily cap when the API returns it as a 429', async () => {
		const { call, text } = await connect({ token: LIVE_TOKEN, withdrawals: true }, () => ({
			status: 429,
			body: { error: 'Daily payout limit reached for this organization' }
		}));
		expect(text(await call('jami_create_withdrawal', args))).toMatch(/rolling-24h payout cap/);
	});
});

describe('webhooks', () => {
	const secret = 'whsec_test';

	it('round-trips: a generated test delivery verifies', async () => {
		const { call } = await connect({ webhookSecret: secret });
		const made = await call('jami_create_test_webhook', { type: 'order.completed' });
		const { payload, signature } = made.structuredContent as { payload: string; signature: string };
		expect(JSON.parse(payload)).toMatchObject({ type: 'order.completed', livemode: false, data: { status: 'paid' } });

		const ok = await call('jami_verify_webhook', { payload, signature });
		expect(ok.structuredContent).toMatchObject({ valid: true, event_type: 'order.completed' });

		const tampered = await call('jami_verify_webhook', { payload: payload.replace('15000', '15001'), signature });
		expect(tampered.isError).toBeFalsy();
		expect(tampered.structuredContent).toMatchObject({ valid: false });
	});

	it('matches the dispatcher signature scheme', async () => {
		const { call } = await connect();
		const r = await call('jami_create_test_webhook', { type: 'withdrawal.paid', secret });
		const { payload, signature } = r.structuredContent as { payload: string; signature: string };
		const [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature)!;
		expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
	});

	it('delivers to a local target and reports the status', async () => {
		const { call, calls } = await connect({ webhookSecret: secret }, (c) =>
			c.url === 'http://localhost:3000/hook' ? { status: 200, body: { received: true } } : undefined
		);
		const r = await call('jami_create_test_webhook', { type: 'order.created', target_url: 'http://localhost:3000/hook' });
		expect(r.structuredContent).toMatchObject({ delivery_status: 200 });
		expect(calls[0]!.headers['X-JamiDev-Signature']).toMatch(/^t=\d+,v1=/);
	});

	it('drops target_url when delivery is disabled (HTTP mode)', async () => {
		const { client } = await connect({ allowWebhookDelivery: false });
		const tool = (await client.listTools()).tools.find((t) => t.name === 'jami_create_test_webhook')!;
		expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('target_url');
	});
});

describe('docs', () => {
	const llms = `# Introduction (/docs)

JamiDev is Jami's payments layer.

# Webhooks (/docs/webhooks)

## Verify the signature

Use the raw body. X-JamiDev-Signature carries t and v1.

# Checkout (/docs/api/checkout)

POST /checkout creates a session.`;

	const route = (c: { url: string }) => (c.url === 'https://docs.test/llms-full.txt' ? { body: null, text: llms } : undefined);

	it('ranks pages and reads them by any path form', async () => {
		const { call, calls } = await connect({}, route);
		const s = await call('jami_search_docs', { query: 'verify webhook signature' });
		expect((s.structuredContent as { results: { path: string }[] }).results[0]!.path).toBe('/docs/webhooks');

		for (const path of ['/docs/api/checkout', 'api/checkout', 'https://docs.test/docs/api/checkout.md']) {
			const r = await call('jami_read_doc', { path });
			expect(r.structuredContent, path).toMatchObject({ title: 'Checkout' });
		}
		expect(calls.filter((c) => c.url.endsWith('llms-full.txt'))).toHaveLength(1); // cached
	});

	it('lists real pages when a path is wrong', async () => {
		const { call, text } = await connect({}, route);
		const r = await call('jami_read_doc', { path: 'nope' });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/`\/docs\/webhooks`/);
	});
});

describe('prompts and resources', () => {
	it('exposes the integration prompts and reference', async () => {
		const { client } = await connect();
		const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
		expect(prompts).toEqual(['debug_payment', 'go_live_checklist', 'integrate_jami']);
		const p = await client.getPrompt({ name: 'integrate_jami', arguments: { stack: 'Hono + Bun' } });
		expect((p.messages[0]!.content as { text: string }).text).toMatch(/Hono \+ Bun/);
		const ref = await client.readResource({ uri: 'jami://reference' });
		expect((ref.contents[0] as { text: string }).text).toMatch(/251900000001/);
	});
});

describe('cli', () => {
	it('parses flags over env', () => {
		const o = parseCli(['--http', '--port', '4000', '--read-only'], { JAMI_TOKEN: TEST_TOKEN, JAMI_ENABLE_WITHDRAWALS: 'true' });
		expect(o).toMatchObject({ transport: 'http', port: 4000, readOnly: true, withdrawals: true, token: TEST_TOKEN, host: '127.0.0.1' });
		expect(() => parseCli(['--port', 'abc'], {})).toThrow(/Invalid port/);
	});
});

describe('format', () => {
	it('prints rates without float noise', async () => {
		const { formatPercent } = await import('../src/format.js');
		expect(formatPercent(0.07)).toBe('7%');
		expect(formatPercent(0.075)).toBe('7.5%');
		const { call, text } = await connect();
		expect(text(await call('jami_quote_withdrawal', { amount_minor: 500000 }))).toMatch(/Fee \(7%\)/);
	});
});
