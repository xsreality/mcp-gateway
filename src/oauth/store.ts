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
 * File-backed credential store. One JSON file per server under a 0700 directory,
 * each written 0600. Tolerates a missing/corrupt file by treating it as empty.
 */
export class AuthStore {
  private readonly file: string;
  private cache: StoredAuth | undefined;
  /** Serializes read-modify-write cycles so concurrent patches don't lose updates. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    canonicalUri: string,
    private readonly log: Logger,
  ) {
    const key = createHash("sha256").update(canonicalUri).digest("hex").slice(0, 32);
    this.file = path.join(dir, `${key}.json`);
  }

  async load(): Promise<StoredAuth> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.cache = JSON.parse(raw) as StoredAuth;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.warn({ err, file: this.file }, "ignoring unreadable auth store file");
      }
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.cache ?? {}, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Run a read-modify-write cycle serialized against all other mutations. */
  private mutate(fn: (current: StoredAuth) => StoredAuth): Promise<void> {
    const next = this.writeChain.then(async () => {
      this.cache = fn(await this.load());
      await this.save();
    });
    // Keep the chain alive even if one mutation rejects.
    this.writeChain = next.catch(() => {});
    return next;
  }

  async patch(update: Partial<StoredAuth>): Promise<void> {
    return this.mutate((current) => ({ ...current, ...update }));
  }

  /** Remove credentials by scope; used by invalidateCredentials. */
  async clear(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    return this.mutate((current) => {
      if (scope === "all") return {};
      if (scope === "client") return { ...current, clientInformation: undefined };
      if (scope === "tokens") return { ...current, tokens: undefined };
      return { ...current, codeVerifier: undefined };
    });
  }
}
