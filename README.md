# jami-mcp

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
**JamiDev**, the SDK for [Jami](https://jami.bio)'s creator payouts. Connect it to Claude,
Cursor, VS Code, Codex or any MCP client and your agent can create ETB checkouts, watch
them settle, reconcile orders, run Jami wallet subscriptions, preview and send payouts,
debug webhooks, and read the Jami docs while it writes your integration. Payments are processed by
[ArifPay](https://arifpay.net).

Built on the official [`jami-sdk`](https://www.npmjs.com/package/jami-sdk), so every tool
behaves exactly like the SDK and the REST API.

```bash
npx -y jami-mcp
```

## Quick start

1. Get a token: **Jami dashboard → JamiDev → Developer → API Tokens**. Start with a
   sandbox org — its `jamidev_test_…` token moves no real money.
2. Add the server to your client (below), with the token as `JAMI_TOKEN`.
3. Ask: *"Charge buyer@example.com 1,237 birr for order #1042 on Telebirr, phone 251900000001, and wait for it."*

No token yet? The server still runs. The docs, withdrawal-quote and webhook tools work
without one, so you can start building right away.

### Claude Code

```bash
claude mcp add jami -e JAMI_TOKEN=jamidev_test_xxx -- npx -y jami-mcp
```

### Claude Desktop · Cursor · Windsurf

Add to `claude_desktop_config.json`, `~/.cursor/mcp.json` or `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "jami": {
      "command": "npx",
      "args": ["-y", "jami-mcp"],
      "env": { "JAMI_TOKEN": "jamidev_test_xxx" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` — VS Code prompts for the token and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "jami-token", "description": "JamiDev API token", "password": true }
  ],
  "servers": {
    "jami": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "jami-mcp"],
      "env": { "JAMI_TOKEN": "${input:jami-token}" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.jami]
command = "npx"
args = ["-y", "jami-mcp"]
env = { JAMI_TOKEN = "jamidev_test_xxx" }
```

## Tools

| Tool | What it does | Needs token |
| --- | --- | --- |
| `jami_create_checkout` | Charge a product (`p_…` token or id) or any amount (`amount_minor` + `description`). With `gateway`: pushes the prompt to the buyer's phone. Without: returns a Jami payment link to send them. | ✓ |
| `jami_create_product` · `jami_update_product` | Create or edit products; each comes back with its public page and `p_…` token. `product_type: "recurring"` + `billing_interval` makes a subscription plan. | ✓ |
| `jami_get_product` · `jami_list_products` | Read the catalog. | ✓ |
| `jami_get_checkout_status` | Check a session once, with the failure reason when it expired. | ✓ |
| `jami_wait_for_checkout` | Wait for the buyer to finish, with progress updates. Never hangs: returns `open` at the timeout. | ✓ |
| `jami_list_orders` | Orders, newest first, paginated and filterable by status. | ✓ |
| `jami_create_subscription_link` | A single-use subscribe link (24 h) for a recurring product. The payer approves on Jami with their wallet PIN; nothing is charged before that. | ✓ |
| `jami_list_subscriptions` · `jami_get_subscription` | Subscriptions filtered by status, plan or your user id; one subscription with its charges and failure reasons. | ✓ |
| `jami_cancel_subscription` | Stop charging, at the period end by default or right away. Asks you to confirm when the client supports it. | ✓ |
| `jami_resume_subscription` | Undo a cancel you scheduled, before the period ends. A cancel the customer made can't be undone. | ✓ |
| `jami_simulate_subscription_renewal` | Sandbox only: run the next renewal now (success or failure) to test your `subscription.*` webhooks. | ✓ |
| `jami_get_balance` | Withdrawable earnings and whether the org can withdraw. | ✓ |
| `jami_quote_withdrawal` | Fee, tax and net for an amount, plus auto-pay and cap checks. Offline. | — |
| `jami_create_withdrawal` | Pay out to Telebirr, M-Pesa or CBE Birr. **Opt-in** (see Safety). | ✓ |
| `jami_get_withdrawal` · `jami_list_withdrawals` | Track payouts. | ✓ |
| `jami_verify_webhook` | Check a captured delivery's signature, and why it fails. | — |
| `jami_create_test_webhook` | Build a correctly signed test event, and optionally POST it to your local handler. | — |
| `jami_search_docs` · `jami_read_doc` | Search and read the live docs at dev.jami.bio. | — |

Every tool returns a readable markdown summary plus typed `structuredContent`. Pass
`response_format: "json"` for the raw payload. Money is always integer **santim**, and
every parameter that takes money ends in `_minor`: `amount_minor: 15000` = 150.00 ETB.

**Prompts:** `integrate_jami` (build a full integration in your stack), `go_live_checklist`,
`debug_payment`. **Resource:** `jami://reference` — fees, limits, sandbox numbers, failure
codes and webhook rules in one page.

## Safety

The defaults are set so an agent can't move money by accident.

- **Withdrawals are off** until you start the server with `--enable-withdrawals` (or
  `JAMI_ENABLE_WITHDRAWALS=true`). When they're on, clients that support elicitation ask
  you to confirm each payout, and every payout needs an `idempotency_key`, so a retry
  can never pay twice. Sandbox tokens are refused before any request is made.
- **Subscriptions need the payer's PIN.** `jami_create_subscription_link` only proposes a
  subscription. The payer signs in to Jami and approves it with their wallet PIN, so an API
  key (and so an agent) can never start charging someone's wallet on its own.
  `jami_cancel_subscription` asks you to confirm when the client supports elicitation, and
  `jami_simulate_subscription_renewal` refuses live tokens before any request is made.
- **`--read-only`** registers only the tools that read data. Use it for reporting agents.
- **Live mode is announced.** With a `jamidev_live_` token, the server tells the agent
  that checkouts charge real buyers and to confirm first.
- Tokens stay in the environment. They never appear in tool output.

## Options

```
--http                 Streamable HTTP on POST /mcp instead of stdio
--port <n>             HTTP port (default 3333)
--host <addr>          HTTP bind address (default 127.0.0.1)
--read-only            Only read tools
--enable-withdrawals   Register jami_create_withdrawal
--base-url <url>       Override the API base (default https://jami.bio/api/jamidev)
--docs-url <url>       Override the docs origin (default https://dev.jami.bio)
```

| Env | Purpose |
| --- | --- |
| `JAMI_TOKEN` | `jamidev_test_…` or `jamidev_live_…` |
| `JAMI_WEBHOOK_SECRET` | Default secret for the webhook tools |
| `JAMI_READ_ONLY`, `JAMI_ENABLE_WITHDRAWALS` | Same as the flags |

### Remote (HTTP) mode

```bash
npx -y jami-mcp --http --port 3333
# → http://127.0.0.1:3333/mcp   (health check: /healthz)
```

The HTTP server is stateless, so any number of clients can share one process. Without
`JAMI_TOKEN`, each request authenticates with its own `Authorization: Bearer jamidev_…`
header, which makes one deployment safe to share across teams. On loopback it rejects
foreign `Host` headers (DNS-rebinding protection). In HTTP mode, `jami_create_test_webhook`
never sends requests; it only returns the signed payload and a `curl` command.

## Embedding

```ts
import { createJamiServer } from 'jami-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createJamiServer({ token: process.env.JAMI_TOKEN, docsUrl: 'https://dev.jami.bio', readOnly: true, withdrawals: false });
await server.connect(new StdioServerTransport());
```

## Development

```bash
npm install
npm test          # in-memory MCP client against a mocked API
npm run build
npm run inspect   # opens the MCP Inspector on dist/index.js
```

Full guide: [dev.jami.bio/docs/mcp](https://dev.jami.bio/docs/mcp) · Support: [support@jami.bio](mailto:support@jami.bio)

MIT © Jami
