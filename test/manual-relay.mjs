// End-to-end check for Phase 1: stand up a real Streamable-HTTP MCP server with
// one tool, run the gateway against it, and drive the gateway's stdio with
// initialize / tools/list / tools/call. Exits non-zero on any mismatch.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

// --- mock upstream MCP server (Streamable HTTP, stateful single session) ---
const mcp = new McpServer({ name: "mock-upstream", version: "0.0.1" });
mcp.registerTool(
  "echo",
  { description: "Echo back the input", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mcp.connect(transport);

const httpServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    transport.handleRequest(req, res, parsed);
  });
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const port = httpServer.address().port;
const url = `http://127.0.0.1:${port}/mcp`;

// --- run the gateway ---
const gw = spawn("node", ["dist/cli.js", "--url", url, "--log-level", "warn"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let buf = "";
gw.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
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
  if (!cond) {
    console.error(`FAIL: ${label}`);
    cleanup(1);
  }
  console.error(`ok: ${label}`);
}

function cleanup(code) {
  gw.kill();
  httpServer.close();
  process.exit(code);
}

try {
  const init = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "harness", version: "0.0.1" },
    },
  });
  assert(init.result?.serverInfo?.name === "mock-upstream", "initialize routed to upstream");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert(list.result?.tools?.some((t) => t.name === "echo"), "tools/list shows upstream tool");

  const call = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "hello" } },
  });
  assert(call.result?.content?.[0]?.text === "echo: hello", "tools/call relayed round-trip");

  console.error("\nPhase 1 relay verified ✅");
  cleanup(0);
} catch (err) {
  console.error("harness error:", err);
  cleanup(1);
}

// Safety timeout.
setTimeout(() => {
  console.error("FAIL: timed out");
  cleanup(1);
}, 10000).unref();

await once(gw, "spawn");
