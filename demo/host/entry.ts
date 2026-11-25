/** Browser entry: the host is a thin wrapper, so all it does is boot. */
import { boot } from "./main.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
} else {
  boot();
}
