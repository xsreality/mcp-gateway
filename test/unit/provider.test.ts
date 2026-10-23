import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { GatewayOAuthProvider, StaleClientError, probeClient } from "../../src/oauth/provider.js";
import { canonicalResourceUri } from "../../src/oauth/canonical.js";
import { AuthStore } from "../../src/oauth/store.js";

const log = pino({ level: "silent" });

let server: http.Server;
let origin: string;
let status: number;
let requests: { url: URL; accept?: string }[];

beforeEach(async () => {
  status = 302;
  requests = [];
  server = http.createServer((req, res) => {
    requests.push({ url: new URL(req.url!, origin), accept: req.headers.accept });
    res.writeHead(status, status === 302 ? { location: "http://127.0.0.1/callback?code=x" } : {}).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function authorizationUrl(clientId: string): URL {
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    code_challenge: "real-challenge",
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:4567/callback",
    state: "real-state",
    scope: "read write",
    resource: "https://example.com/mcp",
  }).toString();
  return url;
}

describe("probeClient", () => {
  it.each([
    [302, "known"],
    [400, "unknown"],
    [401, "unsure"],
    [403, "unsure"],
    [404, "unsure"],
    [405, "unsure"],
    [408, "unsure"],
    [429, "unsure"],
    [500, "unsure"],
  ] as const)("maps HTTP %i to %s", async (code, expected) => {
    status = code;
    expect(await probeClient(authorizationUrl("c1"))).toBe(expected);
  });

  it("is unsure when the server cannot be reached", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await probeClient(new URL(`http://127.0.0.1:${port}/authorize?client_id=c1`))).toBe("unsure");
  });

  it("sends the real request with a fresh state and PKCE challenge, asking for JSON", async () => {
    await probeClient(authorizationUrl("c1"));
    const [req] = requests;
    expect(req?.accept).toBe("application/json");
    const q = req!.url.searchParams;
    expect(q.get("client_id")).toBe("c1");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:4567/callback");
    expect(q.get("scope")).toBe("read write");
    expect(q.get("resource")).toBe("https://example.com/mcp");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).not.toBe("real-state");
  });
});

describe("GatewayOAuthProvider stale client handling", () => {
  let dir: string;
  let provider: GatewayOAuthProvider;
  const URL_ = new URL("https://example.com/mcp");

  const store = () => AuthStore.file(dir, canonicalResourceUri(URL_), log);
  const create = async (overrides: Partial<Config> = {}) => {
    const config: Config = {
      url: URL_,
      headers: {},
      logLevel: "silent",
      clientName: "test",
      dcr: true,
      authTimeoutSec: 1,
      credentialStore: "file",
      tokenStoreDir: dir,
      openBrowser: false,
      ...overrides,
    };
    provider = await GatewayOAuthProvider.create(config, log);
    await provider.callback.listen();
    return provider;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-provider-"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await store().patch({
      clientInformation: { client_id: "cached", redirect_uris: [] },
      tokens: { access_token: "at", token_type: "Bearer" },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await provider?.callback.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("clears only the client and throws StaleClientError when the server rejects a cached client", async () => {
    status = 400;
    await create();
    await expect(provider.redirectToAuthorization(authorizationUrl("cached"))).rejects.toBeInstanceOf(StaleClientError);
    const saved = await store().load();
    expect(saved.clientInformation).toBeUndefined();
    expect(saved.tokens?.access_token).toBe("at");
  });

  it("keeps a cached client when the probe is unsure", async () => {
    status = 503;
    await create();
    await provider.redirectToAuthorization(authorizationUrl("cached"));
    expect((await store().load()).clientInformation?.client_id).toBe("cached");
  });

  it("does not probe a client registered in this run", async () => {
    status = 400;
    await create();
    await provider.saveClientInformation({ client_id: "fresh", redirect_uris: [] });
    await provider.redirectToAuthorization(authorizationUrl("fresh"));
    expect(requests).toHaveLength(0);
  });

  it("never probes or clears a pre-registered client", async () => {
    status = 400;
    await create({ clientId: "pre-registered" });
    await provider.redirectToAuthorization(authorizationUrl("pre-registered"));
    await provider.authorizationFailed();
    expect(requests).toHaveLength(0);
    expect((await store().load()).clientInformation?.client_id).toBe("cached");
  });

  it("clears the cached client after a failed authorization", async () => {
    await create();
    await provider.redirectToAuthorization(authorizationUrl("cached"));
    await provider.authorizationFailed();
    expect((await store().load()).clientInformation).toBeUndefined();
  });

  it("keeps a freshly registered client after a failed authorization", async () => {
    await create();
    await provider.saveClientInformation({ client_id: "fresh", redirect_uris: [] });
    await provider.redirectToAuthorization(authorizationUrl("fresh"));
    await provider.authorizationFailed();
    expect((await store().load()).clientInformation?.client_id).toBe("fresh");
  });
});
