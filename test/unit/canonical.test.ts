import { describe, expect, it } from "vitest";
import { canonicalResourceUri } from "../../src/oauth/canonical.js";

const canon = (raw: string) => canonicalResourceUri(new URL(raw));

describe("canonicalResourceUri", () => {
  it("lowercases scheme and host", () => {
    expect(canon("HTTPS://Example.COM/MCP")).toBe("https://example.com/MCP");
  });

  it("drops the URL fragment", () => {
    expect(canon("https://example.com/mcp#section")).toBe("https://example.com/mcp");
  });

  it("strips userinfo (never part of a resource indicator)", () => {
    expect(canon("https://user:pass@example.com/mcp")).toBe("https://example.com/mcp");
  });

  it("drops the default https port 443", () => {
    expect(canon("https://example.com:443/mcp")).toBe("https://example.com/mcp");
  });

  it("drops the default http port 80", () => {
    expect(canon("http://example.com:80/mcp")).toBe("http://example.com/mcp");
  });

  it("keeps a non-default port", () => {
    expect(canon("https://example.com:8443/mcp")).toBe("https://example.com:8443/mcp");
  });

  it("drops a lone trailing slash on the root", () => {
    expect(canon("https://example.com/")).toBe("https://example.com");
  });

  it("keeps a meaningful path's trailing slash untouched", () => {
    // Only the bare root "/" is trimmed; a real path is left as-is.
    expect(canon("https://example.com/mcp/")).toBe("https://example.com/mcp/");
  });

  it("preserves the query string", () => {
    expect(canon("https://example.com/mcp?tenant=acme")).toBe(
      "https://example.com/mcp?tenant=acme",
    );
  });

  it("does not trim the root slash when a query is present", () => {
    // out only loses the slash when pathname === "/" AND there is no search.
    expect(canon("https://example.com/?a=1")).toBe("https://example.com/?a=1");
  });

  it("is idempotent (canonical of canonical is unchanged)", () => {
    const once = canon("HTTPS://Example.COM:443/mcp#frag");
    expect(canon(once)).toBe(once);
  });

  it("produces a stable storage key for case/port variants of the same server", () => {
    expect(canon("https://Example.com:443/mcp")).toBe(canon("HTTPS://example.com/mcp"));
  });
});
