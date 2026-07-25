import { describe, expect, it } from "vitest";
import { evaluateBrowserEgress, evaluateBrowserNavigation, isPublicInternetAddress, type BrowserEgressPolicy } from "./browserPolicy.js";

const publicWeb: BrowserEgressPolicy = {
  mode: "public-web",
  allowedDomains: [],
  allowedPorts: [80, 443],
};

const documentationOnly: BrowserEgressPolicy = {
  mode: "domain-allowlist",
  allowedDomains: ["docs.example.test", "*.static.example.test"],
  allowedPorts: [443],
};

describe("browser egress policy", () => {
  it.each([
    ["file:///etc/passwd", "unsupported-scheme"],
    ["data:text/html,hello", "unsupported-scheme"],
    ["https://user:password@example.test", "userinfo-not-allowed"],
    ["https://example.test:8443", "port-not-allowed"],
    ["https://localhost", "non-public-host"],
    ["https://metadata.google.internal", "non-public-host"],
    ["https://example.test/\nsecret", "invalid-url"],
  ] as const)("rejects unsafe initial navigation %s", (url, reason) => {
    expect(evaluateBrowserNavigation(url, publicWeb)).toEqual({ allowed: false, reason });
  });

  it.each([
    "64:ff9b::c0a8:1",
    "64:ff9b::a9fe:a9fe",
    "::ffff:0:c0a8:1",
    "::ffff:0:a9fe:a9fe",
  ])("rejects a transition-form literal that embeds a non-public IPv4 address: %s", (address) => {
    expect(evaluateBrowserNavigation(`https://[${address}]/`, publicWeb)).toEqual({ allowed: false, reason: "non-public-host" });
  });

  it("fails closed when a policy has an unknown mode", () => {
    const malformed = { ...publicWeb };
    Reflect.set(malformed, "mode", "private-network");

    expect(evaluateBrowserNavigation("https://example.test", malformed)).toEqual({ allowed: false, reason: "policy-invalid" });
  });

  it("normalizes a permitted public-web navigation without retaining query data in audit projection", () => {
    expect(evaluateBrowserNavigation("https://ExAmPle.test:443/private?token=not-for-logs#secret", publicWeb)).toEqual({
      allowed: true,
      url: "https://example.test/private?token=not-for-logs#secret",
      host: "example.test",
      port: 443,
      auditOrigin: "https://example.test",
    });
  });

  it("canonicalizes a trailing domain dot before returning the navigation", () => {
    expect(evaluateBrowserNavigation("https://docs.example.test./guide", documentationOnly)).toEqual({
      allowed: true,
      url: "https://docs.example.test/guide",
      host: "docs.example.test",
      port: 443,
      auditOrigin: "https://docs.example.test",
    });
  });

  it("requires an exact domain or a real subdomain in domain-allowlist mode", () => {
    expect(evaluateBrowserNavigation("https://docs.example.test/guide", documentationOnly)).toMatchObject({ allowed: true });
    expect(evaluateBrowserNavigation("https://cdn.static.example.test/app.js", documentationOnly)).toMatchObject({ allowed: true });
    expect(evaluateBrowserNavigation("https://static.example.test", documentationOnly)).toEqual({ allowed: false, reason: "domain-not-allowed" });
    expect(evaluateBrowserNavigation("https://static.example.test.evil.test", documentationOnly)).toEqual({ allowed: false, reason: "domain-not-allowed" });
    expect(evaluateBrowserNavigation("https://127.0.0.1", documentationOnly)).toEqual({ allowed: false, reason: "literal-ip-not-allowed" });
  });

  it("requires every resolved address to be public before allowing a hostname", async () => {
    const resolver = { resolve: () => Promise.resolve(["93.184.216.34", "10.0.0.8"]) };

    await expect(evaluateBrowserEgress("https://example.test", publicWeb, resolver)).resolves.toEqual({
      allowed: false,
      reason: "non-public-address",
      auditOrigin: "https://example.test",
    });
  });

  it("fails closed when controlled DNS cannot return a usable public address", async () => {
    await expect(evaluateBrowserEgress("https://example.test", publicWeb, { resolve: () => Promise.resolve([]) })).resolves.toEqual({
      allowed: false,
      reason: "dns-no-addresses",
      auditOrigin: "https://example.test",
    });
    await expect(evaluateBrowserEgress("https://example.test", publicWeb, { resolve: () => Promise.reject(new Error("resolver offline")) })).resolves.toEqual({
      allowed: false,
      reason: "dns-unavailable",
      auditOrigin: "https://example.test",
    });
  });

  it("allows a hostname only when its controlled resolution is public", async () => {
    const resolver = { resolve: () => Promise.resolve(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) };

    await expect(evaluateBrowserEgress("https://docs.example.test/guide", documentationOnly, resolver)).resolves.toEqual({
      allowed: true,
      url: "https://docs.example.test/guide",
      host: "docs.example.test",
      port: 443,
      auditOrigin: "https://docs.example.test",
    });
  });
});

describe("public address classifier", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicInternetAddress(address)).toBe(false);
  });

  it.each([
    ["well-known NAT64 carrying a public IPv4 address", "64:ff9b::5db8:d822"],
    ["IPv4-translated IPv6 carrying a public IPv4 address", "::ffff:0:5db8:d822"],
    ["ordinary public IPv4", "93.184.216.34"],
    ["ordinary public IPv6", "2606:2800:220:1:248:1893:25c8:1946"],
  ] as const)("accepts %s (%s)", (_description, address) => {
    expect(isPublicInternetAddress(address)).toBe(true);
  });

  it.each([
    ["well-known NAT64 carrying RFC1918 IPv4", "64:ff9b::c0a8:1"],
    ["well-known NAT64 carrying the cloud-metadata IPv4 range", "64:ff9b::a9fe:a9fe"],
    ["IPv4-translated IPv6 carrying RFC1918 IPv4", "::ffff:0:c0a8:1"],
    ["IPv4-translated IPv6 carrying the cloud-metadata IPv4 range", "::ffff:0:a9fe:a9fe"],
    ["an unsupported prefix in the IPv4-IPv6 translation allocation", "64:ff9b:2::5db8:d822"],
  ] as const)("rejects %s (%s)", (_description, address) => {
    expect(isPublicInternetAddress(address)).toBe(false);
  });
});
