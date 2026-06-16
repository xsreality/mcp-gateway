import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/cli.js",
);

type JsonRpc = Record<string, unknown> & { id?: number | string };

/**
 * Drives the built gateway over its stdio MCP channel exactly like a real
 * stdio MCP client: line-delimited JSON-RPC on stdin/stdout, with everything
 * else (logs, prompts) flowing on stderr. Tests assert on the round-trip.
 */
export class GatewayClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, (msg: any) => void>();
  private readonly stderrListeners = new Set<(text: string) => void>();
  private outBuf = "";

  constructor(args: string[]) {
    // Pin credential storage to the on-disk backend so e2e never depends on (or
    // mutates) the host's OS keychain. Tests can still override by passing it.
    const fullArgs = args.includes("--credential-store")
      ? args
      : ["--credential-store", "file", ...args];
    this.proc = spawn("node", [CLI, ...fullArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.outBuf += chunk.toString();
      let nl: number;
      while ((nl = this.outBuf.indexOf("\n")) !== -1) {
        const line = this.outBuf.slice(0, nl).trim();
        this.outBuf = this.outBuf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const fn of this.stderrListeners) fn(text);
    });
  }

  /** Register a stderr observer (used by the OAuth test to "be the browser"). */
  onStderr(fn: (text: string) => void): void {
    this.stderrListeners.add(fn);
  }

  notify(obj: JsonRpc): void {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(obj: JsonRpc): Promise<any> {
    return new Promise((resolve) => {
      this.pending.set(obj.id as number | string, resolve);
      this.notify(obj);
    });
  }

  /** Convenience for the standard MCP handshake. */
  async initialize(id = 1): Promise<any> {
    const res = await this.request({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "harness", version: "0.0.1" },
      },
    });
    this.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
    return res;
  }

  close(): void {
    this.proc.kill();
  }
}
