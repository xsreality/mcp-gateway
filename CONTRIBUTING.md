# Contributing

Thanks for your interest in improving `mcp-gateway`. This document covers local
setup, the conventions the codebase relies on, and how releases are cut.

## Prerequisites

- Node.js **≥ 20** (the gateway uses native `fetch` and Web Crypto for PKCE).
- npm (the repo ships a `package-lock.json`; use `npm ci` for reproducible installs).

## Getting started

```bash
git clone https://github.com/xsreality/mcp-gateway.git
cd mcp-gateway
npm ci                # install pinned dependencies
npm run build         # tsc -> dist/ (ESM)
npm link              # put `mcp-gateway` on your PATH (symlink to dist/cli.js)
```

`npm link` points at `dist/cli.js`, so after the first link you only need
`npm run build` to pick up source changes — no need to re-link.

### Useful commands

| Command | What it does |
|---------|--------------|
| `npm run build` | `tsc` → `dist/` (ESM). The shebang on `cli.ts` is preserved. |
| `npm run dev` | `tsc --watch`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | `vitest run` — unit + e2e (a global setup builds `dist/` first). |
| `npm run test:unit` | Unit tests only (`test/unit`). |
| `npm run test:e2e` | End-to-end tests only (`test/e2e`). |
| `npm run test:watch` | `vitest` in watch mode. |
| `npm run coverage` | `vitest run --coverage`. |

## Project layout

Source lives in `src/` and compiles to `dist/`:

| File | Role |
|------|------|
| `cli.ts` | commander arg parsing + env fallbacks → `Config`; signals; bootstraps `Gateway`. |
| `config.ts` | `Config` type, header/URL parsing, validation, defaults. |
| `gateway.ts` | Transparent JSON-RPC relay between the two transports + lazy-auth orchestration. |
| `upstream.ts` | Builds the `StreamableHTTPClientTransport` (with the `authProvider`). |
| `log.ts` | pino logger — **stderr/file only**. |
| `oauth/canonical.ts` | RFC 8707 canonical resource URI (also the per-server storage key). |
| `oauth/store.ts` | `AuthStore` over a `SecretBackend`; ships `FileBackend`. |
| `oauth/keychain.ts` | `KeychainBackend` + `openKeychain` (OS keychain via `@napi-rs/keyring`). |
| `oauth/store-factory.ts` | `createAuthStore` — backend selection, fallback, and migration. |
| `oauth/callback.ts` | Loopback server that captures the auth code + browser launcher. |
| `oauth/provider.ts` | `OAuthClientProvider` impl: DCR, PKCE, tokens, state, browser hand-off. |

## Conventions — read before editing

- **stdout is the MCP protocol channel.** Never `console.log` or write to
  `process.stdout` — that corrupts the JSON-RPC stream. All logging, prompts, and
  human-facing text go to **stderr or a file** (see `log.ts`).
- **Verbatim relay.** The gateway forwards raw JSON-RPC both ways; it does **not**
  re-declare tools/resources/prompts. Don't replace this with an `McpServer`/`Client`
  pair — the pass-through is the design.
- **No token passthrough.** Tokens the gateway obtains are for the remote MCP server
  only; never forward the local client's identity upstream, never reuse a token across
  servers, and never log tokens or auth codes.
- **Strict ESM with `verbatimModuleSyntax`** — use `import type` for type-only imports
  and `.js` extensions on relative imports.

## Tests

- `test/unit/*.test.ts` import from `src/` directly (canonical URI, config, store, the
  backend seam, keychain, and the store factory).
- `test/e2e/*.test.ts` spin up a real MCP server (no-auth, plus a mock RS+AS for OAuth)
  and drive the **built** gateway as a subprocess over its stdio channel. e2e is pinned
  to the file credential backend so it never depends on the host's OS keychain.

Run `npm test` before opening a PR. New behavior should come with tests.

## Pull requests

1. Branch off `main` (e.g. `feat/...` or `fix/...`).
2. Keep the change focused; update `README.md` / `CLAUDE.md` when behavior or flags change.
3. Ensure `npm run typecheck` and `npm test` pass — CI runs both on Node 20 and 22.

## Releasing

Releases are published to npm automatically by
[`.github/workflows/release.yml`](.github/workflows/release.yml) when a GitHub release is
published. The package name is `@xsreality/mcp-gateway`.

**One-time setup:** add an npm automation token with publish access to the package as a
repository secret named `NPM_TOKEN`:

```bash
gh secret set NPM_TOKEN   # paste the token when prompted
```

Provenance is attached automatically (the workflow has `id-token: write` and the repo is
public) — no extra configuration needed.

**To cut a release:**

1. Bump the version on a branch and merge it to `main`:
   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   # commit package.json + package-lock.json, open a PR, merge
   ```
   Use [semver](https://semver.org/): `patch` for fixes, `minor` for backwards-compatible
   features, `major` for breaking changes.
2. From an up-to-date `main`, create the GitHub release:
   ```bash
   git checkout main && git pull
   gh release create vX.Y.Z --generate-notes --title "vX.Y.Z"
   ```

Publishing the release triggers the workflow, which verifies the tag matches
`package.json`, runs the test suite, then `npm publish --provenance`.

> **Order matters:** the version on `main` must already equal `X.Y.Z` before you create
> the `vX.Y.Z` release — the workflow fails fast on a mismatch. This is why the version
> bump lands (via its PR) *before* the release is created.
