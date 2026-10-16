import { Jami } from 'jami-sdk';
import type { JamiMcpConfig } from './config.js';
import { DocsIndex } from './docs.js';
import { MissingTokenError } from './errors.js';

const TOKEN_RE = /^jamidev_(live|test)_[a-f0-9]{32}$/;

/** Everything a tool module needs; built once per server instance. */
export interface ToolContext {
	config: JamiMcpConfig;
	/** `test` / `live` from the token prefix, or `null` without a token. */
	environment: 'test' | 'live' | null;
	/** The SDK client. Throws {@link MissingTokenError} when no usable token is configured. */
	client(): Jami;
	docs: DocsIndex;
	fetch: typeof fetch;
}

export function createContext(config: JamiMcpConfig, fetchImpl: typeof fetch = globalThis.fetch): ToolContext {
	const match = config.token ? TOKEN_RE.exec(config.token) : null;
	const environment = match ? (match[1] as 'test' | 'live') : null;
	let client: Jami | undefined;

	return {
		config,
		environment,
		fetch: fetchImpl,
		docs: new DocsIndex(config.docsUrl, fetchImpl),
		client() {
			if (!config.token) throw new MissingTokenError('missing');
			if (!match) throw new MissingTokenError('malformed');
			client ??= new Jami({
				token: config.token,
				fetch: fetchImpl,
				...(config.baseUrl ? { baseUrl: config.baseUrl } : {})
			});
			return client;
		}
	};
}

/** `" (test mode)"` / `" (LIVE — real money)"` suffix for headings. */
export function modeLabel(env: ToolContext['environment']): string {
	if (env === 'live') return ' · LIVE (real money)';
	if (env === 'test') return ' · test mode';
	return '';
}
