/**
 * The one DOM-aware port of host-core (spec §8.5). `FrameManager` owns all
 * instance metadata and builds URLs; this module only creates/removes iframes
 * and turns already-extracted `MessageEvent` values into router input.
 */

import type { FrameHandle, FrameSourceRef, HostAdapter } from "./types.js";

export interface FrameHostMessage {
  origin: string;
  source: FrameSourceRef;
  data: unknown;
  iid: string;
}

export interface FrameHost {
  create(container: Element, url: string, sandbox: string, expectedOrigin: string): FrameHandle;
  destroy(handle: FrameHandle): void;
  onMessage(cb: (e: FrameHostMessage) => void): void;
}

/** A real contentWindow is structurally a source plus `postMessage`. */
class WindowSource implements FrameSourceRef {
  constructor(
    readonly id: string,
    private readonly iframe: HTMLIFrameElement,
  ) {}

  postMessage(data: string, targetOrigin: string): void {
    const win = this.iframe.contentWindow;
    if (win === null) throw new TypeError("frame has no contentWindow");
    win.postMessage(data, targetOrigin);
  }
}

type Mounted = {
  iframe: HTMLIFrameElement;
  source: WindowSource;
  handle: FrameHandle;
};

export class DomFrameHost implements FrameHost {
  private readonly mounted = new Map<string, Mounted>();
  private callback: ((e: FrameHostMessage) => void) | null = null;

  // The adapter is part of the port contract: the manager asks it for frame
  // bases and origins, so this implementation needs no backend calls of its own.
  constructor(private readonly adapter: HostAdapter) {}

  create(container: Element, url: string, sandbox: string, expectedOrigin: string): FrameHandle {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", sandbox);
    iframe.setAttribute("src", url);
    container.appendChild(iframe);

    const iid = new URL(url, "http://localhost").searchParams.get("iid") ?? "";
    const source = new WindowSource(iid, iframe);
    const handle: FrameHandle = {
      iid,
      expectedOrigin,
      source,
      pluginId: "",
      version: "",
      caps: [],
      state: "handshake",
    };
    this.mounted.set(iid, { iframe, source, handle });
    return handle;
  }

  destroy(handle: FrameHandle): void {
    const mounted = this.mounted.get(handle.iid);
    if (mounted === undefined || mounted.handle !== handle) return;
    mounted.iframe.remove();
    this.mounted.delete(handle.iid);
  }

  onMessage(cb: (e: FrameHostMessage) => void): void {
    this.callback = cb;
    window.addEventListener("message", (event: MessageEvent) => {
      if (this.callback === null) return;
      for (const entry of this.mounted.values()) {
        if (entry.iframe.contentWindow !== event.source) continue;
        this.callback({
          origin: event.origin,
          source: entry.source,
          data: event.data,
          iid: entry.handle.iid,
        });
        return;
      }
    });
  }
}
