import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalResourceUri } from "../../src/oauth/canonical.js";
import { storeKey, type StoredAuth } from "../../src/oauth/store.js";
import { GatewayClient } from "./helpers.js";
import { startMockAuthServer, type MockAuthServer } from "./mock-as.js";

// The store starts with a DCR client from an earlier run, as if the server
// behind the URL had been swapped for one that never saw that client.
describe("cached DCR client the server does not know (e2e)", () => {
  let as: MockAuthServer;
  let gw: GatewayClient | undefined;
  let store: string;
  let storeFile: string;

  const seed = (data: StoredAuth) => fs.writeFile(storeFile, JSON.stringify(data));
  const stored = async (): Promise<StoredAuth> => JSON.parse(await fs.readFile(storeFile, "utf8"));
  const cachedClient = (clientId: string): StoredAuth => ({
    clientInformation: { client_id: clientId, redirect_uris: ["http://127.0.0.1/callback"] },
  });
  const start = (...extra: string[]) => {
    gw = new GatewayClient(["--url", as.mcpUrl, "--no-browser", "--token-store", store, ...extra]);
    gw.actAsBrowser();
    return gw;
  };
  const runUntilExit = async (...extra: string[]) => {
    const gw = start(...extra);
    void gw.initialize();
    await gw.exited;
  };

  beforeEach(async () => {
    as = await startMockAuthServer();
    store = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-stale-"));
    storeFile = path.join(store, `${storeKey(canonicalResourceUri(new URL(as.mcpUrl)))}.json`);
  });

  afterEach(async () => {
    gw?.close();
    gw = undefined;
    await as.close();
    await fs.rm(store, { recursive: true, force: true });
  });

  it("registers again and completes the OAuth round-trip", async () => {
    await seed(cachedClient("stale-client"));
    const init = await start().initialize();

    expect(init.result?.serverInfo?.name).toBe("mock-upstream");
    expect(as.probes).toBe(1);
    expect(as.registrations).toHaveLength(1);
    const fresh = as.registrations[0];
    expect(as.authorizeClientIds).toEqual(["stale-client", fresh]);
    expect((await stored()).clientInformation?.client_id).toBe(fresh);
  });

  it("keeps a cached client the server still knows", async () => {
    as.clients.add("known-client");
    await seed(cachedClient("known-client"));
    const init = await start().initialize();

    expect(init.result?.serverInfo?.name).toBe("mock-upstream");
    expect(as.probes).toBe(1);
    expect(as.registrations).toHaveLength(0);
    expect((await stored()).clientInformation?.client_id).toBe("known-client");
  });

  it("forgets the cached client when the browser authorization fails", async () => {
    as.clients.add("known-client");
    as.denyAuthorization = true;
    await seed(cachedClient("known-client"));
    await runUntilExit();

    expect(as.registrations).toHaveLength(0);
    expect((await stored()).clientInformation).toBeUndefined();
  });

  it("never probes or clears for a pre-registered --client-id", async () => {
    await seed(cachedClient("old-dcr-client"));
    await runUntilExit("--client-id", "pre-registered", "--auth-timeout", "1");

    expect(as.probes).toBe(0);
    expect(as.registrations).toHaveLength(0);
    expect(as.authorizeClientIds).toEqual(["pre-registered"]);
    expect((await stored()).clientInformation?.client_id).toBe("old-dcr-client");
  });
});
