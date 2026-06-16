import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeychainUnavailable, openKeychain } from "../../src/oauth/keychain.js";
import type { Logger } from "../../src/log.js";

// Shared, mutable state so the hoisted mock can be steered per-test.
const h = vi.hoisted(() => ({ store: new Map<string, string>(), throwOnGet: false }));

vi.mock("@napi-rs/keyring", () => ({
  // Synchronous Entry, matching the real @napi-rs/keyring surface.
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

const log = { debug: vi.fn() } as unknown as Logger;
const URI = "https://example.com/mcp";

beforeEach(() => {
  h.store.clear();
  h.throwOnGet = false;
});

describe("openKeychain", () => {
  it("reports an empty entry as current === undefined (null mapped to undefined)", async () => {
    const { current } = await openKeychain(URI, log);
    expect(current).toBeUndefined();
  });

  it("round-trips writes through the backend", async () => {
    const { backend } = await openKeychain(URI, log);
    await backend.write("blob-1");
    expect((await openKeychain(URI, log)).current).toBe("blob-1");
    await backend.remove();
    expect((await openKeychain(URI, log)).current).toBeUndefined();
  });

  it("keeps entries separate per server URI", async () => {
    const a = await openKeychain("https://a.example/mcp", log);
    await a.backend.write("for-a");
    expect((await openKeychain("https://b.example/mcp", log)).current).toBeUndefined();
  });

  it("wraps a backend failure as KeychainUnavailable", async () => {
    h.throwOnGet = true;
    await expect(openKeychain(URI, log)).rejects.toBeInstanceOf(KeychainUnavailable);
  });
});
