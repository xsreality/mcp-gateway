import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { createUpstreamTransport } from "./upstream.js";
import { GatewayOAuthProvider } from "./oauth/provider.js";

/**
 * The gateway transparently relays raw JSON-RPC messages between a local stdio
 * MCP client (downstream) and a remote Streamable-HTTP MCP server (upstream).
 *
 * It deliberately does NOT re-declare tools/resources/prompts: by forwarding
 * messages verbatim it passes through every current and future MCP capability.
 *
 * OAuth is lazy and transport-driven: the SDK transport attempts each upstream
 * request with whatever token it has; on a 401 it runs discovery/DCR and invokes
 * the provider's `redirectToAuthorization`. The first forwarded send then rejects
 * with `UnauthorizedError`, at which point the gateway waits for the browser
 * redirect, finishes the token exchange, and retries the send. Servers that need
 * no auth never trigger any of this.
 */
export class Gateway {
  private readonly downstream: Transport;
  private readonly upstream: StreamableHTTPClientTransport;
  private closing = false;
  private onClosed?: () => void;
  private authInFlight?: Promise<void>;

  private constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly provider: GatewayOAuthProvider,
  ) {
    this.downstream = new StdioServerTransport();
    this.upstream = createUpstreamTransport(config, provider);
  }

  static async create(config: Config, log: Logger): Promise<Gateway> {
    const provider = await GatewayOAuthProvider.create(config, log);
    return new Gateway(config, log, provider);
  }

  /** Resolves when either side closes the connection. */
  async run(): Promise<void> {
    this.wire();
    // Bind the loopback callback up front: the SDK reads redirect_uri (needing the
    // bound port) during DCR, before redirectToAuthorization runs. Kept open for
    // the session so token-expiry re-auth works without rebinding.
    await this.provider.callback.listen();
    await this.upstream.start(); // no network call yet; auth happens on first send
    await this.downstream.start();
    this.log.info({ url: this.config.url.href }, "gateway ready (stdio <-> streamable-http)");

    await new Promise<void>((resolve) => {
      this.onClosed = resolve;
    });
  }

  private wire(): void {
    // downstream (local client) -> upstream (remote server): may need auth.
    this.downstream.onmessage = (msg) => {
      if (this.closing) return;
      this.log.debug({ dir: "client→remote", msg }, "relay");
      void this.sendUpstream(msg).catch((err: unknown) => {
        this.log.error({ err }, "upstream relay failed");
        void this.close();
      });
    };
    // upstream (remote server) -> downstream (local client).
    this.upstream.onmessage = (msg) => {
      this.forward(this.downstream, msg, "remote→client");
    };

    this.downstream.onerror = (err) => this.log.error({ err }, "downstream error");
    this.upstream.onerror = (err) => {
      // 401s are reported out-of-band here too, but sendUpstream handles them.
      if (err instanceof UnauthorizedError) this.log.debug({ err }, "upstream auth challenge");
      else this.log.error({ err }, "upstream error");
    };

    this.downstream.onclose = () => {
      this.log.info("downstream closed");
      void this.close();
    };
    this.upstream.onclose = () => {
      this.log.info("upstream closed");
      void this.close();
    };
  }

  /** Send to upstream, completing the OAuth flow on a 401 and retrying once. */
  private async sendUpstream(msg: JSONRPCMessage): Promise<void> {
    try {
      await this.upstream.send(msg);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      await this.completeAuthorization();
      await this.upstream.send(msg);
    }
  }

  /** Wait for the browser redirect and finish token exchange; shared + reusable. */
  private completeAuthorization(): Promise<void> {
    if (!this.authInFlight) {
      this.authInFlight = (async () => {
        this.log.info("authorization required; waiting for browser approval");
        const code = await this.provider.callback.waitForCode(this.config.authTimeoutSec * 1000);
        await this.upstream.finishAuth(code);
        this.log.info("authorization complete");
      })().finally(() => {
        this.authInFlight = undefined; // allow re-auth on later token expiry
      });
    }
    return this.authInFlight;
  }

  private forward(to: Transport, msg: JSONRPCMessage, dir: string): void {
    if (this.closing) return;
    this.log.debug({ dir, msg }, "relay");
    void to.send(msg).catch((err: unknown) => {
      this.log.error({ err, dir }, "relay send failed");
      void this.close();
    });
  }

  /** Tears down both transports; idempotent. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.log.info("shutting down gateway");
    await Promise.allSettled([
      this.downstream.close(),
      this.upstream.close(),
      this.provider.callback.close(),
    ]);
    this.onClosed?.();
  }
}
