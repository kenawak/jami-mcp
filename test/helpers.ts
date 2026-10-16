import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createJamiServer, type JamiMcpConfig } from '../src/server.js';

export const TEST_TOKEN = `jamidev_test_${'a'.repeat(32)}`;
export const LIVE_TOKEN = `jamidev_live_${'b'.repeat(32)}`;

export interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

type Route = (call: Call) => { status?: number; body: unknown; text?: string } | undefined;

/** A fetch stub that records calls and answers from `route`. */
export function mockFetch(route: Route) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
		const raw = typeof init?.body === 'string' ? init.body : undefined;
		const call: Call = {
			method: init?.method ?? 'GET',
			url,
			headers,
			body: raw && headers['content-type']?.includes('json') ? JSON.parse(raw) : raw
		};
		calls.push(call);
		const hit = route(call);
		if (!hit) return new Response(JSON.stringify({ error: `unmocked ${call.method} ${url}` }), { status: 599 });
		if (hit.text !== undefined) return new Response(hit.text, { status: hit.status ?? 200 });
		return new Response(JSON.stringify(hit.body), {
			status: hit.status ?? 200,
			headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' }
		});
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

export async function connect(
	config: Partial<JamiMcpConfig> = {},
	route: Route = () => undefined,
	clientCapabilities: ConstructorParameters<typeof Client>[1] = {}
) {
	const { fetch, calls } = mockFetch(route);
	const server = createJamiServer(
		{ docsUrl: 'https://docs.test', readOnly: false, withdrawals: false, ...config },
		{ fetch }
	);
	const client = new Client({ name: 'test', version: '0.0.0' }, clientCapabilities);
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);

	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;
	const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

	return { client, server, calls, call, text };
}
