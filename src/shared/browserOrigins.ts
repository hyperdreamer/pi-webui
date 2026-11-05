const FORBIDDEN_ORIGIN_CHARACTERS = /[\s\p{Cc}\\?#@*,]/u;
const ABSOLUTE_HTTP_ORIGIN = /^https?:\/\/[^/]+\/?$/iu;

function parseAbsoluteBrowserOrigin(value: string): string | undefined {
  const input = value.trim();
  if (FORBIDDEN_ORIGIN_CHARACTERS.test(input) || !ABSOLUTE_HTTP_ORIGIN.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes one configured browser origin. The serialized origin is parsed
 * again so percent-encoded or Unicode host characters cannot smuggle a
 * forbidden character past the input check, and accepted inputs are
 * idempotent.
 */
export function normalizeBrowserOrigin(value: string): string | undefined {
  const origin = parseAbsoluteBrowserOrigin(value);
  if (origin === undefined) return undefined;
  return parseAbsoluteBrowserOrigin(origin) === origin ? origin : undefined;
}
