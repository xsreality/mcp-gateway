import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  defaultTokenStoreDir,
  parseHeaders,
  parseUrl,
} from "../../src/config.js";

describe("parseHeaders", () => {
  it("returns an empty map for no flags", () => {
    expect(parseHeaders([])).toEqual({});
  });

  it("parses a single 'Key: value' pair", () => {
    expect(parseHeaders(["Authorization: Bearer xyz"])).toEqual({
      Authorization: "Bearer xyz",
    });
  });

  it("trims whitespace around key and value", () => {
    expect(parseHeaders(["  X-Tenant  :   acme  "])).toEqual({ "X-Tenant": "acme" });
  });

  it("splits only on the first colon so values may contain colons", () => {
    expect(parseHeaders(["X-Proxy: host:8080"])).toEqual({ "X-Proxy": "host:8080" });
  });

  it("accumulates multiple headers", () => {
    expect(parseHeaders(["A: 1", "B: 2"])).toEqual({ A: "1", B: "2" });
  });

  it("lets a later duplicate key win", () => {
    expect(parseHeaders(["A: 1", "A: 2"])).toEqual({ A: "2" });
  });

  it("allows an empty value", () => {
    expect(parseHeaders(["X-Flag:"])).toEqual({ "X-Flag": "" });
  });

  it("throws when there is no colon", () => {
    expect(() => parseHeaders(["nocolon"])).toThrow(ConfigError);
  });

  it("throws when the header name is empty", () => {
    expect(() => parseHeaders([": value"])).toThrow(ConfigError);
  });
});

describe("parseUrl", () => {
  it("accepts an https URL", () => {
    expect(parseUrl("https://example.com/mcp").href).toBe("https://example.com/mcp");
  });

  it("accepts an http URL", () => {
    expect(parseUrl("http://localhost:3000/mcp").href).toBe("http://localhost:3000/mcp");
  });

  it("throws ConfigError on an unparseable URL", () => {
    expect(() => parseUrl("not a url")).toThrow(ConfigError);
  });

  it("throws ConfigError on a non-http(s) scheme", () => {
    expect(() => parseUrl("ftp://example.com/mcp")).toThrow(ConfigError);
    expect(() => parseUrl("ws://example.com/mcp")).toThrow(/http/);
  });
});

describe("defaultTokenStoreDir", () => {
  it("is ~/.mcp-gateway under the user's home", () => {
    expect(defaultTokenStoreDir()).toBe(path.join(os.homedir(), ".mcp-gateway"));
  });
});
