import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Config } from "./config.js";

/**
 * Builds the upstream Streamable-HTTP client transport that talks to the remote
 * MCP server. When an `authProvider` is supplied, the SDK drives OAuth discovery,
 * DCR, token refresh, and the RFC 8707 resource parameter automatically.
 */
export function createUpstreamTransport(
  config: Config,
  authProvider?: OAuthClientProvider,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(config.url, {
    authProvider,
    requestInit: {
      headers: config.headers,
    },
  });
}
