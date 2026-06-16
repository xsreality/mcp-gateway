import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Logger } from "../log.js";

/** Everything persisted for one remote MCP server, keyed by its canonical URI. */
export interface StoredAuth {
  /** DCR result (or full info for a statically configured client). */
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  /** PKCE verifier persisted between redirect and token exchange. */
  codeVerifier?: string;
  /**
   * Loopback callback port used for the registered redirect_uri. Persisted so
   * the redirect_uri stays byte-identical across runs (exact-match requirement).
   */
  redirectPort?: number;
}

/**
 * Persistence primitive for one server's credential blob. The store layers JSON
 * parse/merge/cache/serialization on top; a backend only moves an opaque string
 * in and out of some medium (a file, the OS keychain, ...). `read()` returns
 * `undefined` when nothing is stored yet.
 */
export interface SecretBackend {
  read(): Promise<string | undefined>;
  write(data: string): Promise<void>;
  remove(): Promise<void>;
}

/** Derive the 32-hex storage key shared by the file name and keychain account. */
export function storeKey(canonicalUri: string): string {
  return createHash("sha256").update(canonicalUri).digest("hex").slice(0, 32);
}

/**
 * File backend: one JSON file per server under a 0700 directory, written 0600
 * via a temp file + atomic rename. A missing file reads as `undefined`.
 */
export class FileBackend implements SecretBackend {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    canonicalUri: string,
  ) {
    this.file = path.join(dir, `${storeKey(canonicalUri)}.json`);
  }

  async read(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(data: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async remove(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/**
 * Credential store over a {@link SecretBackend}. Holds the in-memory cache,
 * serializes read-modify-write cycles, and tolerates an unreadable/corrupt blob
 * by treating it as empty.
 */
export class AuthStore {
  private cache: StoredAuth | undefined;
  /** Serializes read-modify-write cycles so concurrent patches don't lose updates. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: SecretBackend,
    private readonly log: Logger,
  ) {}

  /** Convenience constructor for the on-disk backend. */
  static file(dir: string, canonicalUri: string, log: Logger): AuthStore {
    return new AuthStore(new FileBackend(dir, canonicalUri), log);
  }

  async load(): Promise<StoredAuth> {
    if (this.cache) return this.cache;
    try {
      const raw = await this.backend.read();
      this.cache = raw ? (JSON.parse(raw) as StoredAuth) : {};
    } catch (err) {
      this.log.warn({ err }, "ignoring unreadable auth store");
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    await this.backend.write(JSON.stringify(this.cache ?? {}, null, 2));
  }

  /** Append a unit of work to the serialized chain, surfacing its result to the caller. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(fn);
    // Keep the chain alive even if one unit rejects.
    this.writeChain = next.catch(() => {});
    return next;
  }

  /** Run a read-modify-write cycle serialized against all other mutations. */
  private mutate(fn: (current: StoredAuth) => StoredAuth): Promise<void> {
    return this.enqueue(async () => {
      this.cache = fn(await this.load());
      await this.save();
    });
  }

  async patch(update: Partial<StoredAuth>): Promise<void> {
    return this.mutate((current) => ({ ...current, ...update }));
  }

  /** Remove credentials by scope; used by invalidateCredentials. */
  async clear(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all") {
      // Drop the backing entry entirely so no empty blob lingers.
      return this.enqueue(async () => {
        this.cache = {};
        await this.backend.remove();
      });
    }
    return this.mutate((current) => {
      if (scope === "client") return { ...current, clientInformation: undefined };
      if (scope === "tokens") return { ...current, tokens: undefined };
      return { ...current, codeVerifier: undefined };
    });
  }
}
