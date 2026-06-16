#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import {
  type Config,
  ConfigError,
  type CredentialStore,
  defaultTokenStoreDir,
  parseHeaders,
  parseUrl,
} from "./config.js";
import { createLogger, type LogLevel } from "./log.js";
import { Gateway } from "./gateway.js";

interface RawOptions {
  url?: string;
  header: string[];
  scope?: string;
  clientName: string;
  clientId?: string;
  clientSecret?: string;
  dcr: boolean;
  callbackPort?: number;
  authTimeout: number;
  credentialStore: string;
  tokenStore: string;
  browser: boolean;
  logLevel: string;
  logFile?: string;
}

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "silent"];
const CREDENTIAL_STORES: CredentialStore[] = ["auto", "keychain", "file"];

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function intArg(name: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${name} must be a non-negative integer`);
    }
    return n;
  };
}

function buildProgram(): Command {
  return new Command()
    .name("mcp-gateway")
    .description(
      "Expose a local STDIO MCP endpoint that proxies a remote Streamable-HTTP MCP server (OAuth 2.1 + DCR).",
    )
    .requiredOption(
      "--url <url>",
      "Remote Streamable-HTTP MCP server endpoint",
      process.env.MCP_GATEWAY_URL,
    )
    .option("--header <k:v>", 'Static header forwarded upstream, "Key: value" (repeatable)', collect, [])
    .option("--scope <scopes>", "OAuth scopes to request", process.env.MCP_GATEWAY_SCOPE)
    .option("--client-name <name>", "client_name used in Dynamic Client Registration", "mcp-gateway")
    .option("--client-id <id>", "Pre-registered OAuth client id (skips DCR)", process.env.MCP_GATEWAY_CLIENT_ID)
    .option("--client-secret <secret>", "Pre-registered OAuth client secret", process.env.MCP_GATEWAY_CLIENT_SECRET)
    .option("--no-dcr", "Disable Dynamic Client Registration")
    .option("--callback-port <port>", "Fixed loopback OAuth callback port", intArg("--callback-port"))
    .option("--auth-timeout <seconds>", "Max wait for browser authorization", intArg("--auth-timeout"), 300)
    .addOption(
      new Option(
        "--credential-store <mode>",
        "Where to persist credentials: keychain (OS keychain), file (on-disk), or auto",
      )
        .choices(CREDENTIAL_STORES)
        .default(process.env.MCP_GATEWAY_CREDENTIAL_STORE ?? "auto"),
    )
    .option("--token-store <dir>", "Directory for file-stored tokens + client registration", defaultTokenStoreDir())
    .option("--no-browser", "Print the authorization URL instead of opening a browser")
    .addOption(
      new Option("--log-level <level>", "Log verbosity (stderr/file only)")
        .choices(LOG_LEVELS)
        .default(process.env.MCP_GATEWAY_LOG_LEVEL ?? "info"),
    )
    .option("--log-file <path>", "Write logs to a file instead of stderr", process.env.MCP_GATEWAY_LOG_FILE);
}

function resolveConfig(opts: RawOptions): Config {
  if (!opts.url) {
    throw new ConfigError("--url is required (or set MCP_GATEWAY_URL)");
  }
  if (!LOG_LEVELS.includes(opts.logLevel as LogLevel)) {
    throw new InvalidArgumentError(`invalid --log-level "${opts.logLevel}"`);
  }
  if (!CREDENTIAL_STORES.includes(opts.credentialStore as CredentialStore)) {
    throw new InvalidArgumentError(`invalid --credential-store "${opts.credentialStore}"`);
  }
  if (!opts.dcr && !opts.clientId) {
    throw new ConfigError("--no-dcr requires --client-id to be provided");
  }
  return {
    url: parseUrl(opts.url),
    headers: parseHeaders(opts.header),
    scope: opts.scope,
    clientName: opts.clientName,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    dcr: opts.dcr,
    callbackPort: opts.callbackPort,
    authTimeoutSec: opts.authTimeout,
    credentialStore: opts.credentialStore as CredentialStore,
    tokenStoreDir: opts.tokenStore,
    openBrowser: opts.browser,
    logLevel: opts.logLevel as LogLevel,
    logFile: opts.logFile,
  };
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.parse(process.argv);
  const opts = program.opts<RawOptions>();

  const config = resolveConfig(opts);
  const log = createLogger({ level: config.logLevel, file: config.logFile });
  const gateway = await Gateway.create(config, log);

  const shutdown = (signal: string) => {
    log.info({ signal }, "received signal, shutting down");
    void gateway.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await gateway.run();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "gateway failed");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Last-resort handler; logger may not exist yet. stderr only.
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
