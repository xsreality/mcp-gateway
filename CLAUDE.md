# CLAUDE.md

Guidance for working in this repo.

## What this is

A CLI gateway that exposes a **local STDIO MCP server endpoint** and transparently proxies it to a
**remote Streamable-HTTP MCP server**, handling **OAuth 2.1 + Dynamic Client Registration** against the
remote on behalf of stdio-only MCP clients (Claude Desktop, IDE integrations).

The gateway is simultaneously an MCP **server** on the stdio side and an MCP **client + OAuth 2.1 client**
on the HTTP side. Target spec: MCP `2025-06-18` (RFC 9728 / 8414 / 7591 / 8707, OAuth 2.1, PKCE-S256).

## Commands

```bash
npm run build         # tsc -> dist/ (ESM). Shebang on cli.ts is preserved.
npm run typecheck     # tsc --noEmit
npm link              # put `mcp-gateway` on PATH (symlink to dist/cli.js); rebuild is enough after edits
node test/manual-relay.mjs   # e2e: no-auth stdio<->http relay
node test/manual-oauth.mjs   # e2e: full OAuth flow (DCR + PKCE + resource) vs a mock RS+AS
mcp-gateway --url https://server/mcp --scope "read write"   # run
```

There is no vitest suite yet — the two `test/manual-*.mjs` files are standalone harnesses that spin up a
real MCP server, run the built gateway, and assert on the round-trip. Run them after the build. Porting
them to vitest is phase 8 (todo).

## Architecture

Source in `src/` (compiles to `dist/`):

| File | Role |
|------|------|
| `cli.ts` | commander arg parsing + env fallbacks → `Config`; signals; bootstraps `Gateway`. |
| `config.ts` | `Config` type, header/URL parsing, validation, default store dir. |
| `gateway.ts` | Core: transparent JSON-RPC relay between the two transports + lazy-auth orchestration. |
| `upstream.ts` | Builds `StreamableHTTPClientTransport` (with the `authProvider`). |
| `log.ts` | pino logger — **stderr/file only**. |
| `oauth/canonical.ts` | RFC 8707 canonical resource URI (also the per-server storage key). |
| `oauth/store.ts` | Per-server JSON file: tokens, DCR client info, PKCE verifier, callback port. `0600`/`0700`, atomic write. |
| `oauth/callback.ts` | 127.0.0.1 loopback server that captures the auth code (validates `state`) + a dependency-free browser launcher. |
| `oauth/provider.ts` | `OAuthClientProvider` impl: DCR, PKCE, tokens, state, browser hand-off. |

### How the relay works
The gateway does **not** re-declare tools/resources/prompts. It wires `downstream.onmessage → upstream.send`
and `upstream.onmessage → downstream.send`, forwarding raw JSON-RPC both ways. This passes through every
current and future MCP capability. Don't "improve" this by introducing an `McpServer`/`Client` pair — the
verbatim relay is the design.

### How auth works (non-obvious)
`StreamableHTTPClientTransport.start()` makes **no network call** — OAuth is triggered on the first `send()`.
So the gateway authenticates lazily: the first forwarded message hits a 401, the SDK runs discovery/DCR and
calls `provider.redirectToAuthorization` (opens the browser), and the `send()` rejects with
`UnauthorizedError`. `Gateway.sendUpstream` catches that, waits for the loopback redirect, calls
`transport.finishAuth(code)`, then retries the send. Servers needing no auth never trigger any of this.

The SDK's `auth()` helper owns discovery (RFC 9728 → 8414), DCR (RFC 7591), token exchange/refresh, and the
RFC 8707 `resource` parameter. We only supply persistence, the redirect URL, and the browser step.

## Conventions / gotchas — read before editing

- **stdout is the MCP protocol channel.** Never `console.log` or write to `process.stdout`. All logging,
  prompts, and human-facing text go to **stderr or a file** (see `log.ts`, and `process.stderr.write` in
  `provider.ts`). A stray stdout write corrupts the JSON-RPC stream.
- **The loopback callback binds at startup**, not lazily. The SDK reads `redirect_uris` (needing the bound
  port) *during DCR*, before the browser step. It stays open for the session so token-expiry re-auth works
  without a port change. The chosen port is persisted (`store.redirectPort`) so the registered `redirect_uri`
  stays byte-identical across runs (exact-match requirement).
- **No token passthrough.** Tokens the gateway obtains are for the remote MCP server only; never forward the
  local client's identity as upstream auth, never reuse a token across servers.
- **Credentials are keyed by canonical URI** (`canonical.ts`), stored under `~/.mcp-gateway` by default
  (`--token-store`). Never log tokens or auth codes.
- TypeScript is strict ESM with `verbatimModuleSyntax` — use `import type` for type-only imports, and
  `.js` extensions on relative imports.
