import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { canonicalResourceUri } from "./canonical.js";
import { CallbackServer, openBrowser } from "./callback.js";
import { createAuthStore } from "./store-factory.js";
import type { AuthStore } from "./store.js";

/**
 * OAuth 2.1 client provider for one remote MCP server. The SDK's `auth()` helper
 * drives discovery (RFC 9728 → RFC 8414), Dynamic Client Registration (RFC 7591),
 * PKCE, and token exchange; this class supplies persistence, the redirect URL,
 * and the browser hand-off. RFC 8707 `resource` binding is handled by the SDK.
 */
export class GatewayOAuthProvider implements OAuthClientProvider {
  private currentState?: string;

  private constructor(
    private readonly config: Config,
    private readonly store: AuthStore,
    readonly callback: CallbackServer,
    private readonly log: Logger,
  ) {}

  /** Async factory: loads persisted state and binds the loopback callback port. */
  static async create(config: Config, log: Logger): Promise<GatewayOAuthProvider> {
    const canonical = canonicalResourceUri(config.url);
    const store = await createAuthStore(config, canonical, log);
    const stored = await store.load();
    const port = config.callbackPort ?? stored.redirectPort;
    let provider: GatewayOAuthProvider;
    const callback = new CallbackServer(port, () => provider.currentState, log);
    provider = new GatewayOAuthProvider(config, store, callback, log);
    return provider;
  }

  get redirectUrl(): string {
    return this.callback.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.callback.redirectUrl],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.config.clientName,
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    this.currentState = randomUUID();
    return this.currentState;
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    // Statically configured client takes precedence over any DCR result.
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
        ...this.clientMetadata,
      };
    }
    return (await this.store.load()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    if (!this.config.dcr) {
      throw new Error("Dynamic Client Registration is disabled (--no-dcr) and no --client-id was provided");
    }
    this.log.info({ clientId: info.client_id }, "registered OAuth client via DCR");
    await this.store.patch({ clientInformation: info, redirectPort: this.callback.port });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.log.info("stored OAuth tokens");
    await this.store.patch({ tokens });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.patch({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.load()).codeVerifier;
    if (!verifier) throw new Error("missing PKCE code verifier");
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Start the loopback listener before launching the browser so the redirect
    // can never arrive before we are listening.
    await this.callback.listen();
    if (this.config.openBrowser) {
      this.log.info("opening browser for authorization");
      openBrowser(authorizationUrl.href, this.log);
      // stderr so the local client's stdout protocol stream stays clean.
      process.stderr.write(`\nIf your browser did not open, visit:\n${authorizationUrl.href}\n\n`);
    } else {
      process.stderr.write(`\nAuthorize this gateway by visiting:\n${authorizationUrl.href}\n\n`);
    }
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "discovery") return; // discovery state isn't persisted here
    await this.store.clear(scope);
  }
}
