/**
 * Runtime configuration, resolved once from CLI flags and the environment.
 * Flags win over env vars so a client config can override a shell default.
 */

export const DEFAULT_DOCS_URL = 'https://dev.jami.bio';

export interface JamiMcpConfig {
	/** JamiDev API token (`jamidev_test_…` / `jamidev_live_…`). Optional — docs and offline tools work without it. */
	token?: string;
	/** Override the JamiDev API base URL (defaults to the SDK's `https://jami.bio/api/jamidev`). */
	baseUrl?: string;
	/** Docs origin used by the docs tools. */
	docsUrl: string;
	/** Default secret for `jami_verify_webhook` / `jami_create_test_webhook`. */
	webhookSecret?: string;
	/** Register read-only tools only — nothing that creates checkouts or moves money. */
	readOnly: boolean;
	/** Register `jami_create_withdrawal`. Off by default: it pays out real money in live mode. */
	withdrawals: boolean;
	/**
	 * Let `jami_create_test_webhook` POST to a `target_url`. On by default for stdio
	 * (the user's own machine); the HTTP server turns it off so a hosted instance
	 * can't be used to send requests into its own network.
	 */
	allowWebhookDelivery?: boolean;
}

export interface CliOptions extends JamiMcpConfig {
	transport: 'stdio' | 'http';
	port: number;
	host: string;
	help: boolean;
	version: boolean;
}

const truthy = (v: string | undefined): boolean =>
	v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

const nonEmpty = (v: string | undefined): string | undefined => {
	const t = v?.trim();
	return t ? t : undefined;
};

export function parseCli(
	argv: readonly string[],
	env: Record<string, string | undefined>
): CliOptions {
	const flag = (name: string) => argv.includes(`--${name}`);
	const value = (name: string): string | undefined => {
		const prefix = `--${name}=`;
		const inline = argv.find((a) => a.startsWith(prefix));
		if (inline) return inline.slice(prefix.length);
		const i = argv.indexOf(`--${name}`);
		const next = i >= 0 ? argv[i + 1] : undefined;
		return next && !next.startsWith('--') ? next : undefined;
	};

	const port = Number(value('port') ?? env.PORT ?? 3333);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid port: ${value('port') ?? env.PORT}`);
	}

	const options: CliOptions = {
		docsUrl: (nonEmpty(value('docs-url')) ?? nonEmpty(env.JAMI_DOCS_URL) ?? DEFAULT_DOCS_URL).replace(/\/+$/, ''),
		readOnly: flag('read-only') || truthy(env.JAMI_READ_ONLY),
		withdrawals: flag('enable-withdrawals') || truthy(env.JAMI_ENABLE_WITHDRAWALS),
		transport: flag('http') || env.JAMI_MCP_TRANSPORT === 'http' ? 'http' : 'stdio',
		port,
		host: nonEmpty(value('host')) ?? nonEmpty(env.HOST) ?? '127.0.0.1',
		help: flag('help') || argv.includes('-h'),
		version: flag('version') || argv.includes('-v')
	};
	const token = nonEmpty(env.JAMI_TOKEN) ?? nonEmpty(env.JAMI_API_KEY);
	const baseUrl = nonEmpty(value('base-url')) ?? nonEmpty(env.JAMI_BASE_URL);
	const webhookSecret = nonEmpty(env.JAMI_WEBHOOK_SECRET);
	if (token) options.token = token;
	if (baseUrl) options.baseUrl = baseUrl;
	if (webhookSecret) options.webhookSecret = webhookSecret;
	return options;
}

export const HELP = `jami-mcp — the JamiDev MCP server

Usage
  npx -y jami-mcp [options]

Options
  --http                 Serve Streamable HTTP on /mcp instead of stdio
  --port <n>             HTTP port (default 3333, or $PORT)
  --host <addr>          HTTP bind address (default 127.0.0.1)
  --read-only            Only register tools that read data
  --enable-withdrawals   Register jami_create_withdrawal (moves real money in live mode)
  --base-url <url>       Override the JamiDev API base URL
  --docs-url <url>       Override the docs origin (default ${DEFAULT_DOCS_URL})
  -h, --help             Show this help
  -v, --version          Print the version

Environment
  JAMI_TOKEN             JamiDev API token (jamidev_test_… or jamidev_live_…)
  JAMI_WEBHOOK_SECRET    Default secret for the webhook tools
  JAMI_READ_ONLY         Same as --read-only
  JAMI_ENABLE_WITHDRAWALS  Same as --enable-withdrawals

In HTTP mode without JAMI_TOKEN, each request authenticates with its own
"Authorization: Bearer jamidev_…" header.

Docs: ${DEFAULT_DOCS_URL}/docs/mcp`;
