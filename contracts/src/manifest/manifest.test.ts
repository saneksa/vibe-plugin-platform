import { describe, expect, it } from "vitest";
import { getPolicy } from "../protocol/index.js";
import {
  checkHostApiGate,
  computeChecksums,
  validateManifest,
  verifyArchiveNames,
} from "./index.js";

const validManifest = {
  schema: 1,
  id: "com.example.clock",
  kind: "widget",
  version: "1.2.0",
  hostApi: "^2.0",
  sdk: "2.1.0",
  title: "Часы",
  icon: "assets/icon.svg",
  entry: "index.html",
  capabilities: ["context.read", "theme.read", "notify"],
  defaultSize: { w: 0.5, h: 0.5 },
  minSize: { w: 0.2, h: 0.2 },
};

describe("validateManifest", () => {
  it("valid manifest passes", () => {
    expect(validateManifest(validManifest).ok).toBe(true);
  });

  it("rejects missing entry and bad semver", () => {
    expect(validateManifest({ ...validManifest, entry: undefined }).ok).toBe(false);
    expect(validateManifest({ ...validManifest, version: "nope" }).ok).toBe(false);
  });

  it("keeps the documented plugin ids valid", () => {
    for (const id of ["com.example.clock", "clock", "notes-app", "clock-react", "hostile-widget"]) {
      expect(validateManifest({ ...validManifest, id }).ok).toBe(true);
    }
  });

  it("rejects traversal and non-segment ids (the id becomes a directory name)", () => {
    for (const id of [
      "../../etc",
      "../evil",
      "a/b",
      "a\\b",
      "a..b",
      "a b",
      ".hidden",
      "id\nmalicious",
      "/abs",
      "C:evil",
    ]) {
      const result = validateManifest({ ...validManifest, id });
      expect(result.ok, `id ${JSON.stringify(id)} must be rejected`).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("id must be a safe");
    }
  });

  it("rejects traversal in version, which is also part of the extraction path", () => {
    for (const version of ["../../evil", "1/2/3", "1\\2\\3", "1.2.3\n"]) {
      const result = validateManifest({ ...validManifest, version });
      expect(result.ok, `version ${JSON.stringify(version)} must be rejected`).toBe(false);
    }
  });

  it("rejects a wrong schema, kind, sdk version and hostApi range", () => {
    expect(validateManifest({ ...validManifest, schema: 2 }).ok).toBe(false);
    expect(validateManifest({ ...validManifest, kind: "gadget" }).ok).toBe(false);
    expect(validateManifest({ ...validManifest, sdk: "2.1" }).ok).toBe(false);
    expect(validateManifest({ ...validManifest, hostApi: ">=1" }).ok).toBe(false);
  });

  it("requires routes for apps only and validates capabilities and sizes", () => {
    expect(validateManifest({ ...validManifest, kind: "app" }).ok).toBe(false);
    expect(
      validateManifest({ ...validManifest, kind: "app", routes: ["/", "/settings/:tab"] }).ok,
    ).toBe(true);
    expect(validateManifest({ ...validManifest, routes: [] }).ok).toBe(true);
    expect(validateManifest({ ...validManifest, capabilities: ["context.read", "unknown"] }).ok).toBe(false);
    expect(validateManifest({ ...validManifest, minSize: { w: 0.2 } }).ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
  });
});

describe("checkHostApiGate", () => {
  it("gate produces the exact actionable message", () => {
    const r = checkHostApiGate("^1", getPolicy());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("соберите с @vibe/plugin-contracts ≥ 2.0");
      expect(r.message).toBe(
        "плагин собран под hostAPI 1, хост поддерживает 2; соберите с @vibe/plugin-contracts ≥ 2.0",
      );
    }
  });

  it("accepts the current major", () => {
    expect(checkHostApiGate("^2.0", getPolicy()).ok).toBe(true);
  });
});

describe("archive helpers", () => {
  it("catches zip-slip", () => {
    expect(verifyArchiveNames(["dist/a.js", "../../evil.js", "/abs/x.js"])).toHaveLength(2);
  });

  it("also rejects backslash paths and accepts clean relative paths", () => {
    expect(verifyArchiveNames(["dist\\evil.js"])).toEqual(["dist\\evil.js"]);
    expect(verifyArchiveNames(["dist/a.js", "assets/icon.svg"])).toEqual([]);
  });

  it("computes sha256 per file without writing anything", () => {
    const sums = computeChecksums(
      new Map<string, Uint8Array>([
        ["dist/a.js", new TextEncoder().encode("abc")],
        ["dist/b.js", new TextEncoder().encode("hello")],
      ]),
    );
    expect(Object.keys(sums)).toHaveLength(2);
    expect(sums["dist/a.js"]).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sums["dist/b.js"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
