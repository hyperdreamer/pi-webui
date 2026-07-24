export type QueryValue = string | number | boolean | readonly (string | number | boolean)[];

export function queryNamespace(contributionId: string): string {
  return contributionId.replaceAll(":", ".");
}

export function readNamespacedQuery(namespace: string): Record<string, string | string[]> {
  const params = new URLSearchParams(window.location.search);
  const prefix = `${namespace}--`;
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    if (!key.startsWith(prefix)) continue;
    const localKey = key.slice(prefix.length);
    const existing = result[localKey];
    if (existing === undefined) result[localKey] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[localKey] = [existing, value];
  }
  return result;
}

export function readNamespacedString(namespace: string, key: string): string | undefined {
  const value = readNamespacedQuery(namespace)[key];
  if (Array.isArray(value)) return value[0];
  return value === "" ? undefined : value;
}

export function setNamespacedQueryKey(namespace: string, key: string, value: QueryValue | undefined | null, options?: { replace?: boolean | undefined }): void {
  const url = new URL(window.location.href);
  const namespacedKey = `${namespace}--${key}`;
  url.searchParams.delete(namespacedKey);
  if (value !== undefined && value !== null && value !== "") {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(namespacedKey, String(item));
    } else {
      url.searchParams.set(namespacedKey, String(value));
    }
  }
  commitUrl(url, options);
}

function commitUrl(url: URL, options?: { replace?: boolean | undefined }): void {
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options?.replace === true) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}
