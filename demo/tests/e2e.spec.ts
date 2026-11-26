/**
 * Task 20: the mandated §16 live scenario, driven entirely through the real
 * host UI. The only direct API call is the single `GET /api/plugins` assertion
 * that the backend's `activeVersion` really switched.
 *
 * The Playwright `webServer` config packs the examples and starts the demo
 * (`npm run dev` — both origins in one command) before this file runs.
 */
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const archive = (name: string): string =>
  fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

const CLOCK_V1 = archive("clock-ts-1.2.0/dist/clock-1.2.0.zip");
const CLOCK_V2 = archive("clock-ts/dist/clock-2.0.0.zip");
const NOTES = archive("notes-app/dist/notes-app-1.0.0.zip");
const HOSTILE = archive("hostile-widget/dist/hostile-widget-1.0.0.zip");

function widgetFrame(page: Page, iid: string): FrameLocator {
  return page.frameLocator(`iframe[src*="iid=${iid}"]`);
}

/** DOM-level layout snapshot: instance ids plus every splitter's geometry. */
function layoutSnapshot(page: Page): Promise<unknown> {
  return page.locator("#vibe-canvas").evaluate((root) => ({
    iids: [...root.querySelectorAll<HTMLElement>(".frame-slot")].map((el) => el.dataset.iid),
    splits: [...root.querySelectorAll<HTMLElement>(".pane.split")].map((el) => ({
      path: el.dataset.path,
      axis: el.style.flexDirection,
      a: el.querySelector<HTMLElement>(".branch-a")?.style.flex,
      b: el.querySelector<HTMLElement>(".branch-b")?.style.flex,
    })),
  }));
}

test("§16 full scenario: upload → two widgets → upgrade → rollback → resize → app routing → reload → hostile", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  async function upload(path: string, expectedButton?: string): Promise<void> {
    await page.locator("input[data-upload]").setInputFiles(path);
    await expect(page.locator("[data-upload-status]")).toHaveText("загружено");
    // A successful upload refreshes the shell in place (spec §11). The caller
    // may name a registry-derived button that must appear before any reload.
    if (expectedButton !== undefined) await expect(page.locator(expectedButton)).toBeVisible();
  }

  async function addWidget(pluginId: string, expectedCount: number): Promise<void> {
    await expect(page.locator(`[data-add-widget="${pluginId}"]`)).toBeVisible();
    await page.locator(`[data-add-widget="${pluginId}"]`).click();
    await expect(page.locator("#vibe-canvas .frame-slot")).toHaveCount(expectedCount);
  }

  async function widgetData(iid: string): Promise<string> {
    return widgetFrame(page, iid).locator('input[aria-label="note"]').inputValue();
  }

  await page.goto("/");
  await expect(page.locator(".brand")).toBeVisible();

  // 1. Upload clock 1.2.0. The test server starts with a clean registry;
  //    this branch is a guard for an unexpectedly pre-populated one.
  await upload(CLOCK_V1);
  const rollback = page.locator('[data-rollback="clock"]');
  if ((await rollback.count()) > 0) {
    await rollback.click();
    await expect(page.locator('[data-upgrade="clock"]')).toBeVisible();
  }

  // 2. Add two instances of the same plugin id.
  await addWidget("clock", 1);
  await addWidget("clock", 2);
  const iids = await page
    .locator("#vibe-canvas .frame-slot")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.iid!));
  expect(iids[0]).not.toBe(iids[1]);
  for (const iid of iids) {
    await expect(widgetFrame(page, iid).locator(".clock-version")).toHaveText("clock 1.2.0");
  }

  // 3. Write widget data through the plugin's own storage-backed input.
  for (const iid of iids) {
    const input = widgetFrame(page, iid).locator('input[aria-label="note"]');
    await input.fill("v");
    await input.press("Tab"); // blur → change → host.storage.set
    await expect(widgetFrame(page, iid).locator(".clock-saved")).toHaveText("saved: v");
  }
  const before = await layoutSnapshot(page);

  // 4. Upload the new version: «доступно обновление» must appear BEFORE any
  //    reload, then the switch happens via that button.
  await upload(CLOCK_V2, '[data-upgrade="clock"]');
  await page.locator('[data-upgrade="clock"]').click();
  await expect(page.locator('[data-upgrade="clock"]')).toHaveCount(0);
  for (const iid of iids) {
    await expect(widgetFrame(page, iid).locator(".clock-version")).toHaveText("clock 2.0.0");
    expect(await widgetData(iid)).toBe("v");
  }
  expect(await layoutSnapshot(page)).toEqual(before);

  // The one permitted direct API assertion: the backend owns activeVersion.
  const snapshot = await (await request.get("/api/plugins")).json();
  expect(snapshot.activeVersion.clock).toBe("2.0.0");

  // 5. Roll back with «Откатить», then upgrade again ("and back").
  await page.locator('[data-rollback="clock"]').click();
  await expect(page.locator('[data-rollback="clock"]')).toHaveCount(0);
  for (const iid of iids) {
    await expect(widgetFrame(page, iid).locator(".clock-version")).toHaveText("clock 1.2.0");
    expect(await widgetData(iid)).toBe("v");
  }
  expect(await layoutSnapshot(page)).toEqual(before);
  await page.locator('[data-upgrade="clock"]').click();
  await expect(page.locator('[data-upgrade="clock"]')).toHaveCount(0);
  for (const iid of iids) {
    await expect(widgetFrame(page, iid).locator(".clock-version")).toHaveText("clock 2.0.0");
  }

  // 6. Resize a splitter and keep the new geometry.
  const divider = page.locator("#vibe-canvas .divider").first();
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const resized = await layoutSnapshot(page);
  expect(resized).not.toEqual(before);

  // 7. Fullscreen notes-app with virtual routing, back/forward and deep reload.
  await upload(NOTES, '[data-launch="notes-app"]');
  await page.locator('[data-launch="notes-app"]').click();
  const notes = page.frameLocator("#app-frame iframe");
  await expect(notes.locator(".notes-route")).toHaveText("route: /");
  await notes.getByRole("button", { name: "Settings" }).click();
  await expect(notes.locator(".notes-route")).toHaveText("route: /settings/:tab");
  await expect(notes.locator("p")).toHaveText("Settings tab: general");
  expect(page.url()).toContain("/settings/general");

  await page.goBack();
  expect(page.url()).toContain("/app/");
  await expect(notes.locator(".notes-route")).toHaveText("route: /");
  await page.goForward();
  expect(page.url()).toContain("/settings/general");
  await expect(notes.locator(".notes-route")).toHaveText("route: /settings/:tab");

  await page.reload();
  await expect(page.locator("#app-frame iframe")).toBeVisible();
  const appBox = await page.locator("#app-frame").boundingBox();
  const viewport = page.viewportSize();
  if (appBox === null || viewport === null) throw new Error("no app frame box");
  expect(appBox.height).toBeGreaterThan(viewport.height * 0.8);
  await expect(notes.locator(".notes-route")).toHaveText("route: /settings/:tab");
  expect(await layoutSnapshot(page)).toEqual(resized);
  await page.locator("[data-close-app]").click();
  await expect(page.locator("#vibe-canvas .frame-slot")).toHaveCount(2);
  for (const iid of iids) {
    await expect(widgetFrame(page, iid).locator(".clock-version")).toHaveText("clock 2.0.0");
  }

  // 8. A hostile widget must not take the host (or its neighbours) down.
  const beforeHostile = iids.length;
  await upload(HOSTILE, '[data-add-widget="hostile-widget"]');
  await addWidget("hostile-widget", beforeHostile + 1);
  const allIids = await page
    .locator("#vibe-canvas .frame-slot")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.iid!));
  const hostileIid = allIids.find((iid) => !iids.includes(iid))!;
  const hostile = widgetFrame(page, hostileIid);
  await expect(hostile.locator("h2")).toHaveText("hostile-widget (§13)");
  await expect(hostile.locator("li").filter({ hasText: "parentDocument: blocked" })).toBeVisible();
  await expect(hostile.locator("li").filter({ hasText: "parentStorage: blocked" })).toBeVisible();
  // Plugin↔plugin origin isolation is an explicit non-goal; all demo plugins
  // share :4001, so sibling DOM is either blocked or simply holds no secret.
  await expect(hostile.locator("li").filter({ hasText: /siblingDom: (blocked|empty)/ })).toBeVisible();
  await expect(hostile.locator("li").filter({ hasText: "crashed: true" })).toBeVisible();

  // Host still alive: shell responsive, neighbours intact.
  await page.locator("[data-theme-toggle]").click();
  await expect(page.locator("html.light")).toHaveCount(1);
  await expect(page.locator(".brand")).toBeVisible();
  for (const iid of iids) {
    await expect(widgetFrame(page, iid).locator(".clock-version")).toHaveText("clock 2.0.0");
  }
});
