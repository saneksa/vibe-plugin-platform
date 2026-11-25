import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../protocol/index.js";
import { adaptV1Envelope } from "./adapters/v1.js";
import type { PluginDescriptorDTO, RegistrySnapshot } from "./registry.js";
import type { HostAdapter } from "./types.js";
import { switchActiveVersion } from "./upgrade.js";

/** Only the version port is exercised here; the rest of HostAdapter is irrelevant. */
function adapterWith(fn: HostAdapter["setActiveVersion"]): HostAdapter {
  return { setActiveVersion: fn } as HostAdapter;
}

describe("adaptV1Envelope", () => {
  it("v1 envelope is adapted into current shape without losing id", () => {
    const out = adaptV1Envelope({
      type: "rpc",
      iid: "i1",
      id: 9,
      api: "1",
      method: "theme.get",
    } as Envelope);

    expect(out.type).toBe("rpc");
    if (out.type === "rpc") expect(out.id).toBe(9);
  });

  it("keeps the declared v1 major in the result and does not mutate the input", () => {
    const input = {
      type: "rpc",
      iid: "i1",
      id: 9,
      api: "1",
      method: "theme.get",
      params: { key: "k" },
    } as Envelope;
    const before = JSON.parse(JSON.stringify(input)) as Envelope;

    const out = adaptV1Envelope(input);

    expect(out).toEqual(before);
    expect(out).not.toBe(input);
    expect(input).toEqual(before);
    if (out.type === "rpc") expect(out.api).toBe("1");
  });

  it("passes non-rpc envelopes through with the v1 major intact", () => {
    const ready = {
      type: "ready",
      iid: "i1",
      api: "1",
      caps: ["theme.read"],
      deprecated: ["1"],
    } as Envelope;

    const out = adaptV1Envelope(ready);

    expect(out).toEqual(ready);
    expect(out).not.toBe(ready);
    if (out.type === "ready") expect(out.api).toBe("1");
  });
});

describe("switchActiveVersion", () => {
  it("switchActiveVersion calls adapter and does not mutate HostState directly", async () => {
    const setActiveVersion = vi.fn(async () => {});
    const adapter = adapterWith(setActiveVersion);

    await switchActiveVersion(adapter, "clock", "2.0.0");

    expect(setActiveVersion).toHaveBeenCalledTimes(1);
    expect(setActiveVersion).toHaveBeenCalledWith("clock", "2.0.0");
  });

  it("awaits the adapter before resolving", async () => {
    let completed = false;
    const adapter = adapterWith(async () => {
      await Promise.resolve();
      completed = true;
    });

    await switchActiveVersion(adapter, "clock", "2.0.0");

    expect(completed).toBe(true);
  });

  it("propagates a rejection from the adapter", async () => {
    const adapter = adapterWith(async () => {
      throw new Error("backend down");
    });

    await expect(switchActiveVersion(adapter, "clock", "2.0.0")).rejects.toThrow("backend down");
  });
});

describe("registry DTO types", () => {
  it("describes descriptors and backend-owned active versions without storage", () => {
    const descriptor: PluginDescriptorDTO = {
      id: "clock",
      version: "2.0.0",
      kind: "widget",
      title: "Clock",
      icon: "clock.svg",
      capabilities: ["theme.read"],
      hostApi: "^2",
      unsupported: false,
    };
    const snapshot: RegistrySnapshot = {
      versions: [descriptor],
      activeVersion: { clock: "2.0.0" },
    };

    expect(snapshot.versions[0]).toEqual(descriptor);
    expect(snapshot.activeVersion.clock).toBe("2.0.0");
  });
});
