# mcp-gateway

![CI](https://github.com/xsreality/mcp-gateway/actions/workflows/ci.yml/badge.svg)

A small CLI that exposes a **local STDIO MCP endpoint** and proxies it to a **remote Streamable-HTTP MCP
server** — handling **OAuth 2.1** (including **Dynamic Client Registration**) on your behalf.

Use it to connect stdio-only MCP clients (Claude Desktop, IDE MCP integrations, anything that launches an
MCP server as a subprocess) to remote, OAuth-protected MCP servers that those clients can't reach directly.

```
┌──────────────┐   stdio    ┌──────────────┐  Streamable HTTP + OAuth   ┌──────────────┐
│ MCP client   │ ─────────▶ │ mcp-gateway  │ ─────────────────────────▶ │ Remote MCP   │
│ (Claude etc.)│ ◀───────── │              │ ◀───────────────────────── │ server       │
└──────────────┘            └──────────────┘                            └──────────────┘
```

The gateway is transparent: it forwards raw MCP messages both ways, so every tool, resource, prompt, and
notification the remote server offers passes straight through.

## Requirements

- Node.js ≥ 20

## Install

```bash
npm install -g @xsreality/mcp-gateway
```

Or run without installing:

```bash
npx @xsreality/mcp-gateway --url https://mcp.example.com/mcp
```

### From source

```bash
git clone https://github.com/xsreality/mcp-gateway.git && cd mcp-gateway
npm install
npm run build
npm link          # puts `mcp-gateway` on your PATH
```

To remove the global link: `npm rm -g @xsreality/mcp-gateway`.

## Usage

```bash
mcp-gateway --url https://mcp.example.com/mcp
```

On first connection to a protected server, the gateway opens your browser to authorize. After you approve,
tokens are cached locally and reused on subsequent runs (and refreshed automatically when they expire).
Servers that don't require auth work with no extra flags.

### Use from an MCP client

Point your client at the `mcp-gateway` command:

```json
{
  "mcpServers": {
    "remote": {
      "command": "npx",
      "args": ["-y", "@xsreality/mcp-gateway", "--url", "https://mcp.example.com/mcp", "--scope", "read write"]
    }
  }
}
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--url <url>` | **(required)** Remote Streamable-HTTP MCP server endpoint | `$MCP_GATEWAY_URL` |
| `--header <k:v>` | Static header forwarded upstream, `"Key: value"` (repeatable) | — |
| `--scope <scopes>` | OAuth scopes to request | `$MCP_GATEWAY_SCOPE` |
| `--client-name <name>` | `client_name` used during Dynamic Client Registration | `mcp-gateway` |
| `--client-id <id>` | Pre-registered OAuth client id (skips DCR) | `$MCP_GATEWAY_CLIENT_ID` |
| `--client-secret <secret>` | Pre-registered OAuth client secret (confidential client) | `$MCP_GATEWAY_CLIENT_SECRET` |
| `--no-dcr` | Disable Dynamic Client Registration (requires `--client-id`) | DCR enabled |
| `--callback-port <port>` | Fixed loopback port for the OAuth redirect | auto (persisted) |
| `--auth-timeout <seconds>` | How long to wait for you to finish authorizing in the browser | `300` |
| `--token-store <dir>` | Where tokens + client registration are stored | `~/.mcp-gateway` |
| `--no-browser` | Print the authorization URL instead of opening a browser (headless) | opens browser |
| `--log-level <level>` | `trace` `debug` `info` `warn` `error` `silent` (stderr/file only) | `info` |
| `--log-file <path>` | Write logs to a file instead of stderr | stderr |

Every flag has a `MCP_GATEWAY_*` environment-variable fallback where shown, so it drops cleanly into client
config blocks.

## Authentication

- **Standards:** OAuth 2.1 authorization-code flow with mandatory PKCE, RFC 9728 protected-resource metadata
  discovery, RFC 8414 authorization-server metadata, RFC 7591 Dynamic Client Registration, and the RFC 8707
  `resource` indicator.
- **No setup needed for DCR servers:** the gateway registers itself automatically and caches the client id.
- **Servers without DCR:** pass `--client-id` (and `--client-secret` if it's a confidential client) and
  `--no-dcr`.
- **Headless / remote machines:** use `--no-browser`; the gateway prints the URL to open, and listens on a
  loopback port for the redirect. (You'll need to be able to reach that loopback port — e.g. over an SSH
  tunnel — to complete the flow.)

### Where credentials live

Tokens, the registered client, and the chosen callback port are stored as one JSON file per server (keyed by
the server's canonical URL) under `--token-store` (default `~/.mcp-gateway`), written with `0600` permissions.
Delete that directory to force re-authorization.

## Logging

The stdio channel (stdout) carries the MCP protocol, so **all logs go to stderr** (or `--log-file`). If your
client shows the gateway's diagnostics mixed into its logs, lower `--log-level` (e.g. `warn`) or redirect to
a file.

## Troubleshooting

- **Browser didn't open** — copy the URL printed on stderr, or run with `--no-browser`.
- **`authorization timed out`** — you didn't finish within `--auth-timeout`; just reconnect to retry.
- **Re-authorize from scratch** — delete the server's file under `~/.mcp-gateway` (or the whole directory).
- **Corporate proxy / extra auth** — forward static headers with repeated `--header "Key: value"`.
- **Stuck after the server changed its auth** — clear the token store; cached discovery/registration may be stale.

## License

[MIT](LICENSE) © Abhinav Sonkar
