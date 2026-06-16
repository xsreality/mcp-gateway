import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "./helpers.js";

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A mock server that is simultaneously an MCP resource server (Bearer-gated
// /mcp) and an OAuth 2.1 AS implementing RFC 9728 / 8414 / 7591, PKCE (S256)
// and the authorization-code grant. The gateway runs --no-browser; the test
// plays the browser by following the printed authorization URL.
describe("full OAuth flow (e2e)", () => {
  let server: http.Server;
  let gw: GatewayClient;
  let store: string;

  // AS state the assertions inspect.
  let dcrRegistered = false;
  let pkceVerified = false;
  let resourceParamSeen = false;

  let ORIGIN = "";
  let MCP_URL = "";

  beforeAll(async () => {
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

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, ORIGIN);
      const p = url.pathname;

      if (
        p === "/.well-known/oauth-protected-resource" ||
        p === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return json(res, 200, { resource: MCP_URL, authorization_servers: [ORIGIN] });
      }

      if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
        return json(res, 200, {
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/authorize`,
          token_endpoint: `${ORIGIN}/token`,
          registration_endpoint: `${ORIGIN}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          scopes_supported: ["read", "write"],
        });
      }

      if (p === "/register" && req.method === "POST") {
        const meta = JSON.parse((await readBody(req)) || "{}");
        dcrRegistered = true;
        return json(res, 201, {
          client_id: `dcr-${randomUUID()}`,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          ...meta,
        });
      }

      if (p === "/authorize") {
        const q = url.searchParams;
        if (q.get("resource")) resourceParamSeen = true;
        const code = `code-${randomUUID()}`;
        codes.set(code, { code_challenge: q.get("code_challenge") });
        const redirect = new URL(q.get("redirect_uri")!);
        redirect.searchParams.set("code", code);
        if (q.get("state")) redirect.searchParams.set("state", q.get("state")!);
        res.writeHead(302, { location: redirect.toString() });
        return res.end();
      }

      if (p === "/token" && req.method === "POST") {
        const params = new URLSearchParams(await readBody(req));
        if (params.get("resource")) resourceParamSeen = true;
        const code = params.get("code");
        const verifier = params.get("code_verifier");
        if (params.get("grant_type") === "refresh_token") {
          const at = `at-${randomUUID()}`;
          tokens.add(at);
          return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${randomUUID()}` });
        }
        const entry = code ? codes.get(code) : undefined;
        if (!entry) return json(res, 400, { error: "invalid_grant" });
        const challenge = b64url(createHash("sha256").update(verifier ?? "").digest());
        if (challenge !== entry.code_challenge) {
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        }
        pkceVerified = true;
        codes.delete(code);
        const at = `at-${randomUUID()}`;
        tokens.add(at);
        return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${randomUUID()}` });
      }

      if (p === "/mcp") {
        const auth = req.headers["authorization"] ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokens.has(token)) {
          res.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
          });
          return res.end();
        }
        const body = await readBody(req);
        return mcpTransport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    ORIGIN = `http://127.0.0.1:${port}`;
    MCP_URL = `${ORIGIN}/mcp`;

    store = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-oauth-"));

    gw = new GatewayClient([
      "--url", MCP_URL,
      "--scope", "read write",
      "--no-browser",
      "--token-store", store,
      "--log-level", "debug",
    ]);

    // Be the browser: when the gateway prints the authorization URL, follow it
    // and then deliver the redirect (code + state) to the loopback callback.
    let drove = false;
    gw.onStderr(async (text) => {
      const m = text.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\S*/);
      if (m && !drove) {
        drove = true;
        const authResp = await fetch(m[0], { redirect: "manual" });
        await fetch(authResp.headers.get("location")!);
      }
    });
  });

  afterAll(async () => {
    gw?.close();
    server?.close();
    if (store) await fs.rm(store, { recursive: true, force: true });
  });

  it("completes the OAuth flow and initializes against the protected server", async () => {
    const init = await gw.initialize();
    expect(init.result?.serverInfo?.name).toBe("mock-upstream");
  });

  it("performed dynamic client registration (RFC 7591)", () => {
    expect(dcrRegistered).toBe(true);
  });

  it("verified the PKCE S256 challenge", () => {
    expect(pkceVerified).toBe(true);
  });

  it("sent the RFC 8707 resource parameter", () => {
    expect(resourceParamSeen).toBe(true);
  });

  it("relays an authenticated tools/call", async () => {
    const call = await gw.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "secured" } },
    });
    expect(call.result?.content?.[0]?.text).toBe("echo: secured");
  });

  it("persists tokens and the DCR client to the store", async () => {
    const files = await fs.readdir(store);
    const saved = JSON.parse(await fs.readFile(path.join(store, files[0]!), "utf8"));
    expect(saved.tokens?.access_token).toBeTruthy();
    expect(saved.clientInformation?.client_id).toBeTruthy();
  });
});
