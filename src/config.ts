import os from "node:os";
import path from "node:path";
import type { LogLevel } from "./log.js";

/**
 * Where credentials are persisted:
 * - `auto`     — OS keychain when available, else file storage (default).
 * - `keychain` — OS keychain only; error out if it's unavailable.
 * - `file`     — on-disk JSON under `tokenStoreDir`.
 */
export type CredentialStore = "auto" | "keychain" | "file";

/**
 * Resolved gateway configuration.
 */
export interface Config {
  /** Remote Streamable-HTTP MCP server endpoint. */
  url: URL;
  /** Static headers forwarded on every upstream request (e.g. routing, non-OAuth auth). */
  headers: Record<string, string>;
  logLevel: LogLevel;
  logFile?: string;

  // --- OAuth ---
  /** OAuth scopes to request. */
  scope?: string;
  /** client_name used in Dynamic Client Registration. */
  clientName: string;
  /** Pre-registered client id (skips DCR for the id). */
  clientId?: string;
  /** Pre-registered client secret (confidential client). */
  clientSecret?: string;
  /** Whether Dynamic Client Registration is permitted. */
  dcr: boolean;
  /** Fixed loopback callback port; when undefined a free port is chosen and persisted. */
  callbackPort?: number;
  /** Max seconds to wait for the user to complete browser authorization. */
  authTimeoutSec: number;
  /** Where credentials are persisted (OS keychain vs. on-disk file). */
  credentialStore: CredentialStore;
  /** Directory holding per-server tokens + registration when using file storage. */
  tokenStoreDir: string;
  /** Open the system browser automatically (false => print the URL). */
  openBrowser: boolean;
}

export class ConfigError extends Error {}

/** Parse repeated `--header "Key: value"` flags into a header map. */
export function parseHeaders(raw: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw) {
    const idx = entry.indexOf(":");
    if (idx === -1) {
      throw new ConfigError(`Invalid --header "${entry}", expected "Key: value"`);
    }
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (!key) {
      throw new ConfigError(`Invalid --header "${entry}", empty header name`);
    }
    headers[key] = value;
  }
  return headers;
}

export function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`Invalid --url "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`--url must be http(s), got "${url.protocol}"`);
  }
  return url;
}

export function defaultTokenStoreDir(): string {
  return path.join(os.homedir(), ".mcp-gateway");
}
