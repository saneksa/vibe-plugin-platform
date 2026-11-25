# Plugin Platform Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить эталонную плагинную платформу: версионированный пакет контрактов (`contracts/`) и отдельное демо (`demo/`), где недоверенные TS-виджеты и приложения грузятся архивом, живут в изолированных iframe на BSP-холсте, вызывают `hostAPI` через RPC, обновляются по версиям и доказывают изоляцию conformance-тестами.

**Architecture:** Два независимых репозитория без workspace: `@vibe/plugin-contracts` (protocol, manifest, sdk, host-core, cli, conformance, templates) и `demo` (бэкенд на двух origin, тонкий хост на чистом TS, примеры плагинов). `contracts/` не импортирует ничего из `demo/`; будущая основная система реализует только `HostAdapter`. Изоляция — iframe с отдельным origin `:4001`, `host-core` содержит переносимый security-critical рантайм (`MessageRouter` + `FrameHost` + `HostState`), политики версий — экспортируемый `compatibility.json`.

**Tech Stack:** TypeScript 5.x, Node 20+, npm с `file:`-линковкой (без workspaces), Vitest (unit/conformance-core), Playwright (browser rig + e2e), Vite (сборка хоста и плагинов), Express (бэкенд), `fflate` (unzip), `crypto.randomUUID` (iid). Хост без UI-фреймворка; примеры — ванильный TS, React, Vue.

**Spec:** `docs/superpowers/specs/2026-11-25-plugin-platform-design.md`

## Global Constraints

- Два независимых git-репозитория: `contracts/` и `demo/`; `demo/package.json` → `"@vibe/plugin-contracts": "file:../contracts"`, каждый `examples/*` → `file:../../contracts`. Никакого npm-workspace. `docs/` лежит в корне сессии и в репозитории не коммитится.
- `contracts/` **не содержит ни одного импорта из `demo/`** (проверяется скриптом `scripts/check-boundary.mjs` в T1). Экспорты: `./protocol`, `./manifest`, `./sdk`, `./host-core`, `./conformance`, `./cli`, `./compatibility.json`; `bin: { "vibe-plugin": "cli/index.mjs" }`.
- Код из архива **недоверенный**. iframe: `sandbox="allow-scripts allow-same-origin allow-forms"`, без `allow-top-navigation`, `allow-popups`, `allow-pointer-lock`. Хост `:4000`, статика плагинов `:4001` — **разные origin**. Проверка каждого сообщения: `origin === handle.expectedOrigin` И `source === iframe.contentWindow` И `iid` совпадает.
- `api` в wire = **только мажор** (`"1"` / `"2"`). Миноры = добавляемые `caps`. `rpc.api` = эхо `hello.api`; `hostVersion` — только диагностика. Поля `api` в URL фрейма **нет**, только `iid` и `route`.
- `hello` формируется SDK из `window.__VIBE_BOOT__`, который `pack` инжектирует в `index.html` из `manifest.json`.
- `activeVersion` — источник истины на бэкенде в `registry.json`; `PUT /api/plugins/:id/active` для обновления и отката; загрузка архива не переключает версию автоматически.
- На холсте для каждого `pluginId` активна **одна** версия. Обновление in-place: тот же `iid`, та же позиция в BSP, `storage` по `pluginId + iid` **без версии**.
- `manifest.schema: 1`; `hostApi` — semver-диапазон мажора; gate при установке → `409` с actionable-текстом.
- Приложения — не листья BSP; `host.instances.v1` хранит `iid → (pluginId, kind, route)`, deep-link `/app/<iid>/<path>`.
- `HostAdapter` синхронный для `getMeta()` (читает сбандленную политику), асинхронный только `getActiveVersions()`. Prefetch перед handshake нет.
- `connect-src 'none'` в CSP `:4001` по умолчанию; таймаут RPC 5 с; лимит экземпляров.
- TS→JS собирает **автор плагина до упаковки**; бэкенд никогда не компилирует чужой код.
- Не-цели: авторизация, БД, подпись кода, публикация в npm, SSR, миграция схем данных.
- Одна команда `npm run dev` из `demo/` поднимает всё. Тесты: `npx vitest run <путь>` из корня соответствующего пакета; браузерные: `npx playwright test <путь>`.

## Review Focus

| Вход / условие, которое легко упустить | Ожидаемое поведение | Где закреплено тестом |
|---|---|---|
| Zip с именем файла `../../evil.js` или абсолютным путём | Отклонён **до распаковки**, структурированная ошибка; ничего не записано на диск | T14, Step 1 |
| Манифест `hostApi: "^1"` после `sunset` | `409` с текстом «плагин собран под hostAPI 1, хост поддерживает 2; соберите с @vibe/plugin-contracts ≥ 2.0» | T3 + T14 |
| Плагин шлёт `rpc.api` = `ready.api` (`"2"`) вместо `hello.api` (`"1"`) | `selectAdapter` всё равно выбирает `v1` по `hello.api`; конверт проходит через `adapters/v1.ts` | T6 + T10 |
| Reload по `/app/<iid>/<path>`, когда `activeVersion` на бэкенде уже другая, а кэш листа старый | `HostState.reconcile()` возвращает `iid` на пересоздание; фрейм поднят с новой версией, `route` сохранён | T5 + T17 |
| Два архива одного `id` загружены подряд | `activeVersion` **не изменился**, пока не вызван `PUT` | T13 |

---

## Карта файлов

```
contracts/
  package.json, tsconfig.json, vitest.config.ts, compatibility.json, README.md
  scripts/check-boundary.mjs, scripts/boundary.test.ts
  src/protocol/{envelope,major,policy,caps,index}.ts
  src/manifest/{schema,hostApi,validate,index}.ts
  src/host-core/{types,MessageRouter,FrameHost,FrameManager,HostState,instances,layout,upgrade,registry,index}.ts
  src/host-core/adapters/v1.ts
  src/sdk/{boot,host,createPlugin,router,index}.ts
  conformance/{core,rig,fakes,staticServer,index}.ts
  conformance/fixtures/{adapter.ts,hostile-plugin/**}
  cli/{index.mjs,create.mjs,pack.mjs,check.mjs}
  templates/plugin/**  (tsconfig.json, vite.config.ts, src/main.ts, index.html, manifest.json, scripts/pack.mjs)
demo/
  package.json, tsconfig.json, vitest.config.ts, playwright.config.ts, README.md
  server/{index,registry,upload,routes,static}.ts
  host/{index.html,main.ts,DemoHostAdapter.ts,Shell.ts,Canvas.ts,AppLauncher.ts,RegistryClient.ts,styles.css}
  examples/_template/**, examples/clock-ts/**, examples/clock-react/**, examples/clock-vue/**,
  examples/notes-app/**, examples/hostile-widget/**
  tests/{conformance.test.ts,e2e.spec.ts}
  docs/integration.md
```

---

### Task 1: Скелет двух репозиториев и экспорты контрактов

**Files:**
- Create: `contracts/package.json`, `contracts/tsconfig.json`, `contracts/vitest.config.ts`, `contracts/compatibility.json`, `contracts/scripts/check-boundary.mjs`, `contracts/.gitignore`, `contracts/README.md`
- Create: `demo/package.json`, `demo/tsconfig.json`, `demo/vitest.config.ts`, `demo/playwright.config.ts`, `demo/.gitignore`
- Test: `contracts/scripts/boundary.test.ts`

**Interfaces:**
- Produces: `@vibe/plugin-contracts/{protocol,manifest,sdk,host-core,conformance,cli,compatibility.json}`; `bin.vibe-plugin`; `CompatibilityPolicy` JSON из T2.

- [ ] **Step 1: Написать падающий тест** (`contracts/scripts/boundary.test.ts`)

```ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
it("contracts has zero imports from demo", () => {
  const files = readdirSync("src", { recursive: true }) as string[];
  for (const f of files.filter(f => f.endsWith(".ts"))) {
    expect(readFileSync(`src/${f}`, "utf8")).not.toMatch(/from ["'].*demo\//);
  }
});
it("exports every required subpath", () => {
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  expect(Object.keys(p.exports).sort()).toEqual([
    "./cli", "./compatibility.json", "./conformance", "./host-core",
    "./manifest", "./protocol", "./sdk",
  ].sort());
  expect(p.bin["vibe-plugin"]).toBeTruthy();
});
```

- [ ] **Step 2: Прогнать тест, убедиться в падении** — `cd contracts && npx vitest run scripts/boundary.test.ts`. Ожидается FAIL: нет `package.json`/`src`.

- [ ] **Step 3: Создать файлы** — `git init` в `contracts/` и `demo/`; `contracts/package.json` с `exports` на `src/*` (via `dist/*` после `tsc`), `bin`, `type: module`, devDeps: `typescript`, `vitest`, `fflate`; `demo/package.json` с `"@vibe/plugin-contracts": "file:../contracts"`, devDeps `vite`, `vitest`, `@playwright/test`, `express`, `fflate`. `compatibility.json` ровно по §9 спеки: `{"current":2,"supported":["2","1"],"deprecated":{"1":{"sunset":"host@3.0.0","adapter":"adapters/v1.ts"}},"matrix":{"sdk@1.4":"protocol@1","sdk@2.1":"protocol@2"}}`. `tsconfig.json`: `strict: true`, `target: ES2022`, `module: NodeNext`. `vitest.config.ts`: `environment: "node"`. `.gitignore`: `.superpowers/`, `node_modules/`, `dist/`, `storage/`. `scripts/check-boundary.mjs` — CLI-обёртка над тем же правилом. Заглушки `src/*/index.ts` с `export {}`.

- [ ] **Step 4: Прогнать тест, убедиться в прохождении** — `cd contracts && npx vitest run scripts/boundary.test.ts`. Ожидается PASS.

- [ ] **Step 5: Commit** — в обоих репозиториях: `git add -A && git commit -m "chore: scaffold contracts and demo repos"`.

---

### Task 2: Протокол — конверты, мажоры, политика, caps

**Files:**
- Create: `contracts/src/protocol/{envelope,major,policy,caps}.ts`, `contracts/src/protocol/index.ts`
- Test: `contracts/src/protocol/protocol.test.ts`

**Interfaces:**
- Consumes: `compatibility.json` (T1).
- Produces: `Envelope`, `encodeEnvelope(e: Envelope): string`, `decodeEnvelope(raw: unknown): Envelope`; `majorOf(api: string): string`; `selectAdapter(api: string, policy: CompatibilityPolicy): "current"|"v1"|"reject"`; `getPolicy(): CompatibilityPolicy` (sync); `getMeta(policy): HostMeta`; `CAPS_CATALOGUE: string[]`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("api carries major only and rpc echoes hello.api", () => {
  expect(majorOf("2")).toBe("2");
  expect(() => majorOf("2.4")).toThrow();
  const hello = { type:"hello", iid:"i7", api:"1", sdk:"1.4.0", plugin:{id:"a",version:"1.0"}, wants:[] };
  expect(selectAdapter(hello.api, getPolicy())).toBe("v1");
  expect(selectAdapter("3", getPolicy())).toBe("reject");
});
it("round-trips every envelope variant", () => {
  const e = { type:"ready", iid:"i7", api:"2", caps:["theme.read"], deprecated:["1"], sunset:"host@3.0.0", hostVersion:"2.4.0" };
  expect(decodeEnvelope(encodeEnvelope(e as Envelope))).toEqual(e);
});
it("getPolicy is synchronous and matches the exported json", () => {
  expect(getPolicy().supported).toEqual(["2","1"]);
  expect(getMeta(getPolicy()).supportedMajors).toEqual(["2","1"]);
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/protocol/protocol.test.ts` → FAIL (модулей нет).
- [ ] **Step 3:** Реализовать точные сигнатуры выше. `Envelope` — побуквенно по §8.2 спеки (включая `hostVersion?` в `ready`). `decodeEnvelope` бросает на неизвестном `type`/отсутствии `iid`. `getPolicy()` читает `compatibility.json` через статический import (JSON сбандлен, без сети). `CAPS_CATALOGUE` = `["context.read","theme.read","notify","navigate","storage.read","storage.write","log","events.read","registry.read"]`.
- [ ] **Step 4:** `cd contracts && npx vitest run src/protocol/protocol.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(protocol): envelopes, major semantics, exported version policy"`.

---

### Task 3: Манифест — схема, gate, валидация архива

**Files:**
- Create: `contracts/src/manifest/{schema,hostApi,validate}.ts`, `contracts/src/manifest/index.ts`
- Test: `contracts/src/manifest/manifest.test.ts`

**Interfaces:**
- Consumes: `getPolicy(): CompatibilityPolicy` (T2).
- Produces: `PluginManifest`, `validateManifest(input: unknown): {ok:true;manifest:PluginManifest}|{ok:false;errors:string[]}`, `checkHostApiGate(hostApi: string, policy: CompatibilityPolicy): {ok:true}|{ok:false;message:string}`, `computeChecksums(files: Map<string,Uint8Array>): Record<string,string>`, `verifyArchiveNames(names: string[]): string[]` (список нарушений path traversal).

- [ ] **Step 1: Написать падающий тест**

```ts
it("valid manifest passes", () => {
  expect(validateManifest(validManifest).ok).toBe(true);
});
it("rejects missing entry and bad semver", () => {
  expect(validateManifest({...validManifest, entry: undefined}).ok).toBe(false);
  expect(validateManifest({...validManifest, version: "nope"}).ok).toBe(false);
});
it("gate produces the exact actionable message", () => {
  const r = checkHostApiGate("^1", getPolicy());
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("соберите с @vibe/plugin-contracts ≥ 2.0");
});
it("catches zip-slip", () => {
  expect(verifyArchiveNames(["dist/a.js", "../../evil.js", "/abs/x.js"])).toHaveLength(2);
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/manifest/manifest.test.ts` → FAIL.
- [ ] **Step 3:** `PluginManifest` — все поля §8.1; `schema: 1`; `kind` `widget|app`; `routes` обязательны при `kind: "app"`. Валидатор: JSON Schema (手写 проверка или `ajv` — оставить на исполнителя), обязательные поля, semver, `hostApi` — диапазон мажора, `capabilities ⊆ CAPS_CATALOGUE`. `checkHostApiGate` сравнивает мажор диапазона с `policy.supported` и `policy.deprecated[maj].sunset`; текст ошибки — точная строка из §9. `computeChecksums` — sha256 (node:crypto) по каждому файлу. `verifyArchiveNames` запрещает `..`, абсолютные пути, backslash-пути.
- [ ] **Step 4:** `cd contracts && npx vitest run src/manifest/manifest.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(manifest): schema, hostApi gate, archive validation"`.

---

### Task 4: BSP-дерево раскладки

**Files:**
- Create: `contracts/src/host-core/layout.ts`
- Test: `contracts/src/host-core/layout.test.ts`

**Interfaces:**
- Produces: `LayoutNode` (§8.6), `insert(root: LayoutNode|null, pluginId: string, version: string, iid: string): LayoutNode`, `remove(root, iid): LayoutNode|null`, `resize(root, path: string, ratio: number): LayoutNode`, `setVersion(root, pluginId, version): LayoutNode`, `serialize(root): string`, `restore(raw): LayoutNode|null`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("insert splits the largest leaf and setVersion keeps iid and position", () => {
  let root = insert(null, "a", "1.0.0", "i1");
  root = insert(root, "b", "1.0.0", "i2");
  expect(root.type).toBe("split");
  const r2 = setVersion(root, "a", "2.0.0");
  expect(findLeaf(r2, "i1")?.version).toBe("2.0.0");
  expect(findLeaf(r2, "i1")?.iid).toBe("i1");
});
it("remove collapses the split", () => {
  expect(remove(insert(insert(null,"a","1","i1"),"b","1","i2"), "i2")?.type).toBe("leaf");
});
it("serialize/restore round-trips", () => {
  const root = insert(insert(null,"a","1","i1"),"b","1","i2");
  expect(restore(serialize(root))).toEqual(root);
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/host-core/layout.test.ts` → FAIL.
- [ ] **Step 3:** Чистые функции, без DOM. `insert` делит лист наибольшей площади, ось чередуется по соотношению сторон; `ratio` по умолчанию `0.5`. `remove` схлопывает родительский сплит. `setVersion` меняет `version` только в листьях с данным `pluginId`, не трогая `iid` и структуру. `serialize/restore` — JSON с валидацией формы.
- [ ] **Step 4:** `cd contracts && npx vitest run src/host-core/layout.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host-core): BSP layout pure functions"`.

---

### Task 5: Реестр экземпляров и HostState

**Files:**
- Create: `contracts/src/host-core/{instances,HostState}.ts`
- Test: `contracts/src/host-core/state.test.ts`

**Interfaces:**
- Consumes: `LayoutNode`, `insert/remove/setVersion/serialize/restore` (T4); `getPolicy` (T2) — не нужен, но `HostState` принимает `activeVersions`.
- Produces: `InstanceRecord`, `InstanceRegistry`, `KeyValueStore {getItem(k):string|null; setItem(k,v):void}`, `class HostState { constructor(store: KeyValueStore); addWidget(pluginId,version): InstanceRecord; removeWidget(iid): void; resize(path,ratio): void; openApp(pluginId,version,route?): InstanceRecord; closeApp(): void; setVersion(pluginId,version): void; getLayout(): LayoutNode|null; getInstances(): InstanceRegistry; reconcile(activeVersions: Record<string,string>): string[]; restore(): void }`. `iid` = `crypto.randomUUID()`.

- [ ] **Step 1: Написать падающий тест**

```ts
const store = new MemoryStore();
it("createInstance allocates iid and persists registry", () => {
  const st = new HostState(store);
  const r = st.addWidget("clock", "1.2.0");
  expect(r.iid).toBeTruthy();
  expect(new HostState(store).getInstances()[r.iid]).toEqual(r);
});
it("apps are not BSP leaves", () => {
  const st = new HostState(store); st.addWidget("clock","1.2.0");
  const app = st.openApp("notes","1.0.0","/list");
  expect(findLeaf(st.getLayout()!, app.iid)).toBeNull();
  expect(st.getInstances()[app.iid].kind).toBe("app");
});
it("reconcile detects stale cached version after backend change", () => {
  const st = new HostState(store); const w = st.addWidget("clock","1.2.0");
  expect(st.reconcile({ clock:"2.0.0" })).toEqual([w.iid]);
  expect(findLeaf(st.getLayout()!, w.iid)?.version).toBe("2.0.0");
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/host-core/state.test.ts` → FAIL.
- [ ] **Step 3:** `HostState` владеет `host.instances.v1` и `host.layout.v1` в инжектируемом `KeyValueStore` (в браузере — `localStorage`, в тестах — `MemoryStore`, в conformance — fakes; DOM не требуется). `addWidget` = `createInstanceRecord` + `insert`. `openApp` регистрирует `InstanceRecord` с `route`, но не добавляет лист; виджеты получают `lifecycle: suspend` через `FrameManager` (T7). `reconcile` сравнивает `activeVersions` с кэшем листьев, вызывает `setVersion` и возвращает `iid`, чьи фреймы надо пересоздать.
- [ ] **Step 4:** `cd contracts && npx vitest run src/host-core/state.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host-core): instance registry and HostState owner"`.

---

### Task 6: Типы порта и MessageRouter

**Files:**
- Create: `contracts/src/host-core/types.ts`, `contracts/src/host-core/MessageRouter.ts`
- Test: `contracts/src/host-core/router.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `selectAdapter`, `getPolicy` (T2); `HostState` (T5).
- Produces: `InstanceRef {iid; pluginId; version}`, `RpcContext extends InstanceRef {caps: string[]}`, `HostMeta`, `HostContext`, `PluginDescriptor`, `HostAdapter` ( сигнатуры из §8.5 ), `FrameSourceRef {id:string}`, `FrameHandle {iid; expectedOrigin; source; pluginId; version; caps; state}`, `class MessageRouter { constructor(deps:{adapter:HostAdapter; policy:CompatibilityPolicy; schedule:(fn:()=>void,ms:number)=>()=>void}); accept(msg:{origin;source;data;handle}):void; publish(topic,value):void; destroy(iid):void }`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("drops message with correct origin but foreign source or iid", () => {
  const r = makeRouter(); const h = handle({iid:"i7", expectedOrigin:"http://p:4001"});
  r.accept({origin:"http://p:4001", source:{id:"other"}, data:hello("i7","1"), handle:h});
  expect(fakeAdapter.dispatched).toHaveLength(0);
  r.accept({origin:"http://p:4001", source:h.source, data:hello("i8","2"), handle:h});
  expect(fakeAdapter.dispatched).toHaveLength(0);
});
it("selects v1 adapter by hello.api even if rpc.api says 2", () => {
  const r = makeRouter(); const h = handle({iid:"i1"});
  r.accept({origin:h.expectedOrigin, source:h.source, data:hello("i1","1"), handle:h});
  r.accept({origin:h.expectedOrigin, source:h.source, data:rpc("i1", 7, "2", "theme.get"), handle:h});
  expect(v1Adapter.calls).toBe(1);
});
it("rejects rpc without granted cap and times out after 5s", () => {
  const r = makeRouter(); /* cap missing */ expect(lastResult.ok).toBe(false);
  expect(lastResult.error.code).toBe("cap_denied");
  fireTimers(5000); expect(lastResult.error.code).toBe("timeout");
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/host-core/router.test.ts` → FAIL.
- [ ] **Step 3:** `MessageRouter` — чистое ядро без DOM: значения `origin/source/data` приходят уже извлечёнными. Тройная проверка; `hello` → `grantCapabilities(requested, ref)` → `ready` с `caps`, `deprecated`, `sunset`, `hostVersion`; `rpc` → `selectAdapter(rpc.api === hello.api ? hello.api : rpc.api)` (всегда по объявленному мажору из `handle`) → проверка `caps` → `adapter.dispatchRpc(method, params, ctx)` → `rpc.result`. `context.get` отвечает сам из `adapter.getContext()`, `events.on/off` и `navigate` обрабатывает сам. Таблица pending + таймаут 5 с через `deps.schedule`. `publish` рассылает `event` только подписчикам с `events.read`.
- [ ] **Step 4:** `cd contracts && npx vitest run src/host-core/router.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host-core): HostAdapter types and DOM-free MessageRouter"`.

---

### Task 7: FrameHost и публичный FrameManager

**Files:**
- Create: `contracts/src/host-core/{FrameHost,FrameManager}.ts`, `contracts/src/host-core/index.ts`
- Test: `contracts/src/host-core/manager.test.ts`

**Interfaces:**
- Consumes: `MessageRouter`, `HostAdapter`, `FrameHandle` (T6); `HostState` (T5); `getPolicy` (T2).
- Produces: `interface FrameHost { create(container: Element, url: string, sandbox: string, expectedOrigin: string): FrameHandle; destroy(h): void; onMessage(cb:(e:{origin;source;data;iid})=>void): void }`; `class DomFrameHost implements FrameHost { constructor(adapter: HostAdapter) }`; `createFrameManager(opts:{adapter:HostAdapter; frameHost?:FrameHost; state?:HostState; policy?:CompatibilityPolicy}): FrameManager`; `interface FrameManager { readonly state: HostState; createInstance(descriptor:PluginDescriptor, kind:"widget"|"app", route?:string): InstanceRecord; mount(container:Element, iid:string, route?:string): FrameHandle; unmount(iid):void; publish(topic,value):void; upgrade(pluginId,version):Promise<void>; restore():Promise<void> }`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("mount creates iframe with correct sandbox and only iid/route in URL", () => {
  const fm = createFrameManager({ adapter, frameHost: fakeFrameHost });
  const rec = fm.createInstance(descriptor("clock","2.0.0"), "widget");
  const h = fm.mount(fakeElement, rec.iid);
  expect(fakeFrameHost.lastUrl).toContain("?iid=" + rec.iid);
  expect(fakeFrameHost.lastUrl).not.toContain("api=");
  expect(fakeFrameHost.lastSandbox).toBe("allow-scripts allow-same-origin allow-forms");
});
it("upgrade preserves iid and BSP position", () => {
  const fm = createFrameManager({ adapter, frameHost }); const r = fm.createInstance(d,"widget");
  const before = findLeaf(fm.state.getLayout()!, r.iid);
  await fm.upgrade("clock","2.0.0");
  expect(findLeaf(fm.state.getLayout()!, r.iid)?.iid).toBe(before?.iid);
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/host-core/manager.test.ts` → FAIL.
- [ ] **Step 3:** URL = `adapter.getPluginFrameBase(d) + "?iid=…&route=…"` (query строит ядро). `expectedOrigin = adapter.getPluginOrigin(d)` — на каждый `FrameHandle`. `DomFrameHost` создаёт `<iframe>` внутри переданного `Element`, подписывается на `message`, мапит `event.source` → `iid`. `mount` требует существующий `iid` (иначе бросает). `upgrade` = `adapter.setActiveVersion` → `state.setVersion` → пересоздание фреймов с тем же `iid`. `restore` = `state.restore()` + `adapter.getActiveVersions()` + `state.reconcile()` + пересоздание отставших.
- [ ] **Step 4:** `cd contracts && npx vitest run src/host-core/manager.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host-core): FrameHost port and FrameManager public API"`.

---

### Task 8: Адаптер v1, upgrade и типы реестра

**Files:**
- Create: `contracts/src/host-core/adapters/v1.ts`, `contracts/src/host-core/{upgrade,registry}.ts`
- Test: `contracts/src/host-core/upgrade.test.ts`

**Interfaces:**
- Consumes: `Envelope` (T2), `HostAdapter` (T6), `HostState` (T5).
- Produces: `adaptV1Envelope(e: Envelope): Envelope`; `switchActiveVersion(adapter: HostAdapter, pluginId: string, version: string): Promise<void>`; `PluginDescriptorDTO`, `RegistrySnapshot`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("v1 envelope is adapted into current shape without losing id", () => {
  const out = adaptV1Envelope({type:"rpc", iid:"i1", id:9, api:"1", method:"theme.get"} as Envelope);
  expect(out.type).toBe("rpc"); if (out.type === "rpc") expect(out.id).toBe(9);
});
it("switchActiveVersion calls adapter and does not mutate HostState directly", async () => {
  await switchActiveVersion(adapter, "clock", "2.0.0");
  expect(adapter.setActiveVersion).toHaveBeenCalledWith("clock", "2.0.0");
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/host-core/upgrade.test.ts` → FAIL.
- [ ] **Step 3:** `adaptV1Envelope` приводит поля устаревшего конверта к текущему `Envelope` (мажор остаётся `"1"` в ответе). `switchActiveVersion` — тонкая обёртка над `HostAdapter.setActiveVersion`, без HTTP и без знания URL;其余 логика обновления в `FrameManager.upgrade`. `registry.ts` — только типы DTO/снимка, без реализации хранилища.
- [ ] **Step 4:** `cd contracts && npx vitest run src/host-core/upgrade.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host-core): v1 adapter, version switch, registry types"`.

---

### Task 9: SDK плагина

**Files:**
- Create: `contracts/src/sdk/{boot,host,createPlugin,router}.ts`, `contracts/src/sdk/index.ts`
- Test: `contracts/src/sdk/sdk.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `CAPS_CATALOGUE` (T2).
- Produces: `Boot`, `readBoot(): Boot`; `HostApi` (типизированные `context/theme/notify/navigate/storage/log/on/off/registry` + `has(cap)`); `PluginDefinition {mount(el:HTMLElement, host:HostApi): void|(()=>void); routes?: Record<string,(params:Record<string,string>)=>void>}`; `createPlugin(def: PluginDefinition): void`; `routeMatcher(routes, path)`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("hello carries declared major from __VIBE_BOOT__, not from URL", () => {
  setBoot({hostApiMajor:"1", id:"clock", version:"1.0.0", sdk:"1.4.0", capabilities:[], kind:"widget"});
  window.location.search = "?iid=i7&route=/";
  createPlugin({ mount(){} });
  expect(sent[0]).toMatchObject({type:"hello", iid:"i7", api:"1"});
});
it("pending RPC correlates by id and times out at 5s", async () => {
  const p = host.theme.get(); emit({type:"rpc.result", id:sentRpcId, ok:true, value:{mode:"dark"}});
  expect(await p).toEqual({mode:"dark"});
});
it("has() is false for ungranted cap", () => { expect(host.has("storage.write")).toBe(false); });
```

- [ ] **Step 2:** `cd contracts && npx vitest run src/sdk/sdk.test.ts` → FAIL.
- [ ] **Step 3:** `readBoot()` читает `window.__VIBE_BOOT__` (синхронно, без сети). `createPlugin` шлёт `hello` с `api = boot.hostApiMajor`, ждёт `ready`, строит `HostApi` из `ready.caps`, вызывает `mount`, обрабатывает `event`/`route`/`lifecycle`, `(host.navigate)` шлёт `navigate`. Таблица `Map<id,{resolve,reject}>` + таймаут 5 с → `error.code: "timeout"`. `routeMatcher` сопоставляет `/settings/:tab`. Тесты гоняются в `jsdom`-окружении Vitest с фейковым `window.parent.postMessage`.
- [ ] **Step 4:** `cd contracts && npx vitest run src/sdk/sdk.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(sdk): boot, typed hostApi, handshake, RPC, routing"`.

---

### Task 10: Conformance-ядро (без браузера) и фикстурный адаптер

**Files:**
- Create: `contracts/conformance/{core,fakes}.ts`, `contracts/conformance/fixtures/adapter.ts`, `contracts/conformance/index.ts`
- Test: `contracts/conformance/core.test.ts`

**Interfaces:**
- Consumes: `MessageRouter`, `FrameHost`, `HostAdapter` (T6–T7), `HostState` (T5), `adaptV1Envelope` (T8), `runCoreConformance` из этого таска.
- Produces: `interface ConformanceResult {passed:string[]; failed:{name:string;error:string}[]}`; `runCoreConformance(opts:{adapterFactory:()=>HostAdapter; frameHostFactory:()=>FrameHost; state:HostState}): ConformanceResult`; `FixtureAdapter implements HostAdapter` (in-memory storage по `pluginId+iid`, in-memory activeVersions). Точные имена кейсов в `passed`: `"envelope-roundtrip"`, `"major-gate-409"`, `"v1-adapter-in-deprecation-window"`, `"append-only-minor"`, `"upgrade-preserves-iid-layout-storage"`, `"rollback"`, `"cache-reconcile"`, `"triple-check"`, `"timeout-5s"`, `"unknown-method"`, `"cap-denied"`, `"layout-roundtrip"`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("all core cases pass against fakes", () => {
  const r = runCoreConformance({adapterFactory:()=>new FixtureAdapter(), frameHostFactory:()=>new FakeFrameHost(), state:new HostState(new MemoryStore())});
  expect(r.failed).toEqual([]);
  expect(r.passed).toContain("v1-adapter-in-deprecation-window");
});
it("storage survives upgrade (same pluginId+iid)", () => {
  /* FixtureAdapter: set under 1.2.0, upgrade to 2.0.0, get → same value */
  expect(adapter.storage.get("clock|i1|k")).toBe("v");
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run conformance/core.test.ts` → FAIL.
- [ ] **Step 3:** Набор кейсов по §13: валидация конвертов, gate мажора, `v1` адаптер в окне депрекации, append-only минор (`caps` растут), обновление версии (`iid`/раскладка/`storage` сохранены, старый фрейм уничтожен, новый handshake, `activeVersion` переключён, откат, сверка кэша), тройная проверка `iid`/`source`/`origin`, таймаут, неизвестный метод, запрет без `caps`, serialize/restore. Синтетические v1-конверты генерируются внутри harness, без legacy-плагина.
- [ ] **Step 4:** `cd contracts && npx vitest run conformance/core.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(conformance): DOM-free core suite and fixture adapter"`.

---

### Task 11: Conformance browser rig и «вредная» фикстура

**Files:**
- Create: `contracts/conformance/{rig,staticServer}.ts`, `contracts/conformance/fixtures/hostile-plugin/**`
- Test: `contracts/conformance/rig.test.ts`

**Interfaces:**
- Consumes: `runCoreConformance` (T10), `HostAdapter` (T6).
- Produces: `runConformance(opts:{adapterFactory:()=>HostAdapter; ports?:[number,number]}): Promise<ConformanceResult>`; `startTwoOrigins(ports): Promise<{hostOrigin:string; pluginOrigin:string; close():Promise<void>}>`. Имена браузерных кейсов в `passed`: `"host-dom-blocked"`, `"font-face-scoped"`, `"css-scoped"`, `"globals-isolated"`, `"crash-isolated"`, `"sibling-frame-dom-blocked"`, `"navigate-popstate"`, `"reload-restores"`.

- [ ] **Step 1: Написать падающий тест (Playwright)**

```ts
it("hostile plugin cannot touch host DOM, fonts or sibling frame", async () => {
  const res = await runConformance({ adapterFactory: () => new FixtureAdapter() });
  expect(res.failed).toEqual([]);
  expect(res.passed).toContain("sibling-frame-dom-blocked");
  expect(res.passed).toContain("font-face-scoped");
});
```

- [ ] **Step 2:** `cd contracts && npx playwright test conformance/rig.test.ts` → FAIL (сервер/фикстуры отсутствуют).
- [ ] **Step 3:** `staticServer.ts` — встроенный HTTP-сервер на `node:http` (dev-зависимость только внутри `conformance`, без external packages), поднимает **два разных origin** на localhost и раздаёт предсобранные `fixtures/hostile-plugin/`. `hostile-plugin` делает 7 попыток из §13 (включая `parent.frames`). `runConformance` = `runCoreConformance` + браузерные проверки изоляции DOM/CSS/`@font-face`/глобалов/падений, round-trip `navigate ↔ popstate`, восстановление после reload. `event.origin` проверяем, поэтому `srcdoc`/opaque-origin недопустим.
- [ ] **Step 4:** `cd contracts && npx playwright test conformance/rig.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(conformance): two-origin browser rig and hostile fixture"`.

---

### Task 12: CLI и шаблон плагина

**Files:**
- Create: `contracts/cli/{index,create,pack,check}.mjs`, `contracts/templates/plugin/**`
- Test: `contracts/cli/cli.test.ts`

**Interfaces:**
- Consumes: `validateManifest`, `checkHostApiGate`, `computeChecksums`, `verifyArchiveNames` (T3), `getPolicy` (T2).
- Produces: `pack(cwd:string): Promise<string>` (путь к zip), `create(targetDir:string): Promise<void>`, `check(zipPath:string): Promise<{ok:boolean;errors:string[]}>`, `injectBoot(indexHtml:string, manifest:PluginManifest): string`; бинарник `vibe-plugin` с подкомандами `create|pack|check`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("injectBoot adds __VIBE_BOOT__ with declared major", () => {
  const html = injectBoot("<html><body></body></html>", {...validManifest, hostApi:"^1"});
  expect(html).toContain('window.__VIBE_BOOT__');
  expect(html).toContain('"hostApiMajor":"1"');
});
it("pack produces zip with manifest, checksums.json and built bundle", async () => {
  const zip = await pack(tmpPluginDir);
  expect(namesInZip(zip)).toEqual(expect.arrayContaining(["manifest.json","checksums.json","index.html","dist/bundle.js"]));
});
it("check rejects archive with bad hostApi", async () => {
  const r = await check(badZip); expect(r.ok).toBe(false);
});
```

- [ ] **Step 2:** `cd contracts && npx vitest run cli/cli.test.ts` → FAIL.
- [ ] **Step 3:** `templates/plugin/` — канонический шаблон (`tsconfig.json`, `vite.config.ts`, `src/main.ts` с `createPlugin`, `index.html`, `manifest.json`, `scripts/pack.mjs`). `create` копирует шаблон. `pack` запускает `npm run build` плагина (сборщик на усмотрение исполнителя), инжектирует `__VIBE_BOOT__` в `index.html`, считает `checksums.json` (sha256 каждого файла, кроме самого `checksums.json`), зипует через `fflate`. CLI не тянет собственный сборщик. `check` = `validateManifest` + gate + `verifyArchiveNames` + сверка контрольных сумм; ошибки — человекочитаемые.
- [ ] **Step 4:** `cd contracts && npx vitest run cli/cli.test.ts` → PASS; additionally `cd demo/examples/clock-ts && npx vibe-plugin check dist/*.zip` → `ok`.
- [ ] **Step 5:** `git add -A && git commit -m "feat(cli): create/pack/check and canonical plugin template"`.

---

### Task 13: Бэкенд — реестр и activeVersion

**Files:**
- Create: `demo/server/registry.ts`
- Test: `demo/server/registry.test.ts`

**Interfaces:**
- Consumes: `PluginDescriptorDTO` (T8), `getPolicy` (T2).
- Produces: `class Registry { constructor(path:string); add(dto:PluginDescriptorDTO):void; list():PluginDescriptorDTO[]; activeVersion(id:string):string; setActive(id:string, version:string):void; markUnsupported(id,version):void; save():void }`; `registry.json` на диске.

- [ ] **Step 1: Написать падающий тест**

```ts
it("uploading a second version does NOT change activeVersion", () => {
  const r = new Registry(tmp);
  r.add(dto("clock","1.2.0")); r.add(dto("clock","2.0.0"));
  expect(r.activeVersion("clock")).toBe("1.2.0");
  r.setActive("clock","2.0.0");
  expect(r.activeVersion("clock")).toBe("2.0.0");
  r.setActive("clock","1.2.0"); // rollback
  expect(r.activeVersion("clock")).toBe("1.2.0");
});
it("survives restart via registry.json", () => {
  const r = new Registry(tmp); r.add(dto("clock","1.0.0")); r.save();
  expect(new Registry(tmp).list()).toHaveLength(1);
});
```

- [ ] **Step 2:** `cd demo && npx vitest run server/registry.test.ts` → FAIL.
- [ ] **Step 3:** `registry.json` хранит все версии и `activeVersion` на каждый `id`. `setActive` проверяет, что версия установлена и совместима (`checkHostApiGate` по `getPolicy()`), иначе бросает. `add` не трогает `activeVersion` (первая версия становится активной). `markUnsupported` выставляет флаг по `sunset`.
- [ ] **Step 4:** `cd demo && npx vitest run server/registry.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(server): persistent registry with backend-authoritative activeVersion"`.

---

### Task 14: Бэкенд — загрузка архива и gate

**Files:**
- Create: `demo/server/upload.ts`
- Test: `demo/server/upload.test.ts`

**Interfaces:**
- Consumes: `validateManifest`, `checkHostApiGate`, `computeChecksums`, `verifyArchiveNames` (T3), `Registry` (T13), `getPolicy` (T2).
- Produces: `handleUpload(zip: Uint8Array, registry: Registry, destDir: string): Promise<{status:number; body:{code?:string;message?:string;descriptor?:PluginDescriptorDTO}}>`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("rejects zip-slip BEFORE extracting anything", async () => {
  const r = await handleUpload(zipWith("../../evil.js"), reg, tmp);
  expect(r.status).toBe(400);
  expect(fs.existsSync(path.join(tmp,"../evil.js"))).toBe(false);
});
it("returns 409 with actionable text for unsupported major", async () => {
  const r = await handleUpload(zipWith(manifest({hostApi:"^1"})), reg, tmp);
  expect(r.status).toBe(409);
  expect(r.body.message).toContain("соберите с @vibe/plugin-contracts ≥ 2.0");
});
it("extracts valid archive into <id>/<version>/", async () => {
  expect((await handleUpload(zipWith(valid), reg, tmp)).status).toBe(201);
  expect(fs.existsSync(path.join(tmp,"com.example.clock/1.2.0/index.html"))).toBe(true);
});
```

- [ ] **Step 2:** `cd demo && npx vitest run server/upload.test.ts` → FAIL.
- [ ] **Step 3:** Распаковка `fflate.unzipSync`. Порядок: лимит размера → `verifyArchiveNames` → `validateManifest` → `checkHostApiGate` → сверка `checksums.json` → только потом запись на диск в `destDir/<id>/<version>/`. Ошибка — `{status, body:{code,message}}` с текстом из спеки. `registry.add(dto)` после успеха.
- [ ] **Step 4:** `cd demo && npx vitest run server/upload.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(server): validated archive upload with semver gate"`.

---

### Task 15: Бэкенд — HTTP-роуты, два origin, CSP

**Files:**
- Create: `demo/server/{index,routes,static}.ts`
- Test: `demo/server/routes.test.ts`

**Interfaces:**
- Consumes: `Registry` (T13), `handleUpload` (T14), `getPolicy`/`getMeta` (T2).
- Produces: `createServer(opts:{portHost:number; portPlugins:number; registry:Registry}): Promise<{close():Promise<void>}>`; endpoints `POST /api/plugins`, `GET /api/plugins`, `GET /api/meta`, `PUT /api/plugins/:id/active`, `DELETE /api/plugins/:id/:version`, `:4000` хост, `:4001/plugins/**` статика.

- [ ] **Step 1: Написать падающий тест**

```ts
it("PUT /active switches version and GET /api/plugins reports it", async () => {
  const s = await createServer({portHost:0, portPlugins:0, registry:reg});
  const res = await put(`/api/plugins/com.example.clock/active`, {version:"2.0.0"});
  expect(res.status).toBe(200);
  expect((await getJSON("/api/plugins")).activeVersion["com.example.clock"]).toBe("2.0.0");
  await s.close();
});
it("plugin origin sends restrictive CSP and is a different origin", async () => {
  expect(res.headers["content-security-policy"]).toContain("connect-src 'none'");
  expect(res.headers["frame-ancestors"]).toBeTruthy();
});
```

- [ ] **Step 2:** `cd demo && npx vitest run server/routes.test.ts` → FAIL.
- [ ] **Step 3:** Express на двух `http` listener'ах. `/api/meta` импортирует политику из `@vibe/plugin-contracts/compatibility.json` (копии нет). Заголовки статики `:4001` ровно по §10: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors http://localhost:4000`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`. Порты по умолчанию `4000`/`4001`.
- [ ] **Step 4:** `cd demo && npx vitest run server/routes.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(server): two-origin HTTP API and plugin static CSP"`.

---

### Task 16: DemoHostAdapter — единственная реализация порта

**Files:**
- Create: `demo/host/DemoHostAdapter.ts`
- Test: `demo/host/DemoHostAdapter.test.ts`

**Interfaces:**
- Consumes: `HostAdapter`, `InstanceRef`, `RpcContext`, `HostMeta`, `HostContext` (T6), `getMeta` (T2), `RegistryClient` (T17).
- Produces: `interface DemoAdapterConfig {pluginOrigin:string; frameBase:(d:{id:string;version:string})=>string; registry:RegistryClient; store:KeyValueStore; hostVersion:string}`; `class DemoHostAdapter implements HostAdapter { constructor(cfg: DemoAdapterConfig) }`.

- [ ] **Step 1: Написать падающий тест**

```ts
it("storage is keyed by pluginId+iid and survives version change", async () => {
  await a.dispatchRpc("storage.set", {key:"k", value:"v"}, ctx({iid:"i1",pluginId:"clock",version:"1.2.0",caps:["storage.write"]}));
  const got = await a.dispatchRpc("storage.get", {key:"k"}, ctx({iid:"i1",pluginId:"clock",version:"2.0.0",caps:["storage.read"]}));
  expect(got).toBe("v");
});
it("getMeta is sync and comes from the exported policy", () => {
  expect(a.getMeta().supportedMajors).toEqual(["2","1"]);
});
it("getPluginOrigin is per-descriptor", () => {
  expect(a.getPluginOrigin({id:"clock",version:"1.2.0"})).toBe("http://localhost:4001");
});
```

- [ ] **Step 2:** `cd demo && npx vitest run host/DemoHostAdapter.test.ts` → FAIL.
- [ ] **Step 3:** Один класс на прод и conformance. `getMeta()` синхронно из `getMeta(getPolicy())`; `getActiveVersions()`/`setActiveVersion()` → `GET /api/plugins` / `PUT /api/plugins/:id/active` через `RegistryClient`; `dispatchRpc` исполняет `theme.get`, `storage.*`, `notify.show`, `host.log`, `registry.list`; `grantCapabilities` = пересечение запрошенного с `CAPS_CATALOGUE`; `onNavigate` → `history.pushState("/app/<iid>/<path>")`. Конфиг инжектируется, поэтому в conformance подменяются origin/порты и in-memory сторы.
- [ ] **Step 4:** `cd demo && npx vitest run host/DemoHostAdapter.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host): configurable DemoHostAdapter implementing the port"`.

---

### Task 17: Хост — UI, холст, лаунчер, роутинг

**Files:**
- Create: `demo/host/{index.html,main.ts,Shell.ts,Canvas.ts,AppLauncher.ts,RegistryClient.ts,styles.css}`
- Test: `demo/host/host.test.ts`

**Interfaces:**
- Consumes: `createFrameManager` (T7), `DemoHostAdapter` (T16), `HostState.getLayout()` (T5).
- Produces: `RegistryClient {list():Promise<PluginDescriptorDTO[]>; meta():Promise<HostMeta>; setActive(id,version):Promise<void>; upload(file:File):Promise<{ok:boolean;message?:string}>}`; `Canvas.render(root: LayoutNode|null, mount:(iid)=>void): void`; `AppLauncher.open(pluginId, route?)`; `boot(): FrameManager` из `main.ts`.

- [ ] **Step 1: Написать падающий тест (jsdom)**

```ts
it("adding widgets builds a BSP tree and each pane mounts a frame", () => {
  const fm = boot(); clickAdd("clock"); clickAdd("clock"); clickAdd("notes");
  expect(document.querySelectorAll("iframe")).toHaveLength(3);
  expect(fm.state.getLayout()!.type).toBe("split");
});
it("deep-link /app/<iid>/<path> resolves iid from registry and passes route", () => {
  history.pushState(null,"","/app/i7/settings/general");
  boot(); expect(lastFrameUrl).toContain("route=/settings/general");
});
it("back/forward sends route message to the app frame", () => {
  /* popstate → FrameManager → postMessage {type:"route", path} */
  expect(lastMessage.type).toBe("route");
});
```

- [ ] **Step 2:** `cd demo && npx vitest run host/host.test.ts` → FAIL.
- [ ] **Step 3:** `main.ts`: `new DemoHostAdapter(cfg)` → `createFrameManager({adapter})` → `fm.restore()` → `Canvas.render(fm.state.getLayout())`. `Shell` — шапка (загрузка zip, «+ виджет», лаунчер приложений, тема, «доступно обновление» → `registry.setActive`). `Canvas` — только рендерер `getLayout()` + DOM-контейнеры для `mount`, разделители → `HostState.resize`, добавление → `HostState.addWidget`. `AppLauncher` — fullscreen по `InstanceRecord`, виджеты `lifecycle: suspend`/`resume`. Роутер: `navigate` → `/app/<iid>/<path>`, `popstate` → `route` во фрейм, deep-link → `iid` из `host.instances.v1` + `activeVersion` с бэкенда.
- [ ] **Step 4:** `cd demo && npx vitest run host/host.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(host): canvas, shell, app launcher and virtual routing"`.

---

### Task 18: Прогон conformance реальным адаптером

**Files:**
- Create: `demo/tests/conformance.test.ts`
- Test: сам файл является тестом

**Interfaces:**
- Consumes: `runConformance` (T11), `DemoHostAdapter` (T16), `getPolicy` (T2).

- [ ] **Step 1: Написать падающий тест**

```ts
it("demo's real HostAdapter passes the portable conformance harness", async () => {
  const res = await runConformance({
    adapterFactory: () => new DemoHostAdapter({
      pluginOrigin: rig.pluginOrigin,
      frameBase: d => `${rig.pluginOrigin}/plugins/${d.id}/${d.version}/index.html`,
      registry: inMemoryRegistryClient, store: new MemoryStore(), hostVersion: "2.4.0",
    }),
  });
  expect(res.failed).toEqual([]);
});
```

- [ ] **Step 2:** `cd demo && npx playwright test tests/conformance.test.ts` → FAIL (нет файла/связки).
- [ ] **Step 3:** Один класс адаптера, три конфигурации: серверы демо не поднимаются, `rig` подставляет свои origin/порты, `RegistryClient` и `KeyValueStore` — in-memory. Зафиксировать, что `demo/tests` передаёт именно реальный `DemoHostAdapter`.
- [ ] **Step 4:** `cd demo && npx playwright test tests/conformance.test.ts` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "test(demo): wire real adapter into portable conformance harness"`.

---

### Task 19: Примеры плагинов

**Files:**
- Create: `demo/examples/_template/**`, `demo/examples/clock-ts/**` (v1.2.0 и v2.0.0), `demo/examples/clock-react/**`, `demo/examples/clock-vue/**`, `demo/examples/notes-app/**`, `demo/examples/hostile-widget/**`
- Test: `demo/examples/examples.test.ts`

**Interfaces:**
- Consumes: `@vibe/plugin-contracts/sdk` (T9), `@vibe/plugin-contracts/cli` (T12).

- [ ] **Step 1: Написать падающий тест**

```ts
it("every example packs a valid self-contained archive", async () => {
  for (const dir of exampleDirs) {
    const zip = await pack(dir);
    expect(await check(zip)).toMatchObject({ok:true});
    expect(namesInZip(zip)).toContain("dist/bundle.js");
    expect(indexHtmlOf(zip)).toContain("__VIBE_BOOT__");
  }
});
it("clock-ts ships 1.2.0 and 2.0.0 with the same id", () => {
  expect(manifestOf("1.2.0").id).toBe(manifestOf("2.0.0").id);
  expect(manifestOf("2.0.0").hostApi).toBe("^2");
});
it("three frameworks use the same sdk", () => {
  for (const d of ["clock-ts","clock-react","clock-vue"])
    expect(pkgOf(d).dependencies["@vibe/plugin-contracts"]).toBeTruthy();
});
```

- [ ] **Step 2:** `cd demo && npx vitest run examples/examples.test.ts` → FAIL.
- [ ] **Step 3:** Каждый пример — `manifest.json`, `src/main.ts` с `createPlugin`, `index.html`, `vite.config.ts`, `package.json` с `file:../../contracts`. `clock-ts` в двух версиях (1.2.0 пишет данные в `storage`, 2.0.0 — обновлённый рендер). `clock-react`/`clock-vue` монтируют свой фреймворк в `el` от SDK. `notes-app` — `kind: "app"`, `routes: ["/", "/list", "/settings/:tab"]`, использует `storage.*` и `navigate`. `hostile-widget` — тонкая обёртка над фикстурой `contracts/conformance/fixtures/hostile-plugin`.
- [ ] **Step 4:** `cd demo && npx vitest run examples/examples.test.ts` → PASS; `npm run examples:pack` создаёт zip для всех.
- [ ] **Step 5:** `git add -A && git commit -m "feat(examples): framework-agnostic widgets, routed app, hostile fixture"`.

---

### Task 20: E2E, документация переноса и финальная проверка

**Files:**
- Create: `demo/tests/e2e.spec.ts`, `demo/docs/integration.md`, `demo/README.md`, `demo/package.json` (scripts `dev`, `examples:pack`, `test`)
- Test: `demo/tests/e2e.spec.ts`

**Interfaces:**
- Consumes: всё из T1–T19.

- [ ] **Step 1: Написать падающий e2e по §16**

```ts
test("full scenario", async ({page}) => {
  await upload("clock-ts@1.2.0.zip"); await addWidget("clock"); await addWidget("clock");
  await writeWidgetData("k","v");
  await upload("clock-ts@2.0.0.zip"); await click("Обновить");
  await expect(page.locator("text=2.0.0")).toBeVisible();
  await expect(getWidgetData("k")).resolves.toBe("v");       // iid + storage сохранены
  await expect(getLayoutSnapshot()).resolves.toEqual(before); // позиция BSP сохранена
  await click("Откатить"); await expect(page.locator("text=1.2.0")).toBeVisible();
  await openApp("notes-app"); await navigate("/settings/general");
  await page.goBack(); await expect(url()).toContain("/app/");
  await page.reload(); await expect(layoutRestored()).toBe(true);
  await addWidget("hostile-widget"); await expect(hostStillAlive()).toBe(true);
});
```

- [ ] **Step 2:** `cd demo && npx playwright test tests/e2e.spec.ts` → FAIL.
- [ ] **Step 3:** `integration.md` — пошаговая реализация `HostAdapter` в основной системе (включая `getPluginOrigin(descriptor)`, `getPluginFrameBase`, активные версии, `getMeta` из экспортированной политики), подключение `host-core`/`MessageRouter`/`HostState`, прогон `conformance`. `README.md` — путь «create → pack → upload → плитка» и целевое время < 15 мин. `package.json` scripts: `dev` (одна команда поднимает `:4000`, `:4001` и бэкенд), `examples:pack`, `test` (vitest + playwright).
- [ ] **Step 4:** Финальная проверка: `cd demo && npm run dev` (одна команда), `npm test` — все unit, conformance-core, conformance-rig, e2e зелёные; `cd contracts && node scripts/check-boundary.mjs` — ноль импортов из `demo/`; `npx vibe-plugin check` на каждом архиве — `ok`. Ожидается PASS везде.
- [ ] **Step 5:** `git add -A && git commit -m "docs+test: e2e scenario, integration guide, one-command dev"` (в `demo/`), затем `cd contracts && git add -A && git commit -m "chore: final boundary check"`.

---

## Self-Review notes

- **Spec coverage:** §1–§19 закрыты задачами T1–T20; не-цели §2 нигде не реализуются; §15 (delegate) зафиксирован в Global Constraints как конкретный выбор стека.
- **Step scan:** у каждого шага ровно одно проверяемое действие; тела функций не выписаны, кроме точных строк из спеки (текст `409`, sandbox-флаги, CSP, `compatibility.json`).
- **Type consistency:** `HostAdapter`/`RpcContext`/`FrameManager`/`HostState`/`InstanceRecord` определены один раз (T5–T7) и используются с теми же именами во всех последующих задачах.
- **Review Focus:** все пять классов входов закреплены тестами в T3, T5, T6, T13, T14, T17 (таблица выше).
- **Proportion:** 20 задач на ~660-строчный спец; план короче спека и не содержит полных тел программы.
