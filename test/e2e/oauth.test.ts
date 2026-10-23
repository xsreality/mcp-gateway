import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "./helpers.js";
import { startMockAuthServer, type MockAuthServer } from "./mock-as.js";

// The gateway runs --no-browser; the test plays the browser by following the
// printed authorization URL.
describe("full OAuth flow (e2e)", () => {
  let as: MockAuthServer;
  let gw: GatewayClient;
  let store: string;

  beforeAll(async () => {
    as = await startMockAuthServer();
    store = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-oauth-"));
    gw = new GatewayClient([
      "--url", as.mcpUrl,
      "--scope", "read write",
      "--no-browser",
      "--token-store", store,
      "--log-level", "debug",
    ]);
    gw.actAsBrowser();
  });

  afterAll(async () => {
    gw?.close();
    await as?.close();
    if (store) await fs.rm(store, { recursive: true, force: true });
  });

  it("completes the OAuth flow and initializes against the protected server", async () => {
    const init = await gw.initialize();
    expect(init.result?.serverInfo?.name).toBe("mock-upstream");
  });

  it("performed dynamic client registration (RFC 7591)", () => {
    expect(as.registrations).toHaveLength(1);
  });

  it("does not probe a client it just registered", () => {
    expect(as.probes).toBe(0);
  });

  it("verified the PKCE S256 challenge", () => {
    expect(as.pkceVerified).toBe(true);
  });

  it("sent the RFC 8707 resource parameter", () => {
    expect(as.resourceParamSeen).toBe(true);
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
    expect(saved.clientInformation?.client_id).toBe(as.registrations[0]);
  });
});
