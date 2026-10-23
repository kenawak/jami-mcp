import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JamiMcpConfig } from './config.js';
import { createContext } from './context.js';
import { registerPrompts } from './prompts.js';
import { registerCheckoutTools } from './tools/checkout.js';
import { registerDocsTools } from './tools/docs.js';
import { registerOrderTools } from './tools/orders.js';
import { registerProductTools } from './tools/products.js';
import { registerSubscriptionTools } from './tools/subscriptions.js';
import { registerWebhookTools } from './tools/webhooks.js';
import { registerWithdrawalTools } from './tools/withdrawals.js';

export { DEFAULT_DOCS_URL, type JamiMcpConfig } from './config.js';

/** Kept in sync with package.json and server.json (asserted in tests). */
export const VERSION = '0.2.1';

function instructions(config: JamiMcpConfig, env: 'test' | 'live' | null): string {
	const mode =
		env === 'live'
			? 'Connected to a PRODUCTION organization (jamidev_live_ token): checkouts charge real buyers. Confirm with the user before creating checkouts or withdrawals.'
			: env === 'test'
				? 'Connected to a SANDBOX organization (jamidev_test_ token): payments are simulated. Phone 251900000001 succeeds instantly, 251900000002 fails.'
				: 'No API token configured: docs, withdrawal quotes and webhook tools work; account tools will explain how to add JAMI_TOKEN.';
	return [
		"JamiDev is the SDK for Jami's creator payouts: ETB checkouts via Telebirr, M-Pesa and CBE Birr, Jami wallet subscriptions, signed webhooks, and withdrawals like any Jami creator. Payments are processed by ArifPay.",
		"Subscriptions: a recurring product is the plan; jami_create_subscription_link only proposes it. The payer approves on Jami with their wallet PIN, so an API key can never start charging a wallet on its own.",
		mode,
		'All amounts are integer santim (ETB minor units): 10000 = 100.00 ETB. Parameters that take money end in _minor.',
		'When writing integration code, check jami_search_docs / jami_read_doc first — they serve the live docs. The jami://reference resource has fees, limits and failure codes.',
		config.readOnly ? 'Read-only mode: tools that create checkouts, subscription links or cancels, or move money are not available.' : '',
		!config.withdrawals && !config.readOnly
			? 'Withdrawals are disabled; the user can enable them by starting the server with --enable-withdrawals.'
			: ''
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Build a JamiDev MCP server. Transport-agnostic: connect it to stdio,
 * Streamable HTTP, or an in-memory transport for tests.
 */
export function createJamiServer(config: JamiMcpConfig, options: { fetch?: typeof fetch } = {}): McpServer {
	const ctx = createContext(config, options.fetch);
	const server = new McpServer(
		{ name: 'jami-mcp-server', title: 'Jami', version: VERSION, websiteUrl: `${config.docsUrl}/docs/mcp` },
		{ instructions: instructions(config, ctx.environment) }
	);

	registerCheckoutTools(server, ctx);
	registerProductTools(server, ctx);
	registerSubscriptionTools(server, ctx);
	registerOrderTools(server, ctx);
	registerWithdrawalTools(server, ctx);
	registerWebhookTools(server, ctx);
	registerDocsTools(server, ctx);
	registerPrompts(server, ctx);
	return server;
}
