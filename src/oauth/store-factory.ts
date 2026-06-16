import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { KeychainBackend, KeychainUnavailable, openKeychain } from "./keychain.js";
import { AuthStore, FileBackend } from "./store.js";

/**
 * Build the credential store for one server, honoring `config.credentialStore`:
 *
 * - `file`     — on-disk JSON under `--token-store` (legacy behavior).
 * - `keychain` — OS keychain only; fail loud if it's unavailable.
 * - `auto`     — keychain when reachable, otherwise fall back to file storage.
 *
 * When the keychain is used and holds nothing yet, any legacy on-disk blob for
 * this server is migrated into it (and the plaintext file removed) on first use.
 */
export async function createAuthStore(
  config: Config,
  canonicalUri: string,
  log: Logger,
): Promise<AuthStore> {
  if (config.credentialStore === "file") {
    return AuthStore.file(config.tokenStoreDir, canonicalUri, log);
  }

  try {
    const { backend, current } = await openKeychain(canonicalUri, log);
    if (current === undefined) {
      await migrateLegacyFile(config, canonicalUri, backend, log);
    }
    return new AuthStore(backend, log);
  } catch (err) {
    // Explicit `--credential-store keychain` must surface the failure.
    if (config.credentialStore === "keychain" || !(err instanceof KeychainUnavailable)) {
      throw err;
    }
    log.warn({ err }, "OS keychain unavailable; falling back to file storage");
    return AuthStore.file(config.tokenStoreDir, canonicalUri, log);
  }
}

/** Move a pre-existing on-disk blob into the keychain. Best-effort: never fatal. */
async function migrateLegacyFile(
  config: Config,
  canonicalUri: string,
  backend: KeychainBackend,
  log: Logger,
): Promise<void> {
  try {
    const file = new FileBackend(config.tokenStoreDir, canonicalUri);
    const legacy = await file.read();
    if (legacy === undefined) return;
    await backend.write(legacy);
    await file.remove();
    log.info("migrated credentials from disk to OS keychain");
  } catch (err) {
    log.warn({ err }, "failed to migrate on-disk credentials to OS keychain");
  }
}
