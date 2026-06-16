import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "./helpers.js";

// Stands up a real Streamable-HTTP MCP server with one tool, runs the gateway
// against it, and drives initialize / tools/list / tools/call through the
// gateway's stdio. Verifies the verbatim JSON-RPC relay in both directions.
describe("no-auth stdio<->http relay (e2e)", () => {
  let httpServer: http.Server;
  let gw: GatewayClient;

  beforeAll(async () => {
    const mcp = new McpServer({ name: "mock-upstream", version: "0.0.1" });
    mcp.registerTool(
      "echo",
      { description: "Echo back the input", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcp.connect(transport);

    httpServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      });
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    const port = (httpServer.address() as import("node:net").AddressInfo).port;

    gw = new GatewayClient(["--url", `http://127.0.0.1:${port}/mcp`, "--log-level", "warn"]);
  });

  afterAll(() => {
    gw?.close();
    httpServer?.close();
  });

  it("routes initialize to the upstream server", async () => {
    const init = await gw.initialize();
    expect(init.result?.serverInfo?.name).toBe("mock-upstream");
  });

  it("relays tools/list from the upstream", async () => {
    const list = await gw.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.result?.tools?.some((t: { name: string }) => t.name === "echo")).toBe(true);
  });

  it("relays a tools/call round-trip", async () => {
    const call = await gw.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    });
    expect(call.result?.content?.[0]?.text).toBe("echo: hello");
  });
});
