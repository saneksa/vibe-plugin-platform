/**
 * Pure BSP layout tree operations (§8.6). No DOM, no state, no randomness:
 * callers supply the `iid`, and every operation returns a new tree.
 *
 * Geometry convention shared with the renderer: `axis: "h"` places `a` and `b`
 * side by side (the ratio divides the width), `axis: "v"` stacks them (the
 * ratio divides the height). The root occupies a 1×1 rectangle.
 */
export type LayoutNode =
  | { type: "leaf"; iid: string; pluginId: string; version: string }
  | {
      type: "split";
      axis: "h" | "v";
      ratio: number;
      a: LayoutNode;
      b: LayoutNode;
    };

type Leaf = Extract<LayoutNode, { type: "leaf" }>;
type Rect = { w: number; h: number };

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
const DEFAULT_RATIO = 0.5;

function childRects(axis: "h" | "v", ratio: number, rect: Rect): [Rect, Rect] {
  return axis === "h"
    ? [
        { w: rect.w * ratio, h: rect.h },
        { w: rect.w * (1 - ratio), h: rect.h },
      ]
    : [
        { w: rect.w, h: rect.h * ratio },
        { w: rect.w, h: rect.h * (1 - ratio) },
      ];
}

/** Largest leaf by area; ties go to the first (`a`) branch for determinism. */
function largestLeaf(node: LayoutNode, rect: Rect): { path: string; rect: Rect } {
  if (node.type === "leaf") return { path: "", rect };

  const [aRect, bRect] = childRects(node.axis, node.ratio, rect);
  const a = largestLeaf(node.a, aRect);
  const b = largestLeaf(node.b, bRect);
  const area = (r: Rect) => r.w * r.h;

  return area(b.rect) > area(a.rect)
    ? { path: `b${b.path}`, rect: b.rect }
    : { path: `a${a.path}`, rect: a.rect };
}

function insertAt(
  node: LayoutNode,
  path: string,
  fresh: Leaf,
  axis: "h" | "v",
): LayoutNode {
  if (path === "") {
    return { type: "split", axis, ratio: DEFAULT_RATIO, a: node, b: fresh };
  }
  if (node.type !== "split") return node;

  const rest = path.slice(1);
  if (path[0] === "a") return { ...node, a: insertAt(node.a, rest, fresh, axis) };
  if (path[0] === "b") return { ...node, b: insertAt(node.b, rest, fresh, axis) };
  return node;
}

export function insert(
  root: LayoutNode | null,
  pluginId: string,
  version: string,
  iid: string,
): LayoutNode {
  const fresh: Leaf = { type: "leaf", iid, pluginId, version };
  if (root === null) return fresh;

  const { path, rect } = largestLeaf(root, { w: 1, h: 1 });
  // Split along the longer side so the two children stay as square as possible.
  const axis = rect.w >= rect.h ? "h" : "v";
  return insertAt(root, path, fresh, axis);
}

/** Removing a leaf replaces its parent split with the surviving sibling. */
export function remove(root: LayoutNode, iid: string): LayoutNode | null {
  if (root.type === "leaf") return root.iid === iid ? null : root;

  const a = remove(root.a, iid);
  if (a === null) return root.b;
  if (a !== root.a) return { ...root, a };

  const b = remove(root.b, iid);
  if (b === null) return root.a;
  if (b !== root.b) return { ...root, b };

  return root;
}

function clampRatio(ratio: number): number | null {
  if (!Number.isFinite(ratio)) return null;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** `path` is a sequence of `a`/`b` branch keys; "" addresses the root split. */
export function resize(root: LayoutNode, path: string, ratio: number): LayoutNode {
  const clamped = clampRatio(ratio);
  if (clamped === null) return root;
  if (path === "") return root.type === "split" ? { ...root, ratio: clamped } : root;
  if (root.type !== "split") return root;

  const rest = path.slice(1);
  if (path[0] === "a") {
    const a = resize(root.a, rest, clamped);
    return a === root.a ? root : { ...root, a };
  }
  if (path[0] === "b") {
    const b = resize(root.b, rest, clamped);
    return b === root.b ? root : { ...root, b };
  }
  return root;
}

/** Updates only the version cache of matching leaves; iid and structure stay put. */
export function setVersion(
  root: LayoutNode,
  pluginId: string,
  version: string,
): LayoutNode {
  if (root.type === "leaf") {
    return root.pluginId === pluginId ? { ...root, version } : root;
  }

  const a = setVersion(root.a, pluginId, version);
  const b = setVersion(root.b, pluginId, version);
  return a === root.a && b === root.b ? root : { ...root, a, b };
}

export function serialize(root: LayoutNode): string {
  return JSON.stringify(root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates shape while normalizing away any extra fields. */
function normalize(value: unknown): LayoutNode | null {
  if (!isRecord(value)) return null;

  if (value.type === "leaf") {
    if (
      typeof value.iid !== "string" ||
      typeof value.pluginId !== "string" ||
      typeof value.version !== "string"
    ) {
      return null;
    }
    return {
      type: "leaf",
      iid: value.iid,
      pluginId: value.pluginId,
      version: value.version,
    };
  }

  if (value.type === "split") {
    if (value.axis !== "h" && value.axis !== "v") return null;
    if (
      typeof value.ratio !== "number" ||
      !Number.isFinite(value.ratio) ||
      value.ratio <= 0 ||
      value.ratio >= 1
    ) {
      return null;
    }
    const a = normalize(value.a);
    if (a === null) return null;
    const b = normalize(value.b);
    if (b === null) return null;
    return { type: "split", axis: value.axis, ratio: value.ratio, a, b };
  }

  return null;
}

export function restore(raw: string | null | undefined): LayoutNode | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalize(parsed);
}
