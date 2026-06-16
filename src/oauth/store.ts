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

  async patch(update: Partial<StoredAuth>): Promise<void> {
    const current = await this.load();
    this.cache = { ...current, ...update };
    await this.save();
  }

  /** Remove credentials by scope; used by invalidateCredentials. */
  async clear(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    const current = await this.load();
    if (scope === "all") {
      this.cache = {};
    } else if (scope === "client") {
      this.cache = { ...current, clientInformation: undefined };
    } else if (scope === "tokens") {
      this.cache = { ...current, tokens: undefined };
    } else {
      this.cache = { ...current, codeVerifier: undefined };
    }
    await this.save();
  }
}
