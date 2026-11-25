/**
 * Prebuilt hostile plugin fixture (spec §13). Deliberately attacks directly —
 * it does not use the SDK. Every attempt is recorded and reported to the host
 * via postMessage; an uncaught exception is thrown after the final report.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var iid = params.get("iid") || "i-hostile";
  var route = params.get("route") || "/";

  var report = {
    iid: iid,
    route: route,
    parentDocument: "unknown",
    parentStorage: "unknown",
    ownGlobalChanged: false,
    ownFetchChanged: false,
    fontRegistered: false,
    globalCssApplied: false,
    rpcSent: false,
    forgedSent: false,
    siblingDom: "unknown",
    routes: [],
    crashed: false
  };

  function post(type, extra) {
    var payload = { __rig: true, type: type, iid: iid };
    if (extra) {
      Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
    }
    window.parent.postMessage(payload, "*");
  }

  function fontFamilyOf(face) {
    return String(face.family).replace(/["']/g, "");
  }

  function audit() {
    // Attempt 1: host document and host localStorage.
    try {
      report.parentDocument = window.parent.document ? "ALLOWED" : "empty";
    } catch (e) {
      report.parentDocument = "blocked";
    }
    try {
      report.parentStorage = window.parent.localStorage ? "ALLOWED" : "empty";
    } catch (e) {
      report.parentStorage = "blocked";
    }

    // Attempt 2: overwrite globals and fetch in this realm.
    try {
      window.__VIBE_OVERRIDE__ = "hacked";
      window.fetch = function () { throw new Error("hacked fetch"); };
      report.ownGlobalChanged = window.__VIBE_OVERRIDE__ === "hacked";
      report.ownFetchChanged = String(window.fetch).indexOf("hacked") !== -1;
    } catch (e) {
      report.ownGlobalChanged = false;
      report.ownFetchChanged = false;
    }

    // Attempt 3: @font-face + global CSS from style.css.
    report.fontRegistered = Array.from(document.fonts).some(function (face) {
      return fontFamilyOf(face) === "VibeCommon";
    });
    report.globalCssApplied =
      window.getComputedStyle(document.body).backgroundColor === "rgb(255, 0, 0)";

    // Attempt 7: sibling frame DOM through parent.frames.
    try {
      var sibling = window.parent.frames[1];
      var secret = sibling.document.getElementById("sibling-secret");
      report.siblingDom = secret ? secret.textContent : "empty";
    } catch (e) {
      report.siblingDom = "blocked";
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "route" || data.iid !== iid) return;
    report.routes.push(data.path);
    post("report", { report: report });
  });

  audit();

  // Attempt 5: RPC without a granted capability. The host must not dispatch it.
  post("rpc-no-caps", { method: "theme.get" });
  report.rpcSent = true;

  // Attempt 6: forged iid (the sibling iframe forges source/iid separately).
  window.parent.postMessage(
    { __rig: true, type: "report", iid: "i-foreign", report: { forged: true } },
    "*"
  );
  report.forgedSent = true;

  post("report", { report: report });

  // Attempt 4: uncaught exception after reporting. Re-audit first so the
  // sibling frame is definitely mounted when its DOM is probed.
  window.setTimeout(function () {
    audit();
    report.crashed = true;
    post("report", { report: report });
    throw new Error("hostile widget crash");
  }, 30);

  // Rig: request a virtual route so navigate <-> popstate can be observed.
  window.setTimeout(function () {
    post("navigate", { path: "/settings/general" });
  }, 10);
})();
