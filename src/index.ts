#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HELP, parseCli, type CliOptions, type JamiMcpConfig } from './config.js';
import { createJamiServer, VERSION } from './server.js';

// stdout is the MCP channel in stdio mode — every log line goes to stderr.
const log = (msg: string) => process.stderr.write(`[jami-mcp] ${msg}\n`);

const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function describeMode(config: JamiMcpConfig): string {
	const env = config.token?.startsWith('jamidev_live_')
		? 'LIVE'
		: config.token?.startsWith('jamidev_test_')
			? 'sandbox'
			: 'no token (docs + offline tools only)';
	const flags = [config.readOnly && 'read-only', config.withdrawals && 'withdrawals enabled'].filter(Boolean);
	return `${env}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
}

async function runStdio(options: CliOptions): Promise<void> {
	const server = createJamiServer(options);
	await server.connect(new StdioServerTransport());
	log(`v${VERSION} ready on stdio — ${describeMode(options)}`);
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error('Request body too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
			} catch {
				reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const rpcError = (message: string) => ({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/**
 * Stateless Streamable HTTP: a fresh server + transport per request, so any
 * number of clients (and tokens) can share one process with no session state.
 * Without JAMI_TOKEN, each request brings its own `Authorization: Bearer jamidev_…`.
 */
async function runHttp(options: CliOptions): Promise<void> {
	const loopback = LOOPBACK.has(options.host);
	const allowedHosts = loopback
		? [`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]
		: undefined;

	const http = createServer(async (req, res) => {
		const path = (req.url ?? '/').split('?')[0];

		if (path === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION });
		if (path !== '/mcp') return sendJson(res, 404, { error: 'Not found — the MCP endpoint is POST /mcp' });
		if (req.method !== 'POST') {
			res.setHeader('allow', 'POST');
			return sendJson(res, 405, rpcError('This server is stateless: use POST /mcp.'));
		}

		try {
			const body = await readJson(req);
			const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
			const token = options.token ?? bearer;
			const server = createJamiServer({
				...options,
				...(token ? { token } : {}),
				allowWebhookDelivery: false
			});
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
				...(allowedHosts ? { allowedHosts, enableDnsRebindingProtection: true } : {})
			});
			res.on('close', () => {
				void transport.close();
				void server.close();
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (err) {
			const status = (err as { status?: number }).status ?? 500;
			if (status === 500) log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
			if (!res.headersSent) sendJson(res, status, rpcError(status === 500 ? 'Internal server error' : (err as Error).message));
		}
	});

	await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve));
	log(`v${VERSION} listening on http://${options.host}:${options.port}/mcp — ${describeMode(options)}`);
	if (!loopback && options.token) {
		log('warning: bound to a non-loopback address with JAMI_TOKEN set — anyone who can reach this port can use that token. Put it behind auth, or omit JAMI_TOKEN so callers send their own.');
	}

	const shutdown = () => http.close(() => process.exit(0));
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
	const options = parseCli(process.argv.slice(2), process.env);
	if (options.help) return void process.stdout.write(`${HELP}\n`);
	if (options.version) return void process.stdout.write(`${VERSION}\n`);
	await (options.transport === 'http' ? runHttp(options) : runStdio(options));
}

main().catch((err) => {
	log(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
