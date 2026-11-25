import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "./registry.js";

const dirs: string[] = [];
const registryPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-registry-"));
  dirs.push(dir);
  return join(dir, "registry.json");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dto(id: string, version: string, hostApi = "^2.0"): PluginDescriptorDTO {
  return {
    id,
    version,
    kind: "widget",
    title: `${id} ${version}`,
    icon: "clock.svg",
    capabilities: ["timer.read"],
    hostApi,
    unsupported: false,
  };
}

describe("Registry", () => {
  it("uploading a second version does NOT change activeVersion", () => {
    const r = new Registry(registryPath());
    r.add(dto("clock", "1.2.0"));
    r.add(dto("clock", "2.0.0"));
    expect(r.activeVersion("clock")).toBe("1.2.0");

    r.setActive("clock", "2.0.0");
    expect(r.activeVersion("clock")).toBe("2.0.0");

    r.setActive("clock", "1.2.0"); // rollback
    expect(r.activeVersion("clock")).toBe("1.2.0");
  });

  it("survives restart via registry.json", () => {
    const path = registryPath();
    const r = new Registry(path);
    r.add(dto("clock", "1.0.0"));
    r.save();
    expect(new Registry(path).list()).toHaveLength(1);
    expect(new Registry(path).activeVersion("clock")).toBe("1.0.0");
  });

  it("persists all versions and the activeVersion of every id", () => {
    const path = registryPath();
    const r = new Registry(path);
    r.add(dto("clock", "1.0.0"));
    r.add(dto("notes", "3.0.0"));
    r.add(dto("clock", "2.0.0"));
    r.setActive("clock", "2.0.0");
    r.save();

    const restored = new Registry(path);
    expect(restored.list().map((v) => `${v.id}@${v.version}`)).toEqual([
      "clock@1.0.0",
      "notes@3.0.0",
      "clock@2.0.0",
    ]);
    expect(restored.activeVersion("clock")).toBe("2.0.0");
    expect(restored.activeVersion("notes")).toBe("3.0.0");
  });

  it("setActive rejects an uninstalled version and leaves activeVersion alone", () => {
    const r = new Registry(registryPath());
    r.add(dto("clock", "1.0.0"));
    expect(() => r.setActive("clock", "9.9.9")).toThrow(/not installed/);
    expect(() => r.setActive("missing", "1.0.0")).toThrow(/not installed/);
    expect(r.activeVersion("clock")).toBe("1.0.0");
  });

  it("setActive rejects a version that fails the hostAPI gate", () => {
    const r = new Registry(registryPath());
    r.add(dto("clock", "2.0.0"));
    r.add(dto("clock", "1.0.0", "^1.4")); // deprecated major with sunset
    expect(() => r.setActive("clock", "1.0.0")).toThrow(/hostAPI/);
    expect(r.activeVersion("clock")).toBe("2.0.0");
  });

  it("activeVersion throws for an unknown plugin", () => {
    const r = new Registry(registryPath());
    expect(() => r.activeVersion("missing")).toThrow(/missing/);
  });

  it("markUnsupported flags the version and persists", () => {
    const path = registryPath();
    const r = new Registry(path);
    r.add(dto("clock", "1.0.0"));
    r.add(dto("clock", "2.0.0"));
    r.setActive("clock", "2.0.0");
    r.markUnsupported("clock", "1.0.0");

    const restored = new Registry(path);
    expect(restored.list().find((v) => v.version === "1.0.0")?.unsupported).toBe(true);
    expect(restored.list().find((v) => v.version === "2.0.0")?.unsupported).toBe(false);
    expect(restored.activeVersion("clock")).toBe("2.0.0");
  });

  it("markUnsupported rejects an uninstalled version", () => {
    const r = new Registry(registryPath());
    expect(() => r.markUnsupported("clock", "1.0.0")).toThrow(/not installed/);
  });

  it("list returns defensive copies", () => {
    const r = new Registry(registryPath());
    r.add(dto("clock", "1.0.0"));
    const listed = r.list();
    listed[0]!.title = "hacked";
    listed[0]!.capabilities.push("timer.write");
    listed.push(dto("extra", "1.0.0"));
    expect(r.list()).toEqual([dto("clock", "1.0.0")]);
  });

  it("starts empty when registry.json is absent or corrupt", () => {
    expect(new Registry(registryPath()).list()).toEqual([]);

    const path = registryPath();
    writeFileSync(path, "{ not json");
    expect(new Registry(path).list()).toEqual([]);
  });
});
