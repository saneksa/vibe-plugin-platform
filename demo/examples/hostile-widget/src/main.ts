/**
 * hostile-widget: the §13 attacks are visible in the widget itself, so the
 * host's isolation can be verified by eye as well as by the conformance rig.
 */
import { createPlugin } from "@vibe/plugin-contracts/sdk";
import { runAttacks, type AttackReport } from "./attacks";

/** How a probe's outcome reads: stopped by the host, contained here, or a leak. */
function stateOf(value: string | boolean): string {
  if (value === "blocked") return "blocked";
  if (value === true) return "true";
  if (value === "ALLOWED") return "allowed";
  return "neutral";
}

createPlugin({
  mount(el, host) {
    el.classList.add("hostile-widget");

    const heading = document.createElement("h2");
    heading.textContent = "hostile-widget (§13)";
    const hint = document.createElement("p");
    hint.textContent = "Every attempt below stays inside this frame.";
    const list = document.createElement("ul");
    const note = document.createElement("div");
    note.className = "hostile-note";
    note.textContent =
      "The red around this card is the widget's own global CSS reaching its <body>. The host did not change.";
    el.append(heading, hint, list, note);

    const render = (report: AttackReport): void => {
      list.replaceChildren();
      for (const [name, value] of Object.entries(report)) {
        const row = document.createElement("li");
        row.dataset.state = stateOf(value);
        const key = document.createElement("span");
        key.className = "probe-name";
        // The colon belongs to the name visually; the space keeps the row's
        // text reading `name: value` (the e2e scenario matches on it).
        key.textContent = `${name}:`;
        const result = document.createElement("span");
        result.className = "probe-value";
        result.textContent = String(value);
        row.append(key, document.createTextNode(" "), result);
        list.append(row);
      }
    };

    const dispose = runAttacks(host, render);
    return () => {
      dispose();
      el.replaceChildren();
    };
  },
});
