/**
 * hostile-widget: the §13 attacks are visible in the widget itself, so the
 * host's isolation can be verified by eye as well as by the conformance rig.
 */
import { createPlugin } from "@vibe/plugin-contracts/sdk";
import { runAttacks, type AttackReport } from "./attacks";

createPlugin({
  mount(el, host) {
    el.classList.add("hostile-widget");

    const heading = document.createElement("h2");
    heading.textContent = "hostile-widget (§13)";
    const hint = document.createElement("p");
    hint.textContent = "Every attempt below stays inside this frame.";
    const list = document.createElement("ul");
    el.append(heading, hint, list);

    const render = (report: AttackReport): void => {
      list.replaceChildren();
      for (const [name, value] of Object.entries(report)) {
        const row = document.createElement("li");
        row.textContent = `${name}: ${String(value)}`;
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
