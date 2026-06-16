import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { Logger } from "../../src/log.js";
import { createAuthStore } from "../../src/oauth/store-factory.js";
import { FileBackend } from "../../src/oauth/store.js";

const h = vi.hoisted(() => ({ store: new Map<string, string>(), throwOnGet: false }));

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    private readonly key: string;
    constructor(service: string, account: string) {
      this.key = `${service}\n${account}`;
    }
    getPassword(): string | null {
      if (h.throwOnGet) throw new Error("secret service unavailable");
      return h.store.get(this.key) ?? null;
    }
    setPassword(v: string): void {
      h.store.set(this.key, v);
    }
    deletePassword(): boolean {
      return h.store.delete(this.key);
    }
  },
}));

const URI = "https://example.com/mcp";

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

let dir: string;

function cfg(credentialStore: Config["credentialStore"]): Config {
  return { credentialStore, tokenStoreDir: dir } as Config;
}

beforeEach(async () => {
  h.store.clear();
  h.throwOnGet = false;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpgw-factory-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("createAuthStore", () => {
  it("'file' mode persists to disk, never touching the keychain", async () => {
    const store = await createAuthStore(cfg("file"), URI, fakeLogger());
    await store.patch({ redirectPort: 11 });
    expect(await new FileBackend(dir, URI).read()).toContain("11");
    expect(h.store.size).toBe(0);
  });

  it("'auto' uses the keychain when available", async () => {
    const store = await createAuthStore(cfg("auto"), URI, fakeLogger());
    await store.patch({ redirectPort: 22 });
    expect(h.store.size).toBe(1);
    expect(await new FileBackend(dir, URI).read()).toBeUndefined();
  });

  it("'auto' migrates an existing on-disk blob into the keychain and deletes the file", async () => {
    await new FileBackend(dir, URI).write(JSON.stringify({ redirectPort: 33 }));
    const log = fakeLogger();
    const store = await createAuthStore(cfg("auto"), URI, log);
    // File is gone; keychain now holds the blob; data is intact.
    expect(await new FileBackend(dir, URI).read()).toBeUndefined();
    expect(h.store.size).toBe(1);
    expect((await store.load()).redirectPort).toBe(33);
    expect(log.info).toHaveBeenCalled();
  });

  it("'auto' falls back to file storage when the keychain is unavailable", async () => {
    h.throwOnGet = true;
    const log = fakeLogger();
    const store = await createAuthStore(cfg("auto"), URI, log);
    await store.patch({ redirectPort: 44 });
    expect(await new FileBackend(dir, URI).read()).toContain("44");
    expect(log.warn).toHaveBeenCalled();
  });

  it("'keychain' mode surfaces the error when the keychain is unavailable", async () => {
    h.throwOnGet = true;
    await expect(createAuthStore(cfg("keychain"), URI, fakeLogger())).rejects.toThrow();
  });
});
