/**
 * Notifications of the workspace. Host statuses go through one dedicated
 * element (`[data-upload-status]`, its text is the latest message); plugin
 * notifications stack as separate toasts below it.
 */

import { icon } from "./icons.js";

export type StatusLevel = "info" | "success" | "error";

const INFO_TTL_MS = 5000;
const MAX_STACK = 3;

function normalizeLevel(level: string): StatusLevel {
  return level === "error" ? "error" : level === "success" ? "success" : "info";
}

function levelIcon(level: StatusLevel): string {
  return icon(level === "error" ? "alert" : level === "success" ? "check" : "info");
}

function toastElement(message: string, status: boolean): HTMLDivElement {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML =
    `<span class="toast-icon" aria-hidden="true"></span>` +
    `<span class="toast-text"></span>` +
    `<button type="button" class="btn btn-sm btn-ghost toast-close" aria-label="Скрыть">${icon("close")}</button>`;
  const text = toast.querySelector<HTMLElement>(".toast-text")!;
  if (status) text.setAttribute("data-upload-status", "");
  text.textContent = message;
  toast.querySelector(".toast-close")?.addEventListener("click", () => toast.classList.add("is-hidden"));
  return toast;
}

export class Toasts {
  private readonly root: HTMLElement;
  private readonly statusBox: HTMLDivElement;
  private readonly statusIcon: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private statusTimer: number | null = null;

  constructor(root: HTMLElement) {
    root.classList.add("toasts");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Уведомления");
    root.replaceChildren();
    this.root = root;

    this.statusBox = toastElement("", true);
    this.statusBox.classList.add("toast-status", "is-hidden");
    this.statusBox.setAttribute("role", "status");
    this.statusIcon = this.statusBox.querySelector(".toast-icon")!;
    this.statusText = this.statusBox.querySelector("[data-upload-status]")!;
    // Empty and hidden until the first status arrives.
    root.append(this.statusBox);
  }

  /** The one status surface of the host, shared by upload and every UI flow. */
  showStatus(message: string, level: StatusLevel = "info"): void {
    const next = normalizeLevel(level);
    this.statusText.textContent = message;
    this.statusText.dataset.level = next;
    this.statusIcon.innerHTML = levelIcon(next);
    this.statusBox.dataset.level = next;
    this.statusBox.classList.remove("is-hidden");
    this.clearTimer();
    // Errors stay until dismissed; everything else steps aside on its own.
    if (next !== "error") {
      this.statusTimer = window.setTimeout(() => {
        this.statusBox.classList.add("is-hidden");
      }, INFO_TTL_MS);
    }
  }

  /** A notification from a plugin (`notify.show`); does not replace the status. */
  push(message: string, level: string = "info"): void {
    const next = normalizeLevel(level);
    const toast = toastElement(message, false);
    toast.dataset.level = next;
    toast.setAttribute("role", "status");
    toast.querySelector(".toast-icon")!.innerHTML = levelIcon(next);
    this.root.append(toast);
    while (this.root.children.length > MAX_STACK + 1) this.root.children[1]?.remove();
    window.setTimeout(() => toast.remove(), INFO_TTL_MS);
  }

  private clearTimer(): void {
    if (this.statusTimer === null) return;
    window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }
}
