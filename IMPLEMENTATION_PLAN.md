# MCP Gateway — Implementation Plan

## 1. Goal

A CLI tool that exposes a **local STDIO MCP server endpoint** and transparently proxies
it to a **remote Streamable-HTTP MCP server**. The gateway handles **OAuth 2.1**
authorization (including **Dynamic Client Registration**) against the remote server on
behalf of the local client.

This lets stdio-only MCP clients (e.g. Claude Desktop, IDE MCP integrations) talk to
OAuth-protected remote MCP servers without any native OAuth support of their own.

```
┌──────────────┐   stdio (JSON-RPC)   ┌──────────────┐  Streamable HTTP (JSON-RPC) ┌──────────────┐
│ Local MCP    │ ───────────────────▶ │ MCP Gateway  │ ──────────────────────────▶ │ Remote MCP   │
│ client       │ ◀─────────────────── │ (this tool)  │ ◀────────────────────────── │ server (RS)  │
│ (Claude etc.)│                      │              │      Bearer <access token>   └──────┬───────┘
└──────────────┘                      └──────┬───────┘                                     │
                                             │ OAuth 2.1 + DCR (RFC 7591/8414/9728/8707)   │
                                             ▼                                             ▼
                                      system browser  ◀────── loopback callback ───▶ Authorization Server
```

## 2. Standards baseline (MCP spec `2025-06-18`)

The gateway is an **MCP client** and an **OAuth 2.1 client** toward the remote server.
Conformance targets:

| Spec | Role in the gateway |
|------|---------------------|
| OAuth 2.1 (draft-ietf-oauth-v2-1-13) | Authorization-code grant + refresh, PKCE mandatory |
| RFC 9728 — Protected Resource Metadata | Parse `WWW-Authenticate` on 401 → discover RS metadata → `authorization_servers` |
| RFC 8414 — Authorization Server Metadata | Discover `/authorize`, `/token`, `/register` endpoints |
| RFC 7591 — Dynamic Client Registration | `POST /register` to obtain `client_id` (+ secret) with no manual setup |
| RFC 8707 — Resource Indicators | Send `resource` param (canonical RS URI) on **both** authorize and token requests |
| PKCE (S256) | Required for the public-client auth-code flow |

Key required client behaviors:
- Parse `WWW-Authenticate` headers and react to `401`.
- `MUST` send `resource` parameter (canonical server URI, no fragment, no trailing slash) on authorization **and** token requests, regardless of AS support.
- Mandatory PKCE; use + verify `state`; exact pre-registered `redirect_uri`.
- Redirect URI `MUST` be `localhost`/loopback or HTTPS → loopback satisfies this.
- Secure, scoped token storage; rotate refresh tokens for public clients.
- Never send a token to anyone but the server its AS issued it for (no passthrough).

## 3. Stack

- **Language/runtime:** TypeScript on Node.js ≥ 20 (native `fetch`, Web Crypto for PKCE).
- **MCP SDK:** `@modelcontextprotocol/sdk` — provides `StdioServerTransport`,
  `StreamableHTTPClientTransport`, the `OAuthClientProvider` interface, and the
  `auth()` discovery/registration/token helper used by the transport on `401`.
- **CLI parsing:** `commander` (or `yargs`).
- **Browser launch:** `open`.
- **Token/registration storage:** local JSON files under a per-server directory, `chmod 600`.
- **Logging:** `pino` → **stderr / file only** (stdout is the MCP protocol channel — see §8).
- **Tests:** `vitest`; `nock`/`msw` for HTTP mocking.

## 4. Architecture & core design decision

### Transparent message relay (not semantic re-implementation)

The gateway does **not** re-declare tools/resources/prompts. It wires two SDK transports
together and relays raw JSON-RPC messages in both directions. This passes through every
current and future MCP capability (tools, resources, prompts, sampling, notifications,
progress, cancellation) without enumeration.

```ts
// pseudocode
downstream.onmessage = (msg) => upstream.send(msg);   // client → remote
upstream.onmessage   = (msg) => downstream.send(msg); // remote → client
downstream.onclose = () => upstream.close();
upstream.onclose   = () => downstream.close();
```

- `downstream` = `StdioServerTransport` (talks to the local client over stdin/stdout).
- `upstream`   = `StreamableHTTPClientTransport(url, { authProvider, requestInit })`.

The upstream transport owns OAuth: on a `401` it throws `UnauthorizedError`; the gateway
catches it, completes the browser flow, then calls `transport.finishAuth(code)` and
reconnects. After tokens are obtained the transport injects `Authorization: Bearer …` on
every request automatically.

### Components / file layout

```
mcpgateway/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ cli.ts              # arg parsing → Config; process bootstrap, signal handling
│  ├─ config.ts           # Config type, validation, env-var fallbacks
│  ├─ gateway.ts          # wires stdio <-> http transports; relay + lifecycle
│  ├─ upstream.ts         # builds StreamableHTTPClientTransport + reconnection
│  ├─ oauth/
│  │  ├─ provider.ts      # OAuthClientProvider impl (DCR, tokens, PKCE, redirect)
│  │  ├─ callback.ts      # loopback HTTP server to capture the auth code
│  │  ├─ store.ts         # on-disk token + client-registration persistence
│  │  └─ canonical.ts     # RFC 8707 canonical resource URI derivation
│  └─ log.ts              # pino to stderr/file
└─ test/
```

## 5. OAuth flow (loopback callback)

1. Gateway connects upstream with no token → remote returns `401 + WWW-Authenticate`.
2. SDK `auth()`: fetch RS metadata (`/.well-known/oauth-protected-resource`), pick an
   `authorization_server`, fetch AS metadata (`/.well-known/oauth-authorization-server`).
3. **DCR:** if no stored `client_id`, `POST /register` (RFC 7591) with client metadata
   (`redirect_uris=[http://127.0.0.1:<port>/callback]`, `token_endpoint_auth_method`,
   `grant_types`, `response_types`, `scope`, `client_name`). Persist the returned
   credentials. If the AS has no `/register`, fall back to `--client-id`/`--client-secret`.
4. Generate PKCE (`code_verifier`/`code_challenge` S256) + random `state`; persist verifier.
5. Start loopback server on `127.0.0.1:<port>`; open system browser to the authorize URL
   including `code_challenge`, `state`, **and `resource`** (canonical RS URI).
6. AS redirects back to the loopback; gateway validates `state`, captures `code`, shows a
   "you can close this tab" page, shuts the loopback server down.
7. `transport.finishAuth(code)` → token request with `code_verifier` **and `resource`** →
   store access + refresh tokens.
8. Reconnect upstream; relay begins. On `401`/expiry, refresh via refresh token
   (rotating); if refresh fails, re-run the browser flow.

### `OAuthClientProvider` responsibilities (`src/oauth/provider.ts`)

- `redirectUrl` → `http://127.0.0.1:<port>/callback`
- `clientMetadata` → DCR registration request body
- `clientInformation()` / `saveClientInformation()` → DCR result persistence
- `tokens()` / `saveTokens()` → token persistence
- `codeVerifier()` / `saveCodeVerifier()` → PKCE persistence
- `state()` → CSRF state generation/verification
- `redirectToAuthorization(url)` → `open(url)` + arm loopback listener

## 6. CLI interface

```
mcp-gateway --url <remote-streamable-http-url> [options]
```

| Flag | Purpose |
|------|---------|
| `--url <url>` (required) | Remote Streamable-HTTP MCP server endpoint |
| `--header <k:v>` (repeatable) | Static headers (non-OAuth auth, routing, tenant) |
| `--scope <scopes>` | OAuth scopes to request |
| `--client-name <name>` | `client_name` used in DCR (default `mcp-gateway`) |
| `--client-id` / `--client-secret` | Pre-registered creds (skip DCR) |
| `--no-dcr` | Disable Dynamic Client Registration |
| `--callback-port <n>` | Loopback callback port (default: ephemeral, persisted per server) |
| `--auth-timeout <sec>` | Max wait for browser authorization (default 300) |
| `--token-store <dir>` | Credential storage dir (default `~/.mcp-gateway`) |
| `--no-browser` | Print the auth URL instead of auto-opening |
| `--log-level <level>` / `--log-file <path>` | Diagnostics (stderr/file only) |

Every flag also has an env-var fallback (e.g. `MCP_GATEWAY_URL`) so the tool drops cleanly
into MCP client config blocks. Example client config:

```json
{ "mcpServers": { "remote": {
  "command": "mcp-gateway",
  "args": ["--url", "https://mcp.example.com/mcp", "--scope", "read write"]
}}}
```

## 7. Implementation phases

1. **[done] Scaffold** — package.json, tsconfig (ESM), pino logger to stderr, bin entry.
2. **[done] Transparent relay (no auth)** — stdio↔streamable-HTTP message relay; clean
   shutdown on either side closing. *Verified: `test/manual-relay.mjs`.*
3. **[done] CLI + config** — commander wiring, validation, env fallbacks, `--header` passthrough.
4. **[done] Storage layer** — per-server file keyed by canonical-URI hash; `0600`/`0700`
   perms; atomic write; token + registration + persisted callback port; corruption-tolerant.
5. **[done] OAuthClientProvider + loopback callback** — DCR, PKCE, state, browser open,
   code capture; canonical `resource` derivation (RFC 8707).
6. **[done] Auth wired into upstream** — provider passed to `StreamableHTTPClientTransport`;
   lazy `UnauthorizedError` → browser flow → `finishAuth` → retry; SDK auto-refresh on expiry.
   *Verified end-to-end against a mock RS+AS (DCR + PKCE + resource): `test/manual-oauth.mjs`.*
7. **[todo] Resilience** — upstream reconnect/backoff, mid-session re-auth path under load,
   headless `--no-browser` paste fallback hardening.
8. **[todo] Tests & docs** — port the manual harnesses to vitest; unit tests for canonical
   URI / store / provider; README + client-config examples; CI.

## 8. Critical gotchas

- **stdout is sacred.** The stdio transport uses stdout for JSON-RPC framing. *All* logging,
  prompts, and diagnostics go to **stderr or a file**. A stray `console.log` corrupts the
  protocol stream. Lint rule to ban `console.log`.
- **`resource` parameter is mandatory** on both authorize and token requests, even if the AS
  ignores it; derive the canonical URI (lowercase scheme/host, no fragment, no trailing
  slash) from `--url`.
- **No token passthrough.** The token the gateway obtains is for the remote MCP server only.
  Never forward the local client's identity/headers as auth, and never reuse this token elsewhere.
- **Loopback redirect only.** Redirect URI must be `127.0.0.1`/`localhost`; bind the callback
  server to loopback only and tear it down immediately after the code is captured.
- **Secure storage.** Token/registration files `chmod 600` under a per-user dir; consider OS
  keychain as a later enhancement. Never log tokens or codes.
- **Session id handling.** `StreamableHTTPClientTransport` manages `Mcp-Session-Id`; on
  session loss the upstream may `404` — treat as reconnect, re-init.
- **Refresh rotation.** Public clients must accept rotated refresh tokens and persist the new one.

## 9. Open items to confirm later

- Single-upstream per process (recommended for clean stdio semantics) vs. multiplexing.
- Whether to add OS-keychain storage and `device_code` / headless paste fallback (the
  current plan uses loopback only).
- Scope-change handling (re-consent when requested scopes differ from stored grant).

---
### References
- [MCP Authorization spec (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- RFC 7591 (DCR), RFC 8414 (AS metadata), RFC 9728 (PR metadata), RFC 8707 (Resource Indicators), OAuth 2.1 draft-ietf-oauth-v2-1-13
