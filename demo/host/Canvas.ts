/**
 * Canvas = renderer only. It paints `HostState.getLayout()` into DOM panes and
 * hands out the per-leaf slots used by `FrameManager.mount`. It never owns the
 * BSP tree, allocates iids or calls the state machine directly; the host wires
 * `resize` and `mount` callbacks in from outside.
 */

import type { LayoutNode } from "@vibe/plugin-contracts/host-core";

export const CANVAS_ID = "vibe-canvas";

type ResizeHandler = ((path: string, ratio: number) => void) | null;
type ContextHandler = ((iid: string, x: number, y: number) => void) | null;

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

function renderNode(
  node: LayoutNode,
  path: string,
  container: HTMLElement,
  mount: (iid: string) => void,
  onContext: ContextHandler,
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
    leaf.appendChild(slot);
    container.appendChild(leaf);
    mount(node.iid);
    return;
  }

  const split = pane("pane split");
  split.dataset.path = path;
  split.style.display = "flex";
  split.style.flexDirection = node.axis === "h" ? "row" : "column";

  const a = pane("branch branch-a");
  a.dataset.branch = "a";
  a.style.flex = `${node.ratio} 1 0%`;
  const b = pane("branch branch-b");
  b.dataset.branch = "b";
  b.style.flex = `${1 - node.ratio} 1 0%`;

  const divider = pane("divider");
  divider.dataset.path = path;
  divider.setAttribute("role", "separator");
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
    const horizontal = node.axis === "h";
    const size = horizontal ? rect.width : rect.height;
    if (size <= 0) return;
    const origin = horizontal ? rect.left : rect.top;

    const apply = (position: number): void => {
      const raw = (position - origin) / size;
      const ratio = Math.min(0.9, Math.max(0.1, raw));
      a.style.flex = `${ratio} 1 0%`;
      b.style.flex = `${1 - ratio} 1 0%`;
      resizeHandler?.(path, ratio);
    };

    apply(horizontal ? event.clientX : event.clientY);
    const move = (e: MouseEvent): void => apply(horizontal ? e.clientX : e.clientY);
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });

  container.appendChild(split);
  split.append(a, divider, b);
  renderNode(node.a, `${path}a`, a, mount, onContext);
  renderNode(node.b, `${path}b`, b, mount, onContext);
}

export const Canvas = {
  render(root: LayoutNode | null, mount: (iid: string) => void, onContext: ContextHandler = null): void {
    const host = hostElement();
    host.replaceChildren();
    host.classList.toggle("empty", root === null);
    if (root !== null) renderNode(root, "", host, mount, onContext);
  },
};
