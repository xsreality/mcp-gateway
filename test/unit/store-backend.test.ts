import { describe, expect, it, vi } from "vitest";
import { AuthStore, type SecretBackend } from "../../src/oauth/store.js";
import type { Logger } from "../../src/log.js";

function fakeLogger() {
  return { warn: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/** In-memory SecretBackend; can be told to throw on read to exercise tolerance. */
class MemoryBackend implements SecretBackend {
  data: string | undefined;
  removed = false;
  failRead = false;

  constructor(initial?: string) {
    this.data = initial;
  }

  async read(): Promise<string | undefined> {
    if (this.failRead) throw new Error("backend unreachable");
    return this.data;
  }

  async write(data: string): Promise<void> {
    this.data = data;
    this.removed = false;
  }

  async remove(): Promise<void> {
    this.data = undefined;
    this.removed = true;
  }
}

describe("AuthStore over a SecretBackend", () => {
  it("returns empty when the backend has nothing (no warning)", async () => {
    const log = fakeLogger();
    expect(await new AuthStore(new MemoryBackend(), log).load()).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("parses an existing blob from the backend", async () => {
    const backend = new MemoryBackend(JSON.stringify({ redirectPort: 4242 }));
    expect((await new AuthStore(backend, fakeLogger()).load()).redirectPort).toBe(4242);
  });

  it("treats a backend read error as empty and warns once", async () => {
    const backend = new MemoryBackend();
    backend.failRead = true;
    const log = fakeLogger();
    expect(await new AuthStore(backend, log).load()).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("treats a corrupt blob as empty and warns once", async () => {
    const log = fakeLogger();
    expect(await new AuthStore(new MemoryBackend("{ not json"), log).load()).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("writes merged JSON back to the backend on patch", async () => {
    const backend = new MemoryBackend();
    const store = new AuthStore(backend, fakeLogger());
    await store.patch({ redirectPort: 7 });
    await store.patch({ codeVerifier: "v" });
    expect(JSON.parse(backend.data as string)).toMatchObject({ redirectPort: 7, codeVerifier: "v" });
  });

  it("clear('all') removes the backing entry rather than writing an empty blob", async () => {
    const backend = new MemoryBackend(JSON.stringify({ redirectPort: 1 }));
    const store = new AuthStore(backend, fakeLogger());
    await store.load();
    await store.clear("all");
    expect(backend.removed).toBe(true);
    expect(backend.data).toBeUndefined();
    expect(await store.load()).toEqual({});
  });

  it("partial clear keeps the entry and drops only the named field", async () => {
    const backend = new MemoryBackend(
      JSON.stringify({ redirectPort: 1, tokens: { access_token: "a", token_type: "Bearer" } }),
    );
    const store = new AuthStore(backend, fakeLogger());
    await store.clear("tokens");
    expect(backend.removed).toBe(false);
    const s = JSON.parse(backend.data as string);
    expect(s.tokens).toBeUndefined();
    expect(s.redirectPort).toBe(1);
  });
});
