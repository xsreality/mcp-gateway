import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface MockAuthServer {
  origin: string;
  mcpUrl: string;
  /** Client ids the AS knows. Pre-seed to accept a pre-registered client; delete to "forget" one. */
  clients: Set<string>;
  registrations: string[];
  /** client_id of every /authorize request, probes included. */
  authorizeClientIds: string[];
  /** /authorize requests that asked for JSON, i.e. the gateway's probes. */
  probes: number;
  pkceVerified: boolean;
  resourceParamSeen: boolean;
  /** Redirect the browser back with error=access_denied instead of a code. */
  denyAuthorization: boolean;
  close(): Promise<void>;
}

/** MCP resource server + OAuth 2.1 AS. Like a real AS, /authorize answers 400 for an unknown client_id. */
export async function startMockAuthServer(): Promise<MockAuthServer> {
  const mcp = new McpServer({ name: "mock-upstream", version: "0.0.1" });
  mcp.registerTool(
    "echo",
    { description: "Echo back the input", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(mcpTransport);

  const codes = new Map<string, { code_challenge: string | null }>();
  const tokens = new Set<string>();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
    res.end(data);
  };
  const readBody = async (req: http.IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw;
  };
  const issueTokens = (res: http.ServerResponse) => {
    const at = `at-${randomUUID()}`;
    tokens.add(at);
    return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${randomUUID()}` });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, as.origin);
    const p = url.pathname;

    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, { resource: as.mcpUrl, authorization_servers: [as.origin] });
    }

    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: as.origin,
        authorization_endpoint: `${as.origin}/authorize`,
        token_endpoint: `${as.origin}/token`,
        registration_endpoint: `${as.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        scopes_supported: ["read", "write"],
      });
    }

    if (p === "/register" && req.method === "POST") {
      const meta = JSON.parse((await readBody(req)) || "{}");
      const clientId = `dcr-${randomUUID()}`;
      as.clients.add(clientId);
      as.registrations.push(clientId);
      return json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...meta });
    }

    if (p === "/authorize") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      as.authorizeClientIds.push(clientId);
      if (req.headers.accept === "application/json") as.probes++;
      if (!as.clients.has(clientId)) {
        return json(res, 400, { error: "invalid_request", error_description: `Client ID '${clientId}' is not registered` });
      }
      if (q.get("resource")) as.resourceParamSeen = true;
      const redirect = new URL(q.get("redirect_uri")!);
      if (as.denyAuthorization) {
        redirect.searchParams.set("error", "access_denied");
      } else {
        const code = `code-${randomUUID()}`;
        codes.set(code, { code_challenge: q.get("code_challenge") });
        redirect.searchParams.set("code", code);
      }
      if (q.get("state")) redirect.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }

    if (p === "/token" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      if (params.get("resource")) as.resourceParamSeen = true;
      if (params.get("grant_type") === "refresh_token") return issueTokens(res);
      const code = params.get("code");
      const entry = code ? codes.get(code) : undefined;
      if (!entry) return json(res, 400, { error: "invalid_grant" });
      const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== entry.code_challenge) {
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      }
      as.pkceVerified = true;
      codes.delete(code!);
      return issueTokens(res);
    }

    if (p === "/mcp") {
      const auth = req.headers["authorization"] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!tokens.has(token)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${as.origin}/.well-known/oauth-protected-resource"`,
        });
        return res.end();
      }
      const body = await readBody(req);
      return mcpTransport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as: MockAuthServer = {
    origin,
    mcpUrl: `${origin}/mcp`,
    clients: new Set(),
    registrations: [],
    authorizeClientIds: [],
    probes: 0,
    pkceVerified: false,
    resourceParamSeen: false,
    denyAuthorization: false,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  return as;
}
