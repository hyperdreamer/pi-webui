export function normalizeBrowserOrigin(value: string): string | undefined {
  const input = value.trim();
  if (/[\s\p{Cc}\\?#@*,]/u.test(input) || !/^https?:\/\/[^/]+\/?$/iu.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
