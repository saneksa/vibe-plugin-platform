/**
 * Canvas = renderer only. It paints `HostState.getLayout()` into DOM panes and
 * hands out the per-leaf slots used by `FrameManager.mount`. It never owns the
 * BSP tree, allocates iids or calls the state machine directly; the host wires
 * `resize` and `mount` callbacks in from outside.
 */

import type { LayoutNode } from "@vibe/plugin-contracts/host-core";
import { icon, pluginGlyph } from "./icons.js";

export const CANVAS_ID = "vibe-canvas";

type Leaf = Extract<LayoutNode, { type: "leaf" }>;

/** Same limits as host-core's layout (MIN_RATIO / MAX_RATIO). */
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
/** Keyboard resizing: arrows move by a small step, Shift by a large one. */
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

type ResizeHandler = ((path: string, ratio: number) => void) | null;
type ContextHandler = ((iid: string, x: number, y: number) => void) | null;

/** What the header of one tile shows. */
export interface TileMeta {
  title: string;
  icon?: string;
  version: string;
}

type MetaLookup = ((leaf: Leaf) => TileMeta) | null;

let resizeHandler: ResizeHandler = null;

/** Injected by the host: dividers report `path` and the new ratio. */
export function setCanvasResizeHandler(handler: ResizeHandler): void {
  resizeHandler = handler;
}

function hostElement(): HTMLElement {
  let host = document.getElementById(CANVAS_ID);
  if (host === null) {
    host = document.createElement("div");
    host.id = CANVAS_ID;
    (document.getElementById("app") ?? document.body).appendChild(host);
  }
  return host;
}

/** The DOM container for one already-allocated instance. */
export function frameSlot(iid: string): HTMLElement | null {
  for (const slot of document.querySelectorAll<HTMLElement>(`#${CANVAS_ID} .frame-slot`)) {
    if (slot.dataset.iid === iid) return slot;
  }
  return null;
}

function pane(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

/** Host-owned title bar: identity of the widget plus the remove action. */
function tileHead(leaf: Leaf, meta: TileMeta): HTMLDivElement {
  const head = pane("widget-head");
  const symbol = document.createElement("span");
  symbol.className = "plugin-icon plugin-icon-sm";
  symbol.setAttribute("aria-hidden", "true");
  symbol.innerHTML = icon(pluginGlyph(meta.icon));
  const title = document.createElement("span");
  title.className = "widget-title";
  title.dataset.role = "title";
  title.textContent = meta.title;
  title.title = meta.title;
  const version = document.createElement("span");
  version.className = "chip chip-mono widget-version";
  version.dataset.role = "version";
  version.textContent = `v${meta.version}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "widget-remove";
  remove.dataset.removeWidget = leaf.iid;
  remove.dataset.iid = leaf.iid;
  remove.title = "Удалить виджет";
  remove.setAttribute("aria-label", "Удалить виджет");
  remove.innerHTML = icon("close", 14);
  head.append(symbol, title, version, remove);
  return head;
}

function renderSplit(
  node: Extract<LayoutNode, { type: "split" }>,
  path: string,
  container: HTMLElement,
  mount: (iid: string) => void,
  onContext: ContextHandler,
  metaOf: MetaLookup,
): void {
  const split = pane("pane split");
  split.dataset.path = path;
  split.style.display = "flex";
  const horizontal = node.axis === "h";
  split.style.flexDirection = horizontal ? "row" : "column";

  const a = pane("branch branch-a");
  a.dataset.branch = "a";
  const b = pane("branch branch-b");
  b.dataset.branch = "b";

  const divider = pane("divider");
  divider.dataset.path = path;
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", "Разделитель панелей");
  // ARIA names a separator by its own shape: a vertical line divides panes
  // that sit side by side.
  divider.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
  divider.setAttribute("aria-valuemin", String(MIN_RATIO * 100));
  divider.setAttribute("aria-valuemax", String(MAX_RATIO * 100));

  const paint = (ratio: number): void => {
    a.style.flex = `${ratio} 1 0%`;
    b.style.flex = `${1 - ratio} 1 0%`;
    const percent = Math.round(ratio * 100);
    divider.setAttribute("aria-valuenow", String(percent));
    divider.setAttribute("aria-valuetext", `${percent}%`);
  };
  const setRatio = (next: number): void => {
    const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, next));
    // Four decimals keep keyboard steps exact (0.52 - 0.1 is otherwise 0.42000…4).
    const ratio = Math.round(clamped * 10_000) / 10_000;
    paint(ratio);
    resizeHandler?.(path, ratio);
  };
  paint(Math.min(MAX_RATIO, Math.max(MIN_RATIO, node.ratio)));

  divider.addEventListener("pointerdown", (event: MouseEvent) => {
    // Keep pointermove/pointerup flowing to this listener even when the cursor
    // crosses a plugin iframe; otherwise a stale drag handler survives and
    // silently changes the layout on the next click.
    if (typeof divider.setPointerCapture === "function") {
      const pointerId = (event as PointerEvent).pointerId;
      if (pointerId !== undefined) {
        try {
          divider.setPointerCapture(pointerId);
        } catch {
          // Older DOM shims have no capture support; the drag still works.
        }
      }
    }
    const rect = split.getBoundingClientRect();
    const size = horizontal ? rect.width : rect.height;
    if (size <= 0) return;
    const origin = horizontal ? rect.left : rect.top;
    const at = (position: number): number => (position - origin) / size;

    divider.dataset.active = "";
    setRatio(at(horizontal ? event.clientX : event.clientY));
    const move = (e: MouseEvent): void => setRatio(at(horizontal ? e.clientX : e.clientY));
    const stop = (): void => {
      delete divider.dataset.active;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });

  divider.addEventListener("keydown", (event: KeyboardEvent) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    event.preventDefault();
    // The tree node is a render-time snapshot; the branches hold the live ratio.
    const current = Number.parseFloat(a.style.flex) || node.ratio;
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    setRatio(current + (forward ? step : -step));
  });

  container.appendChild(split);
  split.append(a, divider, b);
  renderNode(node.a, `${path}a`, a, mount, onContext, metaOf);
  renderNode(node.b, `${path}b`, b, mount, onContext, metaOf);
}

function renderNode(
  node: LayoutNode,
  path: string,
  container: HTMLElement,
  mount: (iid: string) => void,
  onContext: ContextHandler,
  metaOf: MetaLookup,
): void {
  if (node.type === "leaf") {
    const leaf = pane("pane leaf");
    leaf.dataset.iid = node.iid;
    if (onContext !== null) {
      leaf.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        onContext(node.iid, event.clientX, event.clientY);
      });
    }
    const slot = pane("frame-slot");
    slot.dataset.iid = node.iid;
    const loading = pane("widget-loading");
    loading.innerHTML =
      '<div class="skeleton w-40"></div><div class="skeleton tall"></div><div class="skeleton w-70"></div>';
    slot.append(tileHead(node, metaOf?.(node) ?? { title: node.pluginId, version: node.version }), loading);
    leaf.appendChild(slot);
    container.appendChild(leaf);
    mount(node.iid);
    return;
  }

  renderSplit(node, path, container, mount, onContext, metaOf);
}

export const Canvas = {
  render(
    root: LayoutNode | null,
    mount: (iid: string) => void,
    onContext: ContextHandler = null,
    metaOf: MetaLookup = null,
  ): void {
    const host = hostElement();
    host.replaceChildren();
    host.classList.toggle("empty", root === null);
    if (root !== null) renderNode(root, "", host, mount, onContext, metaOf);
  },
};
