import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import type { Logger } from "../log.js";
import type { SecretBackend } from "./store.js";

/** Service name under which every server's blob is filed in the OS keychain. */
const SERVICE = "mcp-gateway";

/** Thrown when the platform keychain can't be loaded or reached. */
export class KeychainUnavailable extends Error {}

/**
 * Stores one server's credential blob in the OS keychain (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service) via `@napi-rs/keyring`.
 * The account is the server's canonical URI, so entries are recognizable in
 * tools like Keychain Access. A missing entry reads as `undefined`.
 */
export class KeychainBackend implements SecretBackend {
  constructor(private readonly entry: KeyringEntry) {}

  async read(): Promise<string | undefined> {
    return this.entry.getPassword() ?? undefined;
  }

  async write(data: string): Promise<void> {
    this.entry.setPassword(data);
  }

  async remove(): Promise<void> {
    this.entry.deletePassword();
  }
}

/**
 * Open the keychain backend for one server. The native module is imported
 * lazily so a missing/broken binary (or an unreachable Secret Service) never
 * breaks file-only users — it surfaces as {@link KeychainUnavailable}. A probe
 * read both proves the backend works and returns the current blob, sparing the
 * caller a second read for migration.
 */
export async function openKeychain(
  canonicalUri: string,
  log: Logger,
): Promise<{ backend: KeychainBackend; current: string | undefined }> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const backend = new KeychainBackend(new Entry(SERVICE, canonicalUri));
    const current = await backend.read();
    return { backend, current };
  } catch (err) {
    log.debug({ err }, "OS keychain unavailable");
    throw new KeychainUnavailable("OS keychain is unavailable", { cause: err });
  }
}
