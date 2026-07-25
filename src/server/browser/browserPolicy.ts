import { isIP } from "node:net";
import type { BrowserEgressMode } from "./browserRuntime.js";

const MAX_BROWSER_URL_LENGTH = 8_192;
const MAX_ALLOWED_DOMAIN_COUNT = 64;
const MAX_ALLOWED_PORT_COUNT = 16;
const MAX_DNS_ANSWER_COUNT = 16;
const DEFAULT_RESOLVER_DEADLINE_MS = 2_000;
const MAX_RESOLVER_DEADLINE_MS = 10_000;
const BROWSER_EGRESS_MODES = new Set<string>(["public-web", "domain-allowlist"]);
const NON_PUBLIC_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

export interface BrowserEgressPolicy {
  readonly mode: BrowserEgressMode;
  readonly allowedDomains: readonly string[];
  readonly allowedPorts: readonly number[];
}

export interface BrowserDnsResolutionOptions {
  signal: AbortSignal;
  deadlineAtMs: number;
}

export interface BrowserDnsResolver {
  resolve(host: string, options: BrowserDnsResolutionOptions): Promise<readonly string[]>;
}

/** Injectable monotonic-enough clock seam for bounded resolver evaluation. */
export interface BrowserPolicyClock {
  now(): number;
}

/** Injectable timer seam so resolver deadlines do not require wall-clock tests. */
export type BrowserPolicyTimerHandle = ReturnType<typeof setTimeout> | number;

export interface BrowserPolicyTimer {
  setTimeout(callback: () => void, delayMs: number): BrowserPolicyTimerHandle;
  clearTimeout(handle: BrowserPolicyTimerHandle): void;
}

export interface BrowserEgressEvaluationOptions {
  clock?: BrowserPolicyClock;
  timer?: BrowserPolicyTimer;
  resolverDeadlineMs?: number;
}

const VALIDATED_BROWSER_EGRESS_POLICIES = new WeakSet();
const SYSTEM_BROWSER_POLICY_CLOCK: BrowserPolicyClock = { now: () => Date.now() };
const SYSTEM_BROWSER_POLICY_TIMER: BrowserPolicyTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

export type BrowserPolicyBlockReason =
  | "invalid-url"
  | "unsupported-scheme"
  | "userinfo-not-allowed"
  | "port-not-allowed"
  | "non-public-host"
  | "literal-ip-not-allowed"
  | "domain-not-allowed"
  | "policy-invalid"
  | "non-public-address"
  | "dns-no-addresses"
  | "dns-answer-limit-exceeded"
  | "dns-unavailable";

export type BrowserNavigationDecision = BrowserNavigationAllowed | BrowserNavigationBlocked;

export interface BrowserNavigationAllowed {
  allowed: true;
  url: string;
  host: string;
  port: number;
  /** Safe log projection: excludes destination path, query, fragment, and credentials. */
  auditOrigin: string;
}

export interface BrowserNavigationBlocked {
  allowed: false;
  reason: BrowserPolicyBlockReason;
  auditOrigin?: string;
}

/**
 * Compile trusted machine configuration once at browser-runtime load/reload.
 * Invalid configuration must keep the runtime unavailable; navigation checks
 * only accept this immutable compiled output and never re-normalize list data.
 */
export function compileBrowserEgressPolicy(config: unknown): BrowserEgressPolicy | undefined {
  if (!isRecord(config)) return undefined;
  const mode = config["mode"];
  const allowedDomains = config["allowedDomains"];
  const allowedPorts = config["allowedPorts"];
  if (!isBrowserEgressMode(mode)) return undefined;
  if (!Array.isArray(allowedDomains) || allowedDomains.length > MAX_ALLOWED_DOMAIN_COUNT) return undefined;
  if (!Array.isArray(allowedPorts) || allowedPorts.length > MAX_ALLOWED_PORT_COUNT) return undefined;

  const normalizedDomains: string[] = [];
  for (const entry of allowedDomains) {
    const normalized = normalizeAllowedDomain(entry);
    if (normalized === undefined) return undefined;
    if (!normalizedDomains.includes(normalized)) normalizedDomains.push(normalized);
  }
  const normalizedPorts: number[] = [];
  for (const entry of allowedPorts) {
    if (!isAllowedPort(entry)) return undefined;
    if (!normalizedPorts.includes(entry)) normalizedPorts.push(entry);
  }
  if (mode === "domain-allowlist" && normalizedDomains.length === 0) return undefined;

  const policy = Object.freeze({
    mode,
    allowedDomains: Object.freeze(normalizedDomains),
    allowedPorts: Object.freeze(normalizedPorts),
  });
  VALIDATED_BROWSER_EGRESS_POLICIES.add(policy);
  return policy;
}

/**
 * Parse and constrain an initial browser navigation without making a network
 * request. This module never fetches or proxies a destination; Chromium must
 * invoke the companion egress check for every request.
 */
export function evaluateBrowserNavigation(input: string, policy: BrowserEgressPolicy | undefined): BrowserNavigationDecision {
  if (!isCompiledBrowserEgressPolicy(policy)) return blocked("policy-invalid");
  if (!isValidUrlInput(input)) return blocked("invalid-url");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return blocked("invalid-url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return blocked("unsupported-scheme");
  if (url.username !== "" || url.password !== "") return blocked("userinfo-not-allowed");

  const host = normalizeHostname(url.hostname);
  if (host === undefined) return blocked("invalid-url");
  if (isNonPublicHostname(host)) return blocked("non-public-host");

  const port = effectivePort(url);
  if (!policy.allowedPorts.includes(port)) return blocked("port-not-allowed");

  const hostAddressKind = isIP(host);
  if (policy.mode === "domain-allowlist") {
    if (hostAddressKind !== 0) return blocked("literal-ip-not-allowed");
    if (!isAllowedDomain(host, policy.allowedDomains)) return blocked("domain-not-allowed");
  } else if (hostAddressKind !== 0 && !isPublicInternetAddress(host)) {
    return blocked("non-public-host");
  }

  url.hostname = host;
  return { allowed: true, url: url.href, host, port, auditOrigin: url.origin };
}

/**
 * Resolve a permitted hostname through an injected controlled resolver. This
 * bounded preflight is defense in depth only: a future runtime still needs
 * connection-time interception, a network boundary, and a concurrency budget
 * to defeat rebinding and renderer paths.
 */
export async function evaluateBrowserEgress(
  input: string,
  policy: BrowserEgressPolicy | undefined,
  resolver: BrowserDnsResolver,
  evaluationOptions?: BrowserEgressEvaluationOptions,
): Promise<BrowserNavigationDecision> {
  const navigation = evaluateBrowserNavigation(input, policy);
  if (!navigation.allowed) return navigation;
  if (isIP(navigation.host) !== 0) return navigation;

  const options = resolveEgressEvaluationOptions(evaluationOptions);
  if (options === undefined) return blockedWithOrigin("dns-unavailable", navigation.auditOrigin);
  const addresses = await resolveDnsWithDeadline(navigation.host, resolver, options);
  if (!Array.isArray(addresses)) return blockedWithOrigin("dns-unavailable", navigation.auditOrigin);
  if (addresses.length === 0) return blockedWithOrigin("dns-no-addresses", navigation.auditOrigin);
  if (addresses.length > MAX_DNS_ANSWER_COUNT) return blockedWithOrigin("dns-answer-limit-exceeded", navigation.auditOrigin);
  for (const address of addresses) {
    if (typeof address !== "string" || !isPublicInternetAddress(address)) return blockedWithOrigin("non-public-address", navigation.auditOrigin);
  }
  return navigation;
}

/** Classify a DNS result or literal destination without exposing it to callers. */
export function isPublicInternetAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address);
  const version = isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version !== 6) return false;
  const value = parseIpv6(normalized);
  return value !== undefined && isPublicIpv6(value);
}

interface ResolvedBrowserEgressEvaluationOptions {
  clock: BrowserPolicyClock;
  timer: BrowserPolicyTimer;
  resolverDeadlineMs: number;
}

function isCompiledBrowserEgressPolicy(policy: unknown): policy is BrowserEgressPolicy {
  return typeof policy === "object" && policy !== null && VALIDATED_BROWSER_EGRESS_POLICIES.has(policy);
}

function isBrowserEgressMode(value: unknown): value is BrowserEgressMode {
  return typeof value === "string" && BROWSER_EGRESS_MODES.has(value);
}

function resolveEgressEvaluationOptions(evaluationOptions: BrowserEgressEvaluationOptions | undefined): ResolvedBrowserEgressEvaluationOptions | undefined {
  const clock = evaluationOptions?.clock ?? SYSTEM_BROWSER_POLICY_CLOCK;
  const timer = evaluationOptions?.timer ?? SYSTEM_BROWSER_POLICY_TIMER;
  const resolverDeadlineMs = evaluationOptions?.resolverDeadlineMs ?? DEFAULT_RESOLVER_DEADLINE_MS;
  if (typeof clock.now !== "function" || typeof timer.setTimeout !== "function" || typeof timer.clearTimeout !== "function") return undefined;
  if (!Number.isSafeInteger(resolverDeadlineMs) || resolverDeadlineMs < 1 || resolverDeadlineMs > MAX_RESOLVER_DEADLINE_MS) return undefined;
  return { clock, timer, resolverDeadlineMs };
}

async function resolveDnsWithDeadline(
  host: string,
  resolver: BrowserDnsResolver,
  options: ResolvedBrowserEgressEvaluationOptions,
): Promise<readonly string[] | undefined> {
  const controller = new AbortController();
  let timerHandle: BrowserPolicyTimerHandle | undefined;
  try {
    const startedAtMs = options.clock.now();
    const deadlineAtMs = startedAtMs + options.resolverDeadlineMs;
    if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(deadlineAtMs)) return undefined;

    const timeout = new Promise<undefined>((resolve) => {
      timerHandle = options.timer.setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, options.resolverDeadlineMs);
    });
    // The race remains bounded even when a resolver ignores the abort signal.
    const resolution = Promise.resolve()
      .then(() => resolver.resolve(host, { signal: controller.signal, deadlineAtMs }))
      .catch(() => undefined);
    return await Promise.race([resolution, timeout]);
  } catch {
    return undefined;
  } finally {
    controller.abort();
    if (timerHandle !== undefined) {
      try {
        options.timer.clearTimeout(timerHandle);
      } catch {
        // The resolver is already aborted and the bounded timer can no longer affect the decision.
      }
    }
  }
}

function isAllowedPort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidUrlInput(input: string): boolean {
  return input.length > 0
    && input.length <= MAX_BROWSER_URL_LENGTH
    && input === input.trim()
    && !hasControlCharacter(input);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeHostname(value: string): string | undefined {
  const host = stripIpv6Brackets(value).toLowerCase().replace(/\.+$/u, "");
  if (host === "") return undefined;
  if (isIP(host) !== 0) return host;
  if (host.length > 253) return undefined;

  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(label))) return undefined;
  return host;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function isNonPublicHostname(host: string): boolean {
  return isIP(host) === 0 && (
    !host.includes(".")
    || NON_PUBLIC_HOSTS.has(host)
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
  );
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "http:" ? 80 : 443;
}

function normalizeAllowedDomain(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value || value === "") return undefined;
  const wildcard = value.startsWith("*.");
  const rawHost = wildcard ? value.slice(2) : value;
  const host = normalizeHostname(rawHost);
  if (host === undefined || !host.includes(".") || isIP(host) !== 0) return undefined;
  return wildcard ? `*.${host}` : host;
}

function isAllowedDomain(host: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((normalized) => {
    if (!normalized.startsWith("*.")) return host === normalized;
    const suffix = normalized.slice(2);
    return host !== suffix && host.endsWith(`.${suffix}`);
  });
}

function blocked(reason: BrowserPolicyBlockReason): BrowserNavigationBlocked {
  return { allowed: false, reason };
}

function blockedWithOrigin(reason: BrowserPolicyBlockReason, auditOrigin: string): BrowserNavigationBlocked {
  return { allowed: false, reason, auditOrigin };
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (octets === undefined) return false;
  const [first, second, third, fourth] = octets;
  const value = ((first << 24) | (second << 16) | (third << 8) | fourth) >>> 0;

  return !NON_PUBLIC_IPV4_PREFIXES.some(([prefix, bits]) => isIpv4Prefix(value, prefix, bits));
}

const NON_PUBLIC_IPV4_PREFIXES: readonly (readonly [prefix: number, bits: number])[] = [
  [0x0000_0000, 8], // unspecified and "this" network
  [0x0a00_0000, 8], // RFC1918
  [0x6440_0000, 10], // carrier-grade NAT
  [0x7f00_0000, 8], // loopback
  [0xa9fe_0000, 16], // link-local / cloud metadata
  [0xac10_0000, 12], // RFC1918
  [0xc000_0000, 24], // IETF protocol assignments
  [0xc000_0200, 24], // documentation
  [0xc0a8_0000, 16], // RFC1918
  [0xc612_0000, 15], // benchmarking
  [0xc633_6400, 24], // documentation
  [0xcb00_7100, 24], // documentation
  [0xe000_0000, 4], // multicast and reserved
];

function isIpv4Prefix(value: number, prefix: number, bits: number): boolean {
  const mask = (0xffff_ffff << (32 - bits)) >>> 0;
  return (value & mask) === (prefix & mask);
}

function isPublicIpv6(value: bigint): boolean {
  const embeddedIpv4 = embeddedIpv4Address(value);
  if (embeddedIpv4 !== undefined) return isPublicIpv4(integerToIpv4(embeddedIpv4));
  if (isIpv6Prefix(value, IPV4_IPV6_TRANSLATION_ALLOCATION.prefix, IPV4_IPV6_TRANSLATION_ALLOCATION.bits)) return false;
  if (!isIpv6Prefix(value, PUBLIC_NATIVE_IPV6_GLOBAL_UNICAST.prefix, PUBLIC_NATIVE_IPV6_GLOBAL_UNICAST.bits)) return false;
  return !UNSUPPORTED_NATIVE_IPV6_PREFIXES.some(({ prefix, bits }) => isIpv6Prefix(value, prefix, bits));
}

function embeddedIpv4Address(value: bigint): number | undefined {
  if (!IPV4_EMBEDDED_IPV6_PREFIXES.some(({ prefix, bits }) => isIpv6Prefix(value, prefix, bits))) return undefined;
  return Number(value & 0xffff_ffffn);
}

function integerToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function isIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  return value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
}

function parseIpv6(address: string): bigint | undefined {
  let normalized = address.toLowerCase();
  const ipv4 = /\d+\.\d+\.\d+\.\d+$/u.exec(normalized)?.[0];
  if (ipv4 !== undefined) {
    const octets = parseIpv4Octets(ipv4);
    if (octets === undefined) return undefined;
    const [first, second, third, fourth] = octets;
    const highGroup = ((first << 8) | second).toString(16);
    const lowGroup = ((third << 8) | fourth).toString(16);
    normalized = `${normalized.slice(0, -ipv4.length)}${highGroup}:${lowGroup}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const [leftHalf, rightHalf] = halves;
  if (leftHalf === undefined) return undefined;
  const left = leftHalf === "" ? [] : leftHalf.split(":");
  const right = rightHalf === undefined || rightHalf === "" ? [] : rightHalf.split(":");
  const missing = 8 - left.length - right.length;
  if ((rightHalf === undefined && missing !== 0) || (rightHalf !== undefined && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))) return undefined;

  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function parseIpv4Octets(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".").map(Number);
  const [first, second, third, fourth] = parts;
  if (parts.length !== 4 || first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined;
  if (![first, second, third, fourth].every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return undefined;
  return [first, second, third, fourth];
}

const IPV4_EMBEDDED_IPV6_PREFIXES = [
  ipv6Prefix("::", 96), // IPv4-compatible
  ipv6Prefix("::ffff:0:0", 96), // IPv4-mapped
  ipv6Prefix("::ffff:0:0:0", 96), // IPv4-translated
  ipv6Prefix("64:ff9b::", 96), // well-known NAT64
];

// Only the well-known /96 translation prefix is understood by this pure
// classifier. Other addresses in the IANA translation allocation fail closed.
const IPV4_IPV6_TRANSLATION_ALLOCATION = ipv6Prefix("64:ff9b::", 32);

// Native IPv6 is public only in the ordinary global-unicast /3. This rejects
// site-local, ULA, link-local, multicast, and non-GUA/unallocated 4000::/3.
const PUBLIC_NATIVE_IPV6_GLOBAL_UNICAST = ipv6Prefix("2000::", 3);

const UNSUPPORTED_NATIVE_IPV6_PREFIXES = [
  // IETF protocol assignments include Teredo (2001::/32) and ORCHIDv2
  // (2001:20::/28). Do not decode or permit any Teredo endpoint fields.
  ipv6Prefix("2001::", 23),
  ipv6Prefix("2001:db8::", 32), // documentation
  ipv6Prefix("2002::", 16), // 6to4 transition addresses
  ipv6Prefix("2620:4f:8000::", 48), // AS112 direct delegation
  ipv6Prefix("3fff::", 20), // documentation
];

function ipv6Prefix(address: string, bits: number): { prefix: bigint; bits: number } {
  const prefix = parseIpv6(address);
  if (prefix === undefined) throw new Error(`Invalid built-in IPv6 prefix: ${address}`);
  return { prefix, bits };
}
