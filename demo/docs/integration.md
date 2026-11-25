# Перенос платформы в основную систему

Документ описывает, как подключить контракты к браузерному SPA без плагинного
слоя. Демо — образец потребителя: `demo/host/DemoHostAdapter.ts` это тот же
класс, что переносится; всё остальное (изоляция, RPC, версии, состояния)
поставляется пакетом и **не переписывается**.

## 0. Требования и установка

- **Node ≥ 24.** Подпути экспортируют `.ts`-исходники, CLI использует нативную
  type stripping (`v24.8.0` проверен). Для Node 20/22 нужна отдельная сборка JS.
- `npm i @vibe/plugin-contracts@^2` (в демо — `file:../contracts`).
- `fflate` — обычная `dependency` контрактов: `pack`/`check` используют его в
  рантайме, поэтому он не должен быть devDependency у потребителя.

Пакет экспортирует: `protocol`, `manifest`, `sdk`, `host-core`, `conformance`,
`cli`, `compatibility.json`. Правило границы: **ноль импортов из демо** —
проверяется `node scripts/check-boundary.mjs` в `contracts/`.

## 1. Что уже даёт пакет, а что пишем сами

| Слой | Где | Кто отвечает |
| --- | --- | --- |
| `MessageRouter` (origin/source/iid, caps, мажоры, таймауты) | `host-core` | пакет |
| `FrameManager` + `DomFrameHost` (`iframe`, sandbox, handshake, upgrade) | `host-core` | пакет |
| `HostState` (`host.instances.v1`, `host.layout.v1`, BSP, reconcile) | `host-core` | пакет |
| `upgrade.ts` / `instances.ts` / `adapters/v1.ts` | `host-core` | пакет |
| `compatibility.json` + `protocol/policy.ts` (`getPolicy`, `getMeta`) | `protocol` | пакет |
| `runCoreConformance` / `runConformance` + фикстуры + два origin | `conformance` | пакет |
| `HostAdapter` (9 методов) и UI | потребитель | **вы** |

`FrameHost` — инжектируемый порт: если у вас уже есть собственный слой iframes,
реализуйте `create/destroy/onMessage` и передайте его в `createFrameManager`.
Потребитель **не** владеет состояниями экземпляров: `Map<iid, …>` и оба
`localStorage`-ключа принадлежат `host-core`.

## 2. Реализуем `HostAdapter` (ровно девять методов)

Импорт:

```ts
import type {
  HostAdapter, HostContext, HostMeta, InstanceRef, RpcContext,
} from "@vibe/plugin-contracts/host-core";
import { CAPS_CATALOGUE, getMeta, getPolicy } from "@vibe/plugin-contracts/protocol";
```

Полную рабочую реализацию смотрите в `demo/host/DemoHostAdapter.ts`; ниже —
смысл каждого метода и что нельзя в нём делать.

1. **`getMeta(): HostMeta`** — синхронно. Источник правды — экспортированная
   политика, копии в коде нет:

   ```ts
   getMeta(): HostMeta {
     return { ...getMeta(getPolicy()), hostVersion: HOST_VERSION };
   }
   ```

   `supportedMajors`, `deprecated`, `sunset`, `capsCatalogue` приходят из
   `@vibe/plugin-contracts/compatibility.json`; `hostVersion` — диагностика
   вашей сборки (в демо `2.4.0`). Тот же `getMeta(getPolicy())` использует
   бэкенд для gate при установке и `GET /api/meta`.

2. **`getContext(): HostContext`** — снимок `{theme, locale, user, hostVersion}`.
   Ядро отвечает из него в `ready` и на RPC `context.get`; сетевого prefetch
   перед handshake нет.

3. **`grantCapabilities(requested: string[], ref: InstanceRef): string[]`** —
   пересечение запроса плагина с вашей политикой (`CAPS_CATALOGUE` в демо).
   Ядро проверяет `caps` ещё раз перед **каждым** RPC; `host.has()` в SDK —
   только удобство автора плагина. `navigate` — отдельный cap для `kind:"app"`.

4. **`dispatchRpc(method, params, ctx: RpcContext): Promise<unknown>`** —
   исполняет `theme.get`, `storage.get/set/remove`, `notify.show`, `host.log`,
   `registry.list`. `context.get`, `events.on/off` и `navigate` ядро обрабатывает
   само, их в `dispatchRpc` не передавайте. Ключ хранилища —
   `ctx.pluginId + ctx.iid` **без версии**, поэтому данные переживают обновление.
   `ctx.pluginId`/`ctx.version` ядро разрешает через `instances.ts`; адаптер
   состояния не хранит. Неизвестный метод — ошибка с `code: "unknown_method"`.

5. **`onNavigate(iid, path, replace)`** — превращает сообщение плагина в URL
   вашего роутера и обязательно шлёт обратно `route` (§12). В демо это
   `history.pushState('/app/<iid>/<path>')` + `post({type:"route",…})`;
   `replace` должен вызывать `replaceState`. Deep-link/reload: `iid` из URL,
   `pluginId`/версию — из реестра экземпляров и активной версии.

6. **`getPluginOrigin(plugin: {id; version}): string`** — ожидаемый
   `event.origin` для `FrameHandle`. В демо всегда `http://localhost:4001`.
   Точка расширения: выдайте каждому плагину/версии отдельный origin — ядро
   не изменится, plugin↔plugin изоляция станет реальной (в демо это не-цель).

7. **`getPluginFrameBase(plugin: {id; version}): string`** — база URL фрейма
   без query. В демо `http://localhost:4001/plugins/<id>/<version>/index.html`.
   Ядро само дописывает только `?iid=…&route=…`; поля `api` в URL нет —
   мажор приходит в `hello` из `window.__VIBE_BOOT__`.

8. **`getActiveVersions(): Promise<Record<string, string>>`** — источник
   истины — бэкенд. В демо `GET /api/plugins` → `{versions, activeVersion}`.
   Асинхронность нужна только здесь и в `setActiveVersion`.

9. **`setActiveVersion(pluginId, version): Promise<void>`** — явное
   переключение версии (обновление и откат одним вызовом). В демо
   `PUT /api/plugins/:id/active` с `{version}`. Реестр проверяет, что версия
   установлена и совместима, и пишет `activeVersion` на диск; загрузка нового
   архива версию **не** переключает.

## 3. Подключаем рантайм

```ts
const adapter = new MyHostAdapter({ ... });       // один класс на все среды
const fm = createFrameManager({ adapter });        // DomFrameHost по умолчанию

const record = fm.createInstance(descriptor, "widget"); // iid + host.instances.v1
const handle = fm.mount(container, record.iid);    // container — любой Element вашего UI
await fm.upgrade(pluginId, version);               // через адаптер, без HTTP в ядре
await fm.restore();                                // сверка activeVersion с кэшем листьев
fm.publish("theme.changed", { mode: "light" });    // потребитель → ядро → подписки
fm.unmount(iid);                                   // lifecycle:destroy + удаление iframe
```

- `HostState` — единственный владелец `host.instances.v1` и `host.layout.v1`:
  `addWidget`, `removeWidget`, `resize(path, ratio)`, `openApp`, `closeApp`,
  `setVersion`, `getLayout`, `getInstances`, `reconcile`. Ваш Canvas — только
  рендерер `getLayout()` и источник DOM-контейнеров; `iid` он не выделяет.
- Приложение полноэкранное и в BSP не входит; открытие шлёт виджетам
  `lifecycle: suspend`, закрытие — `resume`. `iid` и `route` приложения живут
  в `InstanceRecord`, поэтому deep-link не содержит `pluginId` и версию.
- `iframe` создаётся с `sandbox="allow-scripts allow-same-origin allow-forms"`;
  `allow-same-origin` безопасен только потому, что origin плагина отличен от
  origin хоста. `allow-top-navigation`/`allow-popups` запрещены.
- CSP на статика плагинов: `default-src 'self'; connect-src 'none';
  frame-ancestors <origin хоста>`. Демо добавляет `'unsafe-inline'` в
  `script-src`, потому что `pack` инжектирует синхронный `__VIBE_BOOT__`
  inline-скриптом; в основной системе его можно заменить на hash/nonce.
- Валидация архива (лимит, JSON Schema, semver-gate, zip-slip, checksums)
  выполняется **до распаковки** тем же валидатором, что и `vibe-plugin check`.

## 4. Прогон conformance

Два уровня, оба параметризуются вашим адаптером и не импортируют демо:

```ts
import { runCoreConformance, runConformance, FixtureAdapter, FakeFrameHost, MemoryStore }
  from "@vibe/plugin-contracts/conformance";
import { HostState } from "@vibe/plugin-contracts/host-core";

// DOM-free: фейковые FrameHost/планировщик, кейсы протокола/версий/раскладки
// (всего 27 кейсов: core + browser + прямые проверки адаптера)
runCoreConformance({
  adapterFactory: () => new MyHostAdapter(inMemoryDeps),
  frameHostFactory: () => new FakeFrameHost(),
  state: new HostState(new MemoryStore()),
});

// Браузерный rig: сам поднимает ДВА origin и Chromium; вы даёте только адаптер.
// `TwoOrigins` = { hostOrigin, pluginOrigin, close() } —rig сообщает свои реальные
// origin'ы через onOrigins ДО вызова adapterFactory (в т.ч. для core-кейсов).
let pluginOrigin = "";
const res = await runConformance({
  onOrigins: (origins) => { pluginOrigin = origins.pluginOrigin; },
  adapterFactory: () => new MyHostAdapter({
    pluginOrigin,
    frameBase: (d) => `${pluginOrigin}/plugins/${d.id}/${d.version}/index.html`,
    ...
  }),
  // ports?: [hostPort, pluginPort] — по умолчанию два свободных порта;
  // origins?: TwoOrigins — можно передать уже поднятые origin'ы;
  // playwright?: { chromium } — если раннер уже зарегистрировал свою копию.
});
expect(res.failed).toEqual([]);
```

Импорт `@vibe/plugin-contracts/conformance` и вызов `runCoreConformance` не
требуют `@playwright/test`: он загружается лениво только внутри
`runConformance`.

Один и тот же класс адаптера работает в трёх конфигурациях: прод (ваш реестр),
core (фейки) и rig (in-memory хранилища, origin'а rig'а). В демо это
`demo/tests/conformance.test.ts` — он передаёт реальный `DemoHostAdapter`, а не
копию. Полный прогон вместе с живым сценарием §16: `cd demo && npm test`.

## 5. Что остаётся на стороне основной системы

- Свой UI: шапка, загрузчик zip, Canvas, лаунчер, полноэкранный оверлей, тосты.
- Свой реестр/бэкенд для `getActiveVersions`/`setActiveVersion` и валидации
  архива; в демо это in-memory + `registry.json` без БД.
- Свой роутер, который вызывает `onNavigate` и шлёт `route` обратно во фрейм.
- Расширение `connect-src` через allowlist, если плагину нужен сетевой доступ
  (по умолчанию `connect-src 'none'`).

## 6. Быстрая проверка переноса

```sh
cd contracts && npm test && npx playwright test && node scripts/check-boundary.mjs
cd ../demo && npm test
```

Ожидаемо: все unit/conformance/e2e зелёные, boundary — ноль импортов из `demo/`,
`npx vibe-plugin check dist/<id>-<version>.zip` — `ok` для каждого архива.
