import { describe, expect, it } from "vitest";
import {
  insert,
  remove,
  resize,
  restore,
  serialize,
  setVersion,
  type LayoutNode,
} from "./layout.js";

type Leaf = Extract<LayoutNode, { type: "leaf" }>;
type Split = Extract<LayoutNode, { type: "split" }>;

function leaf(iid: string, pluginId = "p", version = "1"): Leaf {
  return { type: "leaf", iid, pluginId, version };
}

function findLeaf(root: LayoutNode | null, iid: string): Leaf | null {
  if (!root) return null;
  if (root.type === "leaf") return root.iid === iid ? root : null;
  return findLeaf(root.a, iid) ?? findLeaf(root.b, iid);
}

describe("insert", () => {
  it("returns a single leaf when the tree is empty", () => {
    expect(insert(null, "a", "1.0.0", "i1")).toEqual(leaf("i1", "a", "1.0.0"));
  });

  it("splits the largest leaf and setVersion keeps iid and position", () => {
    let root = insert(null, "a", "1.0.0", "i1");
    root = insert(root, "b", "1.0.0", "i2");
    expect(root.type).toBe("split");
    const r2 = setVersion(root, "a", "2.0.0");
    expect(findLeaf(r2, "i1")?.version).toBe("2.0.0");
    expect(findLeaf(r2, "i1")?.iid).toBe("i1");
  });

  it("splits the leaf with the largest area, keeping the other branch intact", () => {
    const small = leaf("small", "s");
    const large = leaf("large", "l");
    const root: LayoutNode = {
      type: "split",
      axis: "v",
      ratio: 0.2,
      a: small,
      b: large,
    };

    const next = insert(root, "x", "1", "i3");
    expect(next.a).toBe(small);
    expect(next.b).toMatchObject({ type: "split", axis: "h", ratio: 0.5 });
    if (next.b.type === "split") expect(next.b.a).toBe(large);
    expect(findLeaf(next, "i3")).not.toBeNull();
  });

  it("alternates the split axis according to the aspect ratio", () => {
    const r2 = insert(insert(null, "a", "1", "i1"), "b", "1", "i2");
    expect(r2).toMatchObject({ type: "split", axis: "h", ratio: 0.5 });

    const r3 = insert(r2, "c", "1", "i3");
    expect(r3.a).toMatchObject({ type: "split", axis: "v", ratio: 0.5 });
  });

  it("does not mutate the previous tree", () => {
    const r1 = insert(null, "a", "1", "i1");
    insert(r1, "b", "1", "i2");
    expect(r1).toEqual(leaf("i1", "a", "1"));
  });
});

describe("remove", () => {
  it("collapses the split", () => {
    expect(
      remove(insert(insert(null, "a", "1", "i1"), "b", "1", "i2"), "i2")?.type,
    ).toBe("leaf");
  });

  it("returns null when the last leaf is removed", () => {
    expect(remove(insert(null, "a", "1", "i1"), "i1")).toBeNull();
  });

  it("collapses only the parent split of the removed leaf", () => {
    const i1 = leaf("i1");
    const i3 = leaf("i3");
    const root: LayoutNode = {
      type: "split",
      axis: "h",
      ratio: 0.5,
      a: { type: "split", axis: "v", ratio: 0.5, a: i1, b: leaf("i2") },
      b: i3,
    };

    const next = remove(root, "i2");
    expect(next?.a).toBe(i1);
    expect(next?.b).toBe(i3);
  });

  it("leaves the tree untouched for an unknown iid", () => {
    const root = insert(insert(null, "a", "1", "i1"), "b", "1", "i2");
    expect(remove(root, "missing")).toBe(root);
  });
});

describe("resize", () => {
  const root: Split = {
    type: "split",
    axis: "h",
    ratio: 0.5,
    a: { type: "split", axis: "v", ratio: 0.5, a: leaf("i1"), b: leaf("i2") },
    b: leaf("i3"),
  };

  it("resizes the split addressed by the path (empty path = root)", () => {
    expect(resize(root, "", 0.8)).toMatchObject({ ratio: 0.8 });
    expect(resize(root, "a", 0.3).a).toMatchObject({ ratio: 0.3 });
  });

  it("clamps the ratio into a sane range", () => {
    expect(resize(root, "", 5)).toMatchObject({ ratio: 0.9 });
    expect(resize(root, "", -5)).toMatchObject({ ratio: 0.1 });
    expect(resize(root, "", Number.NaN)).toBe(root);
  });

  it("ignores invalid paths and leaves of the tree unchanged", () => {
    const next = resize(root, "ax", 0.7);
    expect(next.a).toMatchObject({ ratio: 0.5 });
    expect(resize(root, "b", 0.7)).toBe(root);
    expect(root.ratio).toBe(0.5);
  });
});

describe("setVersion", () => {
  it("updates every leaf of the given plugin without touching iid or structure", () => {
    const root: LayoutNode = {
      type: "split",
      axis: "h",
      ratio: 0.5,
      a: leaf("i1", "a", "1"),
      b: { type: "split", axis: "v", ratio: 0.5, a: leaf("i2", "a", "1"), b: leaf("i3", "b", "1") },
    };

    const next = setVersion(root, "a", "2.0.0");
    expect(findLeaf(next, "i1")?.version).toBe("2.0.0");
    expect(findLeaf(next, "i2")?.version).toBe("2.0.0");
    expect(findLeaf(next, "i3")?.version).toBe("1");
    expect(JSON.stringify(next, (key, value) => (key === "version" ? undefined : value))).toBe(
      JSON.stringify(root, (key, value) => (key === "version" ? undefined : value)),
    );
    expect(findLeaf(root, "i1")?.version).toBe("1");
  });
});

describe("serialize / restore", () => {
  it("serialize/restore round-trips", () => {
    const root = insert(insert(null, "a", "1", "i1"), "b", "1", "i2");
    expect(restore(serialize(root))).toEqual(root);
    expect(JSON.parse(serialize(root))).toEqual(root);
  });

  it("returns null for empty, malformed or wrong-shaped input", () => {
    expect(restore("")).toBeNull();
    expect(restore("   ")).toBeNull();
    expect(restore(null)).toBeNull();
    expect(restore("not json")).toBeNull();
    expect(restore("null")).toBeNull();
    expect(restore('{"type":"leaf","iid":"i1"}')).toBeNull();
    expect(
      restore('{"type":"split","axis":"x","ratio":0.5,"a":{"type":"leaf","iid":"i","pluginId":"p","version":"1"},"b":{"type":"leaf","iid":"j","pluginId":"p","version":"1"}}'),
    ).toBeNull();
    expect(
      restore('{"type":"split","axis":"h","ratio":2,"a":{"type":"leaf","iid":"i","pluginId":"p","version":"1"},"b":{"type":"leaf","iid":"j","pluginId":"p","version":"1"}}'),
    ).toBeNull();
  });

  it("normalizes valid nodes to the exact LayoutNode shape", () => {
    expect(
      restore('{"type":"leaf","iid":"i1","pluginId":"a","version":"1","extra":42}'),
    ).toEqual(leaf("i1", "a", "1"));
  });
});
