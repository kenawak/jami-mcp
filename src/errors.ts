import {
	JamiAuthError,
	JamiError,
	JamiRateLimitError,
	JamiSignatureError,
	JamiValidationError
} from 'jami-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fail } from './format.js';

const TOKEN_HELP =
	'Create one in the Jami dashboard under JamiDev → Developer → API Tokens (sandbox orgs issue jamidev_test_…, production orgs jamidev_live_…) and give it to this server: the JAMI_TOKEN env var, or an `Authorization: Bearer` header in HTTP mode.';

/** The server was started without a usable token, so account tools can't run. */
export class MissingTokenError extends Error {
	constructor(reason: 'missing' | 'malformed') {
		super(
			reason === 'missing'
				? `This tool needs a JamiDev API token. ${TOKEN_HELP} Docs and offline tools (jami_search_docs, jami_quote_withdrawal, the webhook tools) work without one.`
				: `JAMI_TOKEN isn't a valid JamiDev token — expected "jamidev_test_" or "jamidev_live_" followed by 32 hex characters. ${TOKEN_HELP}`
		);
		this.name = 'MissingTokenError';
	}
}

const withRequestId = (msg: string, err: JamiError) =>
	err.requestId ? `${msg} (request id ${err.requestId})` : msg;

/**
 * Turn anything a tool can throw into an actionable message. The model reads
 * this verbatim, so every branch says what went wrong and what to do next.
 */
export function describeError(err: unknown): string {
	if (err instanceof MissingTokenError) return err.message;

	if (err instanceof JamiAuthError) {
		const base = err.hint ?? `Jami rejected the API token (401): ${err.message}.`;
		return withRequestId(`${base} ${TOKEN_HELP}`, err);
	}
	if (err instanceof JamiValidationError) {
		return withRequestId(`Jami rejected the request (400): ${err.message}. Fix that field and retry.`, err);
	}
	if (err instanceof JamiRateLimitError) {
		// The API reuses 429 for the per-org rolling-24h payout ceiling.
		if (/daily payout/i.test(err.message)) {
			return withRequestId(
				'The organization hit its rolling-24h payout cap of 100,000.00 ETB (429). Wait for earlier withdrawals to age out of the 24-hour window, or withdraw a smaller amount.',
				err
			);
		}
		return withRequestId(
			`Rate limited by Jami (429): ${err.message}. Back off for a few seconds before retrying — don't loop.`,
			err
		);
	}
	if (err instanceof JamiSignatureError) {
		return `Webhook verification failed: ${err.message}`;
	}
	if (err instanceof JamiError) {
		switch (err.status) {
			case 402:
				return withRequestId(
					`Insufficient funds (402): ${err.message}. The org's earnings looked sufficient, but the owner's Jami wallet doesn't hold enough right now — check jami_get_balance, then withdraw less or wait for pending payouts to settle.`,
					err
				);
			case 404:
				return withRequestId(
					`Not found (404): ${err.message}. Check the id — product_id must be a published product in this token's organization (its p_… token or its id), and session/withdrawal/subscription ids come from earlier tool results.`,
					err
				);
			case 403:
				return withRequestId(`Forbidden (403): ${err.message}.`, err);
			case 409: {
				const next =
					err.code === 'product_unavailable'
						? ' The plan must be a published recurring product with a valid price — check it with jami_get_product.'
						: err.code === 'not_allowed'
							? " The subscription's state doesn't allow this (e.g. it already ended, the customer canceled it, or it isn't a sandbox subscription)."
							: '';
				return withRequestId(`Conflict (409${err.code ? ` ${err.code}` : ''}): ${err.message}.${next}`, err);
			}
		}
		if (err.code === 'invalid_token') return new MissingTokenError('malformed').message;
		if (err.status && err.status >= 500) {
			return withRequestId(
				`Jami had a server error (${err.status}): ${err.message}. This is usually transient — retry once; for a checkout or withdrawal, reuse the same idempotency key so a retry can't duplicate it.`,
				err
			);
		}
		return withRequestId(`Jami request failed${err.status ? ` (${err.status})` : ''}: ${err.message}`, err);
	}

	// fetch() network failures surface as TypeError("fetch failed") with a cause.
	if (err instanceof TypeError && /fetch/i.test(err.message)) {
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		return `Couldn't reach Jami: ${cause?.code ?? cause?.message ?? err.message}. Check network access and JAMI_BASE_URL, then retry.`;
	}
	return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Run a tool body and convert any failure into an `isError` result. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (err) {
		return fail(describeError(err));
	}
}
