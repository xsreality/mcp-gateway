/**
 * RFC 8707 canonical resource URI for an MCP server.
 *
 * Lowercase scheme + host, no fragment, default ports dropped, and no trailing
 * slash on the root path. Used both as the `resource` indicator value and as the
 * key for per-server credential storage.
 */
export function canonicalResourceUri(url: URL): string {
  const u = new URL(url.href);
  u.hash = "";
  u.username = "";
  u.password = "";
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  // Drop default ports.
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }
  let out = u.toString();
  // Drop a lone trailing slash on the root (but keep meaningful paths intact).
  if (u.pathname === "/" && !u.search) {
    out = out.replace(/\/$/, "");
  }
  return out;
}
