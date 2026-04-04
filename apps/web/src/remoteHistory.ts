import {
  createBrowserHistory,
  type NavigateOptions,
  type RouterHistory,
} from "@tanstack/react-router";

const REMOTE_AUTH_TOKEN_QUERY_PARAM = "token";
const FALLBACK_ORIGIN = "http://localhost";

function parseSearchParams(search: string): URLSearchParams {
  if (search.length === 0) {
    return new URLSearchParams();
  }

  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

export function preserveRemoteAuthTokenInPath(
  path: string,
  currentSearch: string,
  currentOrigin = FALLBACK_ORIGIN,
): string {
  const token = parseSearchParams(currentSearch).get(REMOTE_AUTH_TOKEN_QUERY_PARAM);
  if (!token) {
    return path;
  }

  let resolved: URL;
  try {
    resolved = new URL(path, currentOrigin);
  } catch {
    return path;
  }

  if (
    resolved.origin !== currentOrigin ||
    resolved.searchParams.has(REMOTE_AUTH_TOKEN_QUERY_PARAM)
  ) {
    return path;
  }

  resolved.searchParams.set(REMOTE_AUTH_TOKEN_QUERY_PARAM, token);
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function createRemoteAwareBrowserHistory(opts?: { window?: Window }): RouterHistory {
  const history = createBrowserHistory(opts);
  const win = opts?.window;
  const resolveOrigin = () => win?.location.origin ?? window.location.origin ?? FALLBACK_ORIGIN;
  const preserve = (path: string) =>
    preserveRemoteAuthTokenInPath(path, history.location.search, resolveOrigin());

  const originalPush = history.push.bind(history);
  const originalReplace = history.replace.bind(history);
  const originalCreateHref = history.createHref.bind(history);

  history.push = (path: string, state?: unknown, navigateOpts?: NavigateOptions) =>
    originalPush(preserve(path), state, navigateOpts);
  history.replace = (path: string, state?: unknown, navigateOpts?: NavigateOptions) =>
    originalReplace(preserve(path), state, navigateOpts);
  history.createHref = (path: string) => originalCreateHref(preserve(path));

  return history;
}
