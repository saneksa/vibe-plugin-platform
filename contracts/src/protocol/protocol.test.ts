import { describe, expect, it } from "vitest";
import {
  CAPS_CATALOGUE,
  decodeEnvelope,
  encodeEnvelope,
  getMeta,
  getPolicy,
  majorOf,
  selectAdapter,
  type Envelope,
} from "./index";

describe("protocol", () => {
  it("api carries major only and rpc echoes hello.api", () => {
    expect(majorOf("2")).toBe("2");
    expect(() => majorOf("2.4")).toThrow();
    const hello = { type: "hello", iid: "i7", api: "1", sdk: "1.4.0", plugin: { id: "a", version: "1.0" }, wants: [] };
    expect(selectAdapter(hello.api, getPolicy())).toBe("v1");
    expect(selectAdapter("3", getPolicy())).toBe("reject");
  });

  it("round-trips every envelope variant", () => {
    const e = { type: "ready", iid: "i7", api: "2", caps: ["theme.read"], deprecated: ["1"], sunset: "host@3.0.0", hostVersion: "2.4.0" };
    expect(decodeEnvelope(encodeEnvelope(e as Envelope))).toEqual(e);
  });

  it("getPolicy is synchronous and matches the exported json", () => {
    expect(getPolicy().supported).toEqual(["2", "1"]);
    expect(getMeta(getPolicy()).supportedMajors).toEqual(["2", "1"]);
  });

  it("round-trips all ten wire variants", () => {
    const variants: Envelope[] = [
      { type: "hello", iid: "i1", api: "2", sdk: "2.1.0", plugin: { id: "a", version: "1.0" }, wants: ["theme.read"] },
      { type: "ready", iid: "i1", api: "2", caps: ["theme.read"], deprecated: ["1"] },
      { type: "rpc", iid: "i1", id: 42, api: "1", method: "theme.get", params: { key: "k" } },
      { type: "rpc.result", iid: "i1", id: 42, ok: true, value: { mode: "dark" } },
      { type: "rpc.result", iid: "i1", id: 42, ok: false, error: { code: "timeout", message: "timed out" } },
      { type: "event", iid: "i1", topic: "theme.changed", value: { mode: "light" } },
      { type: "navigate", iid: "i1", path: "/settings/general", replace: true },
      { type: "route", iid: "i1", path: "/settings/general" },
      { type: "lifecycle", iid: "i1", state: "destroy" },
      { type: "error", iid: "i1", message: "boom" },
    ];
    for (const e of variants) {
      expect(decodeEnvelope(encodeEnvelope(e))).toEqual(e);
    }
  });

  it("rejects unknown type, missing iid and malformed payloads", () => {
    expect(() => decodeEnvelope(JSON.stringify({ type: "bogus", iid: "i1" }))).toThrow();
    expect(() => decodeEnvelope(JSON.stringify({ type: "hello" }))).toThrow();
    expect(() => decodeEnvelope(JSON.stringify({ iid: "i1" }))).toThrow();
    expect(() => decodeEnvelope("not json")).toThrow();
  });

  it("selects the current adapter for the current major", () => {
    expect(selectAdapter("2", getPolicy())).toBe("current");
  });

  it("exports the exact caps catalogue", () => {
    expect(CAPS_CATALOGUE).toEqual([
      "context.read", "theme.read", "notify", "navigate",
      "storage.read", "storage.write", "log", "events.read", "registry.read",
    ]);
  });
});
