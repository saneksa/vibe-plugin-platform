import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEnvelope, encodeEnvelope, type Envelope } from "../protocol/index.js";
import {
  createPlugin,
  readBoot,
  routeMatcher,
  type Boot,
  type HostApi,
  type PluginDefinition,
} from "./index.js";

type Rpc = Extract<Envelope, { type: "rpc" }>;
type MutableWindow = Window & { __VIBE_BOOT__?: unknown };

const ALL_CAPS = [
  "context.read",
  "theme.read",
  "notify",
  "navigate",
  "storage.read",
  "storage.write",
  "log",
  "events.read",
  "registry.read",
];

const DEFAULT_BOOT: Boot = {
  id: "clock",
  version: "1.0.0",
  hostApiMajor: "2",
  sdk: "2.0.0",
  capabilities: ALL_CAPS,
  kind: "widget",
};

let sent: Envelope[] = [];
let capturedHost: HostApi | undefined;
let capturedEl: HTMLElement | undefined;
let seq = 0;
const activeIids = new Set<string>();

function setBoot(value: unknown): void {
  (window as MutableWindow).__VIBE_BOOT__ = value;
}

function setSearch(query: string): void {
  window.history.replaceState(null, "", `/?${query}`);
}

function emit(env: Envelope): void {
  window.dispatchEvent(new MessageEvent("message", { data: encodeEnvelope(env) }));
}

function rpcOf(method: string): Rpc {
  const matches = sent.filter((e): e is Rpc => e.type === "rpc" && e.method === method);
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1];
}

function launch(
  opts: Partial<{ boot: unknown; iid: string; query: string; def: PluginDefinition }> = {},
): string {
  const iid = opts.iid ?? `i${++seq}`;
  const hasBoot = Object.prototype.hasOwnProperty.call(opts, "boot");
  setBoot(hasBoot ? opts.boot : DEFAULT_BOOT);
  setSearch(opts.query ?? `iid=${iid}&route=${encodeURIComponent("/")}`);
  const def = opts.def ?? { mount() {} };
  createPlugin({
    mount(el, host) {
      capturedEl = el;
      capturedHost = host;
      return def.mount(el, host);
    },
    ...(def.routes === undefined ? {} : { routes: def.routes }),
  });
  activeIids.add(iid);
  return iid;
}

function ready(iid: string, caps: string[] = ALL_CAPS): void {
  emit({ type: "ready", iid, api: "2", caps, deprecated: [], hostVersion: "2.4.0" });
}

function answer(id: number, value: unknown): void {
  emit({ type: "rpc.result", iid: [...activeIids][0], id, ok: true, value });
}

beforeEach(() => {
  sent = [];
  capturedHost = undefined;
  capturedEl = undefined;
  activeIids.clear();
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    sent.push(decodeEnvelope(message));
  });
});

afterEach(() => {
  for (const iid of activeIids) emit({ type: "lifecycle", iid, state: "destroy" });
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as MutableWindow).__VIBE_BOOT__;
  setSearch("");
});

describe("sdk boot & handshake", () => {
  it("readBoot reads the injected global synchronously and rejects malformed input", () => {
    setBoot(DEFAULT_BOOT);
    expect(readBoot()).toEqual(DEFAULT_BOOT);

    delete (window as MutableWindow).__VIBE_BOOT__;
    expect(() => readBoot()).toThrow(/__VIBE_BOOT__/);

    setBoot({ id: "clock" });
    expect(() => readBoot()).toThrow(/__VIBE_BOOT__/);
  });

  it("hello carries declared major from __VIBE_BOOT__, not from URL", () => {
    setBoot({
      hostApiMajor: "1",
      id: "clock",
      version: "1.0.0",
      sdk: "1.4.0",
      capabilities: [],
      kind: "widget",
    });
    setSearch("iid=i7&route=%2F&api=99");
    activeIids.add("i7");
    createPlugin({ mount() {} });

    expect(sent).toEqual([
      {
        type: "hello",
        iid: "i7",
        api: "1",
        sdk: "1.4.0",
        plugin: { id: "clock", version: "1.0.0" },
        wants: [],
      },
    ]);
  });

  it("waits for ready, mounts into a root element and cleans up on destroy", () => {
    const cleanup = vi.fn();
    const iid = launch({ def: { mount: () => cleanup } });

    expect(capturedHost).toBeUndefined();
    ready(iid);
    expect(capturedHost).toBeDefined();
    expect(capturedEl?.tagName).toBe("DIV");
    expect(document.body.contains(capturedEl as HTMLElement)).toBe(true);

    emit({ type: "lifecycle", iid, state: "destroy" });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(document.body.contains(capturedEl as HTMLElement)).toBe(false);
  });
});

describe("sdk hostApi", () => {
  it("has() reflects granted caps only", () => {
    const iid = launch();
    ready(iid, ["theme.read", "context.read"]);
    expect(capturedHost?.has("theme.read")).toBe(true);
    expect(capturedHost?.has("context.read")).toBe(true);
    expect(capturedHost?.has("storage.write")).toBe(false);
  });

  it("pending RPC correlates by id and resolves values", async () => {
    const iid = launch();
    ready(iid);

    const pending = capturedHost?.theme.get();
    const rpc = rpcOf("theme.get");
    expect(rpc).toMatchObject({ type: "rpc", iid, api: "2", method: "theme.get" });
    expect(typeof rpc.id).toBe("number");

    emit({ type: "rpc.result", iid, id: rpc.id, ok: true, value: { mode: "dark" } });
    await expect(pending).resolves.toEqual({ mode: "dark" });

    const second = capturedHost?.storage.get("k");
    const secondRpc = rpcOf("storage.get");
    expect(secondRpc.params).toBe("k");
    emit({ type: "rpc.result", iid, id: secondRpc.id, ok: true, value: "v" });
    await expect(second).resolves.toBe("v");
  });

  it("rejects a failed RPC with the host error code", async () => {
    const iid = launch();
    ready(iid);
    const pending = capturedHost?.registry.list();
    const rpc = rpcOf("registry.list");
    emit({
      type: "rpc.result",
      iid,
      id: rpc.id,
      ok: false,
      error: { code: "cap_denied", message: "missing capability" },
    });
    await expect(pending).rejects.toMatchObject({ code: "cap_denied", message: "missing capability" });
  });

  it("times out a pending RPC after 5s with error.code timeout", async () => {
    vi.useFakeTimers();
    const iid = launch();
    ready(iid);
    const pending = capturedHost?.theme.get();
    const rpc = rpcOf("theme.get");

    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(4999);
    expect(rpcOf("theme.get")).toBe(rpc);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("denies an ungranted cap locally without sending an RPC", async () => {
    const iid = launch();
    ready(iid, ["theme.read"]);
    expect(capturedHost?.has("storage.write")).toBe(false);
    await expect(capturedHost?.storage.set("k", "v")).rejects.toMatchObject({ code: "cap_denied" });
    expect(sent.filter((e) => e.type === "rpc" && e.method === "storage.set")).toHaveLength(0);
  });

  it("dispatches typed methods with the expected wire methods and params", async () => {
    const iid = launch();
    ready(iid);

    const ctx = capturedHost?.context.get();
    answer(rpcOf("context.get").id, { theme: "dark" });
    await ctx;

    const note = capturedHost?.notify.show({ level: "info", message: "hi" });
    expect(rpcOf("notify.show").params).toEqual({ level: "info", message: "hi" });
    answer(rpcOf("notify.show").id, undefined);
    await note;

    const removed = capturedHost?.storage.remove("k");
    expect(rpcOf("storage.remove").params).toBe("k");
    answer(rpcOf("storage.remove").id, undefined);
    await removed;

    capturedHost?.log("warn", "a", 1);
    expect(rpcOf("host.log").params).toEqual({ level: "warn", args: ["a", 1] });
    answer(rpcOf("host.log").id, undefined);
  });

  it("posts a navigate envelope with the replace flag", () => {
    const iid = launch();
    ready(iid);
    capturedHost?.navigate("/settings/general", { replace: true });
    expect(sent[sent.length - 1]).toEqual({
      type: "navigate",
      iid,
      path: "/settings/general",
      replace: true,
    });
  });

  it("fans out event envelopes to local subscribers and honours off()", () => {
    const iid = launch();
    ready(iid);
    const cb = vi.fn();
    capturedHost?.on("theme.changed", cb);
    expect(rpcOf("events.on").params).toBe("theme.changed");

    emit({ type: "event", iid, topic: "theme.changed", value: { mode: "dark" } });
    expect(cb).toHaveBeenCalledWith({ mode: "dark" });

    capturedHost?.off("theme.changed", cb);
    expect(rpcOf("events.off").params).toBe("theme.changed");
    emit({ type: "event", iid, topic: "theme.changed", value: { mode: "light" } });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("sdk routing", () => {
  it("routeMatcher extracts :params and ignores unmatched paths", () => {
    const settings = vi.fn();
    const home = vi.fn();
    const routes = { "/settings/:tab": settings, "/": home };

    routeMatcher(routes, "/settings/general");
    expect(settings).toHaveBeenCalledWith({ tab: "general" });

    routeMatcher(routes, "/unknown/path");
    expect(settings).toHaveBeenCalledTimes(1);
    expect(home).not.toHaveBeenCalled();

    routeMatcher(routes, "/");
    expect(home).toHaveBeenCalledWith({});
  });

  it("applies the initial query route and reacts to route envelopes", () => {
    const handler = vi.fn();
    const iid = "i9";
    launch({
      iid,
      query: `iid=${iid}&route=${encodeURIComponent("/settings/general")}`,
      def: { mount() {}, routes: { "/settings/:tab": handler } },
    });
    ready(iid);
    expect(handler).toHaveBeenCalledWith({ tab: "general" });

    emit({ type: "route", iid, path: "/settings/advanced" });
    expect(handler).toHaveBeenLastCalledWith({ tab: "advanced" });
  });
});
