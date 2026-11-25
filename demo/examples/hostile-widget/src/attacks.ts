/**
 * The seven §13 attacks, packaged as an SDK plugin. Mirrors the standalone
 * browser-rig fixture in contracts/conformance/fixtures/hostile-plugin: each
 * attempt is recorded and reported to the host with the same `__rig` shape,
 * but every attack is launched from inside `mount()` of a normal plugin.
 */
import type { HostApi } from "@vibe/plugin-contracts/sdk";

export interface AttackReport {
  parentDocument: string;
  parentStorage: string;
  ownGlobalChanged: boolean;
  ownFetchChanged: boolean;
  fontRegistered: boolean;
  globalCssApplied: boolean;
  rpcSent: boolean;
  forgedSent: boolean;
  siblingDom: string;
  crashed: boolean;
}

function post(iid: string, type: string, extra: Record<string, unknown> = {}): void {
  window.parent.postMessage({ __rig: true, type, iid, ...extra }, "*");
}

/** Runs the attacks; returns a disposer for this frame's timer and injected CSS. */
export function runAttacks(host: HostApi, onChange: (report: AttackReport) => void): () => void {
  const iid = new URLSearchParams(window.location.search).get("iid") || "i-hostile";
  const report: AttackReport = {
    parentDocument: "unknown",
    parentStorage: "unknown",
    ownGlobalChanged: false,
    ownFetchChanged: false,
    fontRegistered: false,
    globalCssApplied: false,
    rpcSent: false,
    forgedSent: false,
    siblingDom: "unknown",
    crashed: false,
  };
  const update = (): void => {
    post(iid, "report", { report: { ...report } });
    onChange({ ...report });
  };

  // 1. Host document and host localStorage must be unreachable from the frame.
  try {
    report.parentDocument = window.parent.document ? "ALLOWED" : "empty";
  } catch {
    report.parentDocument = "blocked";
  }
  try {
    report.parentStorage = window.parent.localStorage ? "ALLOWED" : "empty";
  } catch {
    report.parentStorage = "blocked";
  }

  // 2. Overwrite a global and fetch in this realm only.
  try {
    (window as Window & { __VIBE_OVERRIDE__?: string }).__VIBE_OVERRIDE__ = "hacked";
    window.fetch = (() => {
      throw new Error("hacked fetch");
    }) as typeof fetch;
    report.ownGlobalChanged =
      (window as Window & { __VIBE_OVERRIDE__?: string }).__VIBE_OVERRIDE__ === "hacked";
    report.ownFetchChanged = String(window.fetch).includes("hacked");
  } catch {
    report.ownGlobalChanged = false;
    report.ownFetchChanged = false;
  }

  // 3. A common font face and a global CSS selector, both frame-scoped.
  const style = document.createElement("style");
  style.textContent = [
    '@font-face { font-family: "VibeCommon"; src: local("Arial"); }',
    "body { background: rgb(255, 0, 0) !important; }",
    "#host-sentinel { display: none !important; color: rgb(255, 255, 255) !important; }",
  ].join("\n");
  document.head.appendChild(style);
  report.fontRegistered = Array.from(document.fonts).some(
    (face) => String(face.family).replace(/["']/g, "") === "VibeCommon",
  );
  report.globalCssApplied = window.getComputedStyle(document.body).backgroundColor === "rgb(255, 0, 0)";

  // 7. Sibling frame DOM through parent.frames.
  try {
    const sibling = window.parent.frames[1];
    const secret = sibling.document.getElementById("sibling-secret");
    report.siblingDom = secret ? secret.textContent ?? "empty" : "empty";
  } catch {
    report.siblingDom = "blocked";
  }

  // 5. Uncapped RPC: the SDK must reject registry.list (no registry.read cap),
  // and a hand-forged envelope with no capabilities must not be dispatched.
  void host.registry.list().then(
    () => {
      report.rpcSent = true;
      post(iid, "rpc-unexpectedly-granted", { method: "registry.list" });
      update();
    },
    () => {
      report.rpcSent = true;
      post(iid, "rpc-no-caps", { method: "registry.list" });
      update();
    },
  );
  post(iid, "rpc-no-caps", { method: "theme.get" });

  // 6. Spoofed source/iid in a report envelope.
  window.parent.postMessage(
    { __rig: true, type: "report", iid: "i-foreign", report: { forged: true } },
    "*",
  );
  report.forgedSent = true;
  update();

  // 4. Uncaught exception after reporting the result.
  const timer = window.setTimeout(() => {
    report.crashed = true;
    update();
    throw new Error("hostile widget crash");
  }, 30);

  return () => {
    window.clearTimeout(timer);
    style.remove();
  };
}
