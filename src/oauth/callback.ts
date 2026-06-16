import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Logger } from "../log.js";

const CALLBACK_PATH = "/callback";

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>Authorized</title>" +
  "<body style='font-family:system-ui;padding:3rem;text-align:center'>" +
  "<h2>Authorization complete</h2><p>You can close this tab and return to the terminal.</p>";

/**
 * Loopback HTTP server (127.0.0.1 only) that captures the OAuth authorization
 * code redirect. Bound to a fixed port so the registered redirect_uri stays
 * byte-identical across runs.
 */
export class CallbackServer {
  private server?: http.Server;
  private pending?: {
    resolve: (code: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
  private boundPort?: number;

  constructor(
    private readonly preferredPort: number | undefined,
    private readonly expectedState: () => string | undefined,
    private readonly log: Logger,
  ) {}

  /** Begin listening. Resolves to the actual bound port. */
  async listen(): Promise<number> {
    if (this.server) return this.boundPort!;
    const server = http.createServer((req, res) => this.handle(req, res));
    // Prefer an explicit/stored port; otherwise reuse the port from a previous
    // bind in this process so the registered redirect_uri stays stable.
    const target = this.preferredPort ?? this.boundPort ?? 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, "127.0.0.1", resolve);
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    this.log.debug({ port: this.boundPort }, "callback server listening");
    return this.boundPort;
  }

  get port(): number {
    if (this.boundPort === undefined) throw new Error("callback server not listening");
    return this.boundPort;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`;
  }

  /** Resolves with the authorization code once the browser redirect arrives. */
  waitForCode(timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for authorization`));
      }, timeoutMs);
      timer.unref();
      this.pending = { resolve, reject, timer };
    });
  }

  /** Settle the pending waitForCode exactly once, clearing its timeout. */
  private settle(result: Error | { code: string }): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    if (result instanceof Error) p.reject(result);
    else p.resolve(result.code);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.boundPort}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expected = this.expectedState();

    if (error) {
      const desc = url.searchParams.get("error_description") ?? "";
      this.fail(res, 400, `Authorization failed: ${error} ${desc}`.trim());
      return;
    }
    if (expected !== undefined && state !== expected) {
      this.fail(res, 400, "State mismatch — possible CSRF, request rejected.");
      return;
    }
    if (!code) {
      this.fail(res, 400, "Missing authorization code.");
      return;
    }

    res.writeHead(200, { "content-type": "text/html" }).end(SUCCESS_HTML);
    this.settle({ code });
  }

  private fail(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "text/plain" }).end(message);
    this.settle(new Error(message));
  }

  async close(): Promise<void> {
    // Don't leave a waitForCode() awaiter hanging if we shut down mid-flow.
    this.settle(new Error("callback server closed before authorization completed"));
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}

/** Open a URL in the system browser without an extra dependency. */
export function openBrowser(url: string, log: Logger): void {
  const platform = process.platform;
  const isWin = platform === "win32";
  const cmd = platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
  // On Windows the URL must be quoted: cmd.exe treats `&` (always present in
  // OAuth query strings) as a command separator, which would truncate the URL.
  const args = isWin ? ["/c", "start", '""', `"${url}"`] : [url];
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: isWin,
    });
    child.on("error", (err) => log.warn({ err }, "failed to launch browser"));
    child.unref();
  } catch (err) {
    log.warn({ err }, "failed to launch browser");
  }
}
