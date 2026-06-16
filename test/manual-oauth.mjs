// End-to-end check for the OAuth phases: a mock server that is simultaneously an
// MCP resource server (Bearer-gated /mcp) and an OAuth 2.1 Authorization Server
// implementing RFC 9728 (PR metadata), RFC 8414 (AS metadata), RFC 7591 (DCR),
// PKCE (S256) and the authorization-code grant. The gateway runs with
// --no-browser; this harness plays the browser by following the printed URL.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- MCP server (Streamable HTTP) behind Bearer auth ---
const mcp = new McpServer({ name: "mock-upstream", version: "0.0.1" });
mcp.registerTool(
  "echo",
  { description: "Echo back the input", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(mcpTransport);

// --- AS state ---
const clients = new Map(); // client_id -> { redirect_uris }
const codes = new Map(); // code -> { code_challenge, redirect_uri, resource }
const tokens = new Set(); // issued access tokens
let dcrRegistered = false;
let pkceVerified = false;
let resourceParamSeen = false;

let ORIGIN = "";
let MCP_URL = "";

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  // RFC 9728 protected resource metadata
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
    return json(res, 200, { resource: MCP_URL, authorization_servers: [ORIGIN] });
  }

  // RFC 8414 authorization server metadata
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

  // RFC 7591 dynamic client registration
  if (p === "/register" && req.method === "POST") {
    const meta = JSON.parse((await readBody(req)) || "{}");
    const client_id = `dcr-${randomUUID()}`;
    clients.set(client_id, { redirect_uris: meta.redirect_uris ?? [] });
    dcrRegistered = true;
    return json(res, 201, {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...meta,
    });
  }

  // Authorization endpoint
  if (p === "/authorize") {
    const q = url.searchParams;
    if (q.get("resource")) resourceParamSeen = true;
    const code = `code-${randomUUID()}`;
    codes.set(code, {
      code_challenge: q.get("code_challenge"),
      redirect_uri: q.get("redirect_uri"),
      resource: q.get("resource"),
    });
    const redirect = new URL(q.get("redirect_uri"));
    redirect.searchParams.set("code", code);
    if (q.get("state")) redirect.searchParams.set("state", q.get("state"));
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }

  // Token endpoint
  if (p === "/token" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    if (params.get("resource")) resourceParamSeen = true;
    const code = params.get("code");
    const verifier = params.get("code_verifier");
    const entry = code ? codes.get(code) : undefined;
    if (params.get("grant_type") === "refresh_token") {
      const at = `at-${randomUUID()}`;
      tokens.add(at);
      return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${randomUUID()}` });
    }
    if (!entry) return json(res, 400, { error: "invalid_grant" });
    const challenge = b64url(createHash("sha256").update(verifier ?? "").digest());
    if (challenge !== entry.code_challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
    pkceVerified = true;
    codes.delete(code);
    const at = `at-${randomUUID()}`;
    tokens.add(at);
    return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${randomUUID()}` });
  }

  // Protected MCP resource
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

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
ORIGIN = `http://127.0.0.1:${port}`;
MCP_URL = `${ORIGIN}/mcp`;

// fresh token store so the run actually exercises DCR + the full flow
const store = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-"));

// --- run the gateway (no real browser) ---
const gw = spawn(
  "node",
  ["dist/cli.js", "--url", MCP_URL, "--scope", "read write", "--no-browser", "--token-store", store, "--log-level", "debug"],
  { stdio: ["pipe", "pipe", "pipe"] },
);

const pending = new Map();
let outBuf = "";
gw.stdout.on("data", (chunk) => {
  outBuf += chunk.toString();
  let nl;
  while ((nl = outBuf.indexOf("\n")) !== -1) {
    const line = outBuf.slice(0, nl).trim();
    outBuf = outBuf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});

// Watch stderr for the authorization URL, then play the browser.
let drove = false;
gw.stderr.on("data", async (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  const m = text.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\S*/);
  if (m && !drove) {
    drove = true;
    const authResp = await fetch(m[0], { redirect: "manual" });
    const location = authResp.headers.get("location");
    await fetch(location); // deliver code+state to the gateway's loopback callback
  }
});

function send(obj) {
  gw.stdin.write(JSON.stringify(obj) + "\n");
}
function request(obj) {
  return new Promise((resolve) => {
    pending.set(obj.id, resolve);
    send(obj);
  });
}
function assert(cond, label) {
  console.error(`${cond ? "ok" : "FAIL"}: ${label}`);
  if (!cond) cleanup(1);
}
function cleanup(code) {
  gw.kill();
  server.close();
  fs.rm(store, { recursive: true, force: true }).finally(() => process.exit(code));
}

setTimeout(() => {
  console.error("FAIL: timed out");
  cleanup(1);
}, 15000).unref();

try {
  const init = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "0.0.1" } },
  });
  assert(init.result?.serverInfo?.name === "mock-upstream", "initialize succeeds after OAuth flow");
  assert(dcrRegistered, "dynamic client registration (RFC 7591) happened");
  assert(pkceVerified, "PKCE S256 verifier matched challenge");
  assert(resourceParamSeen, "RFC 8707 resource parameter was sent");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "secured" } },
  });
  assert(call.result?.content?.[0]?.text === "echo: secured", "authenticated tools/call round-trip");

  // verify persistence: tokens + DCR client were written to the store
  const files = await fs.readdir(store);
  const saved = JSON.parse(await fs.readFile(path.join(store, files[0]), "utf8"));
  assert(!!saved.tokens?.access_token, "tokens persisted to store");
  assert(!!saved.clientInformation?.client_id, "DCR client persisted to store");

  console.error("\nOAuth phases verified ✅");
  cleanup(0);
} catch (err) {
  console.error("harness error:", err);
  cleanup(1);
}
