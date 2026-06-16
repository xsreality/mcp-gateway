import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "../../src/oauth/store.js";
import type { Logger } from "../../src/log.js";

// store.ts only ever calls log.warn; a stub with a spy is enough.
function fakeLogger() {
  return { warn: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

const URI = "https://example.com/mcp";

/** Re-derive the on-disk filename the store computes for a canonical URI. */
function storeFile(dir: string, uri: string): string {
  const key = createHash("sha256").update(uri).digest("hex").slice(0, 32);
  return path.join(dir, `${key}.json`);
}

let dir: string;
let log: ReturnType<typeof fakeLogger>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-store-"));
  log = fakeLogger();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("AuthStore.load", () => {
  it("returns an empty object when no file exists (no warning)", async () => {
    const store = new AuthStore(dir, URI, log);
    expect(await store.load()).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("treats a corrupt file as empty and warns once", async () => {
    await fs.writeFile(storeFile(dir, URI), "{ not json");
    const store = new AuthStore(dir, URI, log);
    expect(await store.load()).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("caches the loaded value (second load doesn't re-read disk)", async () => {
    const store = new AuthStore(dir, URI, log);
    await store.patch({ redirectPort: 5000 });
    // Corrupt the file on disk; a cached load must not see it.
    await fs.writeFile(storeFile(dir, URI), "garbage");
    expect((await store.load()).redirectPort).toBe(5000);
  });
});

describe("AuthStore.patch", () => {
  it("persists values that a fresh store then reads back", async () => {
    await new AuthStore(dir, URI, log).patch({ redirectPort: 12345 });
    const reopened = new AuthStore(dir, URI, log);
    expect((await reopened.load()).redirectPort).toBe(12345);
  });

  it("merges successive patches rather than overwriting", async () => {
    const store = new AuthStore(dir, URI, log);
    await store.patch({ redirectPort: 8080 });
    await store.patch({ codeVerifier: "verifier-abc" });
    expect(await store.load()).toMatchObject({
      redirectPort: 8080,
      codeVerifier: "verifier-abc",
    });
  });

  it("serializes concurrent patches without losing updates", async () => {
    const store = new AuthStore(dir, URI, log);
    await Promise.all([
      store.patch({ redirectPort: 1 }),
      store.patch({ codeVerifier: "v" }),
      store.patch({ tokens: { access_token: "a", token_type: "Bearer" } }),
    ]);
    const result = await new AuthStore(dir, URI, log).load();
    expect(result.codeVerifier).toBe("v");
    expect(result.tokens?.access_token).toBe("a");
    expect(result.redirectPort).toBe(1);
  });
});

describe("AuthStore.clear", () => {
  async function seed() {
    const store = new AuthStore(dir, URI, log);
    await store.patch({
      redirectPort: 9000,
      codeVerifier: "verifier",
      tokens: { access_token: "a", token_type: "Bearer" },
      // Minimal shape; the store doesn't validate it.
      clientInformation: { client_id: "cid", redirect_uris: [] } as never,
    });
    return store;
  }

  it("'tokens' removes only the tokens", async () => {
    const store = await seed();
    await store.clear("tokens");
    const s = await store.load();
    expect(s.tokens).toBeUndefined();
    expect(s.clientInformation).toBeDefined();
    expect(s.redirectPort).toBe(9000);
  });

  it("'client' removes only the DCR client info", async () => {
    const store = await seed();
    await store.clear("client");
    const s = await store.load();
    expect(s.clientInformation).toBeUndefined();
    expect(s.tokens).toBeDefined();
  });

  it("'verifier' removes only the PKCE verifier", async () => {
    const store = await seed();
    await store.clear("verifier");
    const s = await store.load();
    expect(s.codeVerifier).toBeUndefined();
    expect(s.tokens).toBeDefined();
  });

  it("'all' wipes everything", async () => {
    const store = await seed();
    await store.clear("all");
    expect(await store.load()).toEqual({});
  });
});

describe("AuthStore on-disk layout", () => {
  it("keys the filename by sha256 of the canonical URI", async () => {
    await new AuthStore(dir, URI, log).patch({ redirectPort: 1 });
    const files = await fs.readdir(dir);
    expect(files).toEqual([path.basename(storeFile(dir, URI))]);
  });

  it("uses different files for different servers", async () => {
    await new AuthStore(dir, "https://a.example/mcp", log).patch({ redirectPort: 1 });
    await new AuthStore(dir, "https://b.example/mcp", log).patch({ redirectPort: 2 });
    expect((await fs.readdir(dir)).length).toBe(2);
  });

  it("writes the file 0600 and creates a missing directory 0700", async () => {
    // mode bits aren't meaningful on Windows; skip there.
    if (process.platform === "win32") return;
    // Point at a not-yet-created subdir so save() is what mkdirs it.
    const subdir = path.join(dir, "nested");
    const store = new AuthStore(subdir, URI, log);
    await store.patch({ redirectPort: 1 });
    expect((await fs.stat(subdir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(storeFile(subdir, URI))).mode & 0o777).toBe(0o600);
  });

  it("leaves no .tmp file behind after the atomic write", async () => {
    await new AuthStore(dir, URI, log).patch({ redirectPort: 1 });
    expect((await fs.readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
