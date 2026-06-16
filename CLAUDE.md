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
npm test              # vitest run — unit + e2e (a global setup builds dist/ first)
npm run test:unit     # vitest run test/unit  (canonical / config / store)
npm run test:e2e      # vitest run test/e2e   (relay + full OAuth round-trip)
npm run test:watch    # vitest in watch mode
npm run coverage      # vitest run --coverage
mcp-gateway --url https://server/mcp --scope "read write"   # run
```

Tests live under `test/`:

- `test/unit/*.test.ts` — import from `src/` directly; cover `oauth/canonical.ts`, `config.ts`,
  `oauth/store.ts`.
- `test/e2e/*.test.ts` — spin up a real MCP server (no-auth, and a mock RS+AS for OAuth), run the
  **built** gateway as a subprocess, and assert on the stdio JSON-RPC round-trip. `test/e2e/helpers.ts`
  holds the `GatewayClient` driver; `test/global-setup.ts` builds `dist/` once before any test runs.

Because the e2e tests exercise the gateway in a subprocess, v8 coverage only reflects the unit-tested
modules in-process — the relay/provider/CLI are covered functionally but not as instrumented lines.

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
| `oauth/store.ts` | `AuthStore` (JSON parse/merge/cache/serialize + corruption tolerance) over a `SecretBackend`; ships `FileBackend` (per-server JSON, `0600`/`0700`, atomic write). Holds tokens, DCR client info, PKCE verifier, callback port. |
| `oauth/keychain.ts` | `KeychainBackend` + `openKeychain` — stores the blob in the OS keychain via `@napi-rs/keyring` (lazy dynamic import; throws `KeychainUnavailable`). |
| `oauth/store-factory.ts` | `createAuthStore` — picks backend from `--credential-store` (`auto`/`keychain`/`file`), auto-falls back to file, migrates a legacy on-disk blob into the keychain. |
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
- **Credentials are keyed by canonical URI** (`canonical.ts`). By default (`--credential-store auto`) they
  live in the OS keychain (account = canonical URI, service = `mcp-gateway`), falling back to JSON files
  under `~/.mcp-gateway` (`--token-store`) when no keychain is reachable; `keychain`/`file` force one
  backend. The keychain native module (`@napi-rs/keyring`) is **lazily** imported so file-only users never
  load it. On first keychain use any legacy on-disk blob is migrated in and the file deleted. Never log
  tokens or auth codes.
- TypeScript is strict ESM with `verbatimModuleSyntax` — use `import type` for type-only imports, and
  `.js` extensions on relative imports.
