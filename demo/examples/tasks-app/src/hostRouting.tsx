/**
 * Bridge between react-router and the host's virtual URL space. The app has
 * no URL of its own: the host owns `/app/<iid>/<path>`, syncs it over `route`
 * envelopes, and expects `navigate` envelopes in return (spec §12).
 *
 * Direction app → host: react-router's navigator.push/replace mirror the new
 * path into the host URL. Direction host → app: the SDK route table calls
 * `applyHostRoute(path)`, which replaces the current history entry. The host
 * echoes every navigate back as a route; `applyHostRoute` recognizes the echo
 * (path already current) and stops the loop there.
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from "react";
import { Router, createPath, parsePath } from "react-router";
import type { NavigationType, Navigator, To } from "react-router";
import type { HostApi } from "@vibe/plugin-contracts/sdk";

export interface HistoryLocation {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
}

export type HistoryAction = "POP" | "PUSH" | "REPLACE";

export interface HistoryUpdate {
  action: HistoryAction;
  location: HistoryLocation;
}

export interface History {
  readonly action: HistoryAction;
  readonly location: HistoryLocation;
  createHref(to: To): string;
  encodeLocation(to: To): { pathname: string; search: string; hash: string };
  push(to: To, state?: unknown): void;
  replace(to: To, state?: unknown): void;
  go(delta: number): void;
  listen(fn: (update: HistoryUpdate) => void): () => void;
}

function pathToEntry(to: To, state?: unknown): HistoryLocation {
  const parsed = typeof to === "string" ? parsePath(to) : to;
  return {
    pathname: parsed.pathname ?? "/",
    search: parsed.search ?? "",
    hash: parsed.hash ?? "",
    state: state ?? null,
    key: Math.random().toString(36).slice(2, 10),
  };
}

/** Memory history, local to this frame. Unlike react-router's it keeps a set of listeners. */
function createHistory(initialPath: string): History {
  let entries = [pathToEntry(initialPath)];
  let index = 0;
  let action: HistoryAction = "POP";
  const listeners = new Set<(update: HistoryUpdate) => void>();

  const notify = (): void => {
    const update: HistoryUpdate = { action, location: entries[index]! };
    for (const listener of listeners) listener(update);
  };

  return {
    get action() {
      return action;
    },
    get location() {
      return entries[index]!;
    },
    createHref(to) {
      return typeof to === "string" ? to : createPath(to);
    },
    encodeLocation(to) {
      const parsed = typeof to === "string" ? parsePath(to) : to;
      return { pathname: parsed.pathname ?? "", search: parsed.search ?? "", hash: parsed.hash ?? "" };
    },
    push(to, state) {
      entries = [...entries.slice(0, index + 1), pathToEntry(to, state)];
      index = entries.length - 1;
      action = "PUSH";
      notify();
    },
    replace(to, state) {
      entries[index] = pathToEntry(to, state);
      action = "REPLACE";
      notify();
    },
    go(delta) {
      const next = Math.min(Math.max(index + delta, 0), entries.length - 1);
      if (next === index) return;
      index = next;
      action = "POP";
      notify();
    },
    listen(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export interface HostRouting {
  /** The source of truth for the rendered location; passed to <HostRouter>. */
  history: History;
  /** What <Router> calls for Link / useNavigate; mirrors moves into the host. */
  navigator: Navigator;
  /** Entry point for the SDK route table: applies a host-driven path. */
  applyHostRoute(path: string): void;
}

export function createHostRouting(host: HostApi, initialPath: string): HostRouting {
  const history = createHistory(initialPath);
  let applyingHostRoute = false;

  const mirrorToHost = (replace: boolean): void => {
    if (applyingHostRoute) return;
    // The host pushes/replaces /app/<iid>/<path> and echoes a `route`
    // envelope; the echo is a no-op in applyHostRoute.
    host.navigate(createPath(history.location), { replace });
  };

  const navigator: Navigator = {
    createHref: (to) => history.createHref(to),
    encodeLocation: (to) => history.encodeLocation(to),
    push: (to, state) => {
      history.push(to, state);
      mirrorToHost(false);
    },
    replace: (to, state) => {
      history.replace(to, state);
      mirrorToHost(true);
    },
    go: (delta) => history.go(delta),
  };

  return {
    history,
    navigator,
    applyHostRoute(path: string): void {
      if (createPath(history.location) === path) return;
      // Host-driven moves (back/forward, deep links) replace the current
      // entry: the app's stack follows the host URL one step at a time.
      applyingHostRoute = true;
      try {
        history.replace(path);
      } finally {
        applyingHostRoute = false;
      }
    },
  };
}

/**
 * The only react-router pieces rendered directly; everything else is a
 * normal <Routes>/<Route> tree inside.
 */
export function HostRouter({ routing, children }: { routing: HostRouting; children: ReactNode }) {
  const [state, setState] = useState({
    action: routing.history.action,
    location: routing.history.location,
  });
  useLayoutEffect(
    () => routing.history.listen((update) => setState({ action: update.action, location: update.location })),
    [routing],
  );
  return createElement(
    Router,
    {
      location: state.location,
      navigationType: state.action as NavigationType,
      navigator: routing.navigator,
    },
    children,
  );
}

/**
 * Route patterns of the app, in match order (first match wins in the SDK's
 * routeMatcher). The catch-alls at the end let unknown host paths reach the
 * app too, so the router can render its 404 view. Keep in sync with the
 * <Routes> tree in App.tsx and with manifest.routes.
 */
export const SDK_ROUTE_PATTERNS: readonly string[] = [
  "/",
  "/tasks",
  "/tasks/:filter",
  "/task/:taskId",
  "/projects",
  "/projects/:projectId",
  "/about",
  "/:a",
  "/:a/:b",
  "/:a/:b/:c",
];

/** Rebuilds the concrete path a matched pattern + params came from. */
export function pathFromPattern(pattern: string, params: Record<string, string>): string {
  const joined = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? params[segment.slice(1)] ?? "" : segment))
    .join("/")
    .replace(/\/+$/, "");
  return joined === "" ? "/" : joined;
}
