export interface AppUrlContext {
  viteBaseUrl: string;
  documentBaseUrl: string;
}

/**
 * Resolve a PI WEBUI-owned reference at a browser boundary.
 *
 * Core callers keep paths application-relative (no leading slash), encode every dynamic path segment,
 * and resolve exactly once. Leading slashes are accepted only for existing plugin-manifest compatibility
 * and mean the application root rather than the origin root.
 */
export function resolveAppUrl(path: string, context: AppUrlContext = browserAppUrlContext()): string {
  const applicationBaseUrl = new URL(context.viteBaseUrl, context.documentBaseUrl);
  return new URL(appRelativePath(path), applicationBaseUrl).toString();
}

export function resolveAppWebSocketUrl(path: string, context: AppUrlContext = browserAppUrlContext()): string {
  const url = new URL(resolveAppUrl(path, context));
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new Error(`Cannot create a WebSocket URL from ${url.protocol}`);
  }
  return url.toString();
}

function browserAppUrlContext(): AppUrlContext {
  return {
    viteBaseUrl: import.meta.env.BASE_URL,
    documentBaseUrl: document.baseURI,
  };
}

function appRelativePath(path: string): string {
  // A leading slash means the application root, not the origin root, so it must stay within nested deployments.
  return path.startsWith("/") ? `.${path}` : path;
}
