# VIBE Plugin Platform

> **Эталонная реализация плагинной платформы для браузерного SPA.** Виджеты и приложения на TypeScript приходят zip-архивом, живут в изолированных iframe на тайловом холсте и разговаривают с хостом через версионированный `hostAPI`.

Это не витрина и не продакшн-фреймворк. Это **срез архитектуры**, который можно перенести в основную систему: все контракты вынесены в отдельный пакет, а демо — тонкий потребитель. Эксперимент считается удачным, если выполняются четыре условия:

| Критерий | Как проверяется |
| --- | --- |
| Переносимость контрактов | `contracts/` не импортирует ничего из `demo/`; основная система реализует только `HostAdapter` |
| Доказанная изоляция | недоверенный код не влияет на хост: conformance-ядро + двух-origin browser rig + «вредный» виджет |
| DX автора плагина | `create → pack → upload → плитка` занимает меньше 15 минут |
| Живой сценарий целиком | e2e: загрузка, обновление и откат версии, роутинг приложения, reload, атака |

**Статус:** демо готово, все тесты зелёные. Проект рассчитан на **Node ≥ 24** (нативная поддержка TypeScript type stripping; проверено на `v24.8.0`).

---

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Архитектура](#архитектура)
- [Из чего состоит репозиторий](#из-чего-состоит-репозиторий)
- [Ключевые решения](#ключевые-решения)
- [Путь автора плагина](#путь-автора-плагина)
- [Перенос в основную систему](#перенос-в-основную-систему)
- [Проверка](#проверка)
- [Границы и известные ограничения](#границы-и-известные-ограничения)
- [Документация](#документация)

---

## Быстрый старт

```sh
git clone https://github.com/saneksa/vibe-plugin-platform.git
cd vibe-plugin-platform

cd contracts && npm install && cd ..
cd demo && npm install
npx playwright install chromium   # только для тестов
npm run dev
```

Открой **http://localhost:4000**. Одна команда `npm run dev` поднимает хост, REST API и статику плагинов в одном процессе:

| Origin | Что отдаёт |
| --- | --- |
| `http://localhost:4000` | SPA-хост, `/api/plugins`, `/api/meta`, SPA-fallback для `/` и `/app/<iid>/<path>` |
| `http://localhost:4001` | статика плагинов `/plugins/<id>/<version>/…` — **другой origin** + CSP |

Чтобы на холсте что-то появилось, соберите примеры и загрузите архивы через «Загрузить zip» в шапке:

```sh
npm run examples:pack   # → examples/*/dist/<id>-<version>.zip
```

Дальше: «+ виджет» → плитка на холсте; загрузите вторую версию того же `id` → «Обновить» / «Откатить»; откройте `notes-app` на весь экран и походите по роутам.

---

## Архитектура

```
  archive.zip
  (manifest.json · checksums.json · index.html · dist/ · assets/)
        │  POST /api/plugins (multipart)
        ▼
  ┌─────────────────────────── :4000 ───────────────────────────┐
  │  бэкенд: лимит → имена → манифест → gate мажора → checksums │
  │          → ТОЛЬКО ПОТОМ распаковка → registry.json          │
  │  GET /api/plugins → { versions, activeVersion }              │
  │  PUT /api/plugins/:id/active → обновление / откат            │
  │  GET /api/meta   → политика из compatibility.json           │
  └───────────────────────────┬─────────────────────────────────┘
                              │ SPA + JSON
                              ▼
  ┌─────────────────────────── хост (:4000) ────────────────────┐
  │  DemoHostAdapter (9 методов)  ──  createFrameManager(...)    │
  │  BSP-холст виджетов · полноэкранный оверлей приложения      │
  │  HostState: host.instances.v1 + host.layout.v1               │
  └───────────────────────────┬─────────────────────────────────┘
                              │  <iframe sandbox> · отдельный origin
                              ▼
  ┌─────────────────────────── :4001 ───────────────────────────┐
  │  статика плагина: свой realm, свои CSS/@font-face/глобалы   │
  │  window.__VIBE_BOOT__ → SDK → createPlugin({ mount, routes })│
  └───────────────────────────┬─────────────────────────────────┘
                              │  postMessage RPC
                              ▼
   hello → ready(caps) → rpc(method, ctx) → rpc.result
   event · navigate · route · lifecycle · error
```

Граница безопасности — **разные origin + sandbox + тройная проверка** `origin`/`source`/`iid`; плагин не может достать DOM хоста. `MessageRouter` (проверки, `caps`, мажоры, таймауты) живёт в `host-core` и не знает о DOM и HTTP.

---

## Из чего состоит репозиторий

Один git-репозиторий, **два независимых npm-пакета**:

```
vibe-plugin-platform/
├── contracts/   @vibe/plugin-contracts  ← то, что забираете в основную систему
├── demo/        vibe-plugin-demo        ← тонкий пример интеграции
└── docs/        спецификация и план реализации
```

`contracts/` экспортирует:

| Подпуть | Ответственность |
| --- | --- |
| `protocol` | конверты `Envelope`, валидация, `api`-мажоры, экспортируемая политика версий |
| `manifest` | JSON Schema, semver-gate, контрольные суммы, защита от zip-slip |
| `sdk` | `createPlugin`, типизированный `HostApi`, `routeMatcher`, RPC-клиент с таймаутом |
| `host-core` | `MessageRouter`, `FrameManager`/`FrameHost`, `HostState`, BSP, `HostAdapter` |
| `conformance` | DOM-free ядро + двух-origin browser rig, фикстуры, «вредный» плагин |
| `cli` | `vibe-plugin create / pack / check` |
| `compatibility.json` | единый источник правды о мажорах, депрекации и матрице SDK↔протокол |

`demo/` — намеренно тонкий: `HostAdapter`, UI (шапка, Canvas, лаунчер), реестр на `registry.json`, шесть примеров плагинов. Здесь нет ни одного переносимого механизма — всё приходит из `contracts/`.

---

## Ключевые решения

**Изоляция.** Каждый экземпляр — `iframe` с `sandbox="allow-scripts allow-same-origin allow-forms"` на отдельном origin (`:4001`), с CSP (`connect-src 'none'`, `frame-ancestors …`). `allow-same-origin` безопасен именно потому, что origin плагина не совпадает с origin хоста. Запрещены `allow-top-navigation` и `allow-popups`. Гарантируется изоляция **плагин → хост**; изоляция плагинов друг от друга на уровне origin в демо **не** гарантируется (общий `:4001`) и объявлена не-целью.

**Протокол `hostAPI`.** Запросы инициирует плагин, хост отвечает и пушит события. Поле `api` несёт **только мажор** (`"1"` / `"2"`); миноры — это добавляемые `caps`. `rpc.api` всегда эхо `hello.api`, поэтому адаптер устаревшего мажора выбирается по объявленной версии плагина, а не по версии хоста. Таймаут RPC — 5 с, handshake — 10 с. Проверка `caps` перед каждым вызовом — на стороне ядра.

**Версии и обновление.** Пять независимых осей (схема манифеста, версия плагина, версия SDK, мажор `hostApi`, сборка хоста). Гибрид: внутри мажора протокол append-only, ломающее изменение = новый мажор с жёстким gate при установке. `activeVersion` — **источник истины на бэкенде** (`registry.json`); загрузка архива версию не переключает, обновление и откат идут явным `PUT`. Обновление происходит на месте: тот же `iid`, та же позиция в BSP, `storage` по ключу `pluginId + iid` без версии.

**Холст и приложения.** Виджеты раскладываются BSP-деревом (`h` — рядом, `v` — друг под другом), сколько угодно экземпляров. Приложения полноэкранные, в дерево не входят, имеют виртуальный роутинг `/app/<iid>/<path>` с back/forward и deep-link после reload.

**SDK и CLI.** Плагин реализует только `mount(el, host)` (и `routes` для приложения) — фреймворк не важен: в примерах ванильный TS, React и Vue используют один и тот же SDK. `pack` собирает бандл, инжектирует `window.__VIBE_BOOT__`, считает `checksums.json` и зипует; `check` использует тот же валидатор, что и бэкенд.

**Conformance.** `runCoreConformance` — DOM-free кейсы протокола/версий/раскладки на фейках. `runConformance` — реальный Chromium с двумя собственными origin, «вредным» плагином и прямыми проверками адаптера. Один и тот же класс `HostAdapter` работает в трёх конфигурациях: прод, core, rig.

---

## Путь автора плагина

```sh
npx vibe-plugin create my-widget     # 1. шаблон
cd my-widget
#   2. src/main.ts: createPlugin({ mount(el, host) { … } })
npm run pack                          # 3. build + boot + checksums + zip
npx vibe-plugin check dist/my-widget-1.0.0.zip   # → ok
#   4. «Загрузить zip» в шапке хоста → «+ виджет» → плитка
```

Подробности, включая `manifest.json`, capabilities и `kind: "app"` — в [demo/README.md](demo/README.md).

---

## Перенос в основную систему

Единственный класс, который пишете **вы** — `HostAdapter` (9 методов: `getMeta`, `getContext`, `grantCapabilities`, `dispatchRpc`, `onNavigate`, `getPluginOrigin`, `getPluginFrameBase`, `getActiveVersions`, `setActiveVersion`). Всё остальное — изоляция, RPC, версии, состояние раскладки — поставляется пакетом и не переписывается.

```ts
const adapter = new MyHostAdapter(config);     // ваш единственный класс
const fm = createFrameManager({ adapter });
await fm.restore();                            // сверить activeVersion с кэшем
const rec = fm.createInstance(descriptor, "widget");
fm.mount(container, rec.iid);
await fm.upgrade("clock", "2.0.0");            // in-place, тот же iid
```

Пошаговый разбор каждого метода, подключение рантайма и прогон `runConformance` — в **[demo/docs/integration.md](demo/docs/integration.md)**. Рабочая реализация для копирования — `demo/host/DemoHostAdapter.ts`.

---

## Проверка

```sh
cd contracts
npm test                 # 141 Vitest
npx playwright test      # 4 Playwright (browser rig)
npm run typecheck
node scripts/check-boundary.mjs        # boundary: OK — ноль импортов из demo/
npm run check:playwright-free          # core работает без @playwright/test

cd ../demo
npm test                 # typecheck + 69 Vitest + 2 Playwright (conformance + §16 e2e)
npm run examples:pack
cd ../contracts
for z in ../demo/examples/*/dist/*.zip; do npx vibe-plugin check "$z"; done   # каждый → ok
```

`npm run dev` из `demo/` поднимает оба origin одной командой. Полный §16 e2e проходит через реальные клики: загрузка двух версий, два экземпляра, данные в `storage`, обновление/откат, ресайз, роутинг приложения, back/forward, reload, «вредный» виджет.

---

## Границы и известные ограничения

Открыто и намеренно:

- **Node ≥ 24.** Подпути пакета указывают на `.ts`-исходники; на Node 20/22 нужна отдельная сборка `contracts/` в JS.
- **CSP `script-src 'self' 'unsafe-inline'`.** `pack` инжектирует синхронный inline `__VIBE_BOOT__`, поэтому строгий `script-src 'self'` с ним несовместим. Граница «плагин→хост» от этого не слабеет (отдельный origin, sandbox, `connect-src 'none'`, `frame-ancestors` на месте), но в основной системе стоит заменить на nonce/hash или внешний `boot.js`. Задокументировано в `integration.md`.
- **Изоляция плагинов друг от друга** на уровне origin — не-цель демо (общий `:4001`, общие `localStorage`/cookies этого origin). Точка расширения: `getPluginOrigin(descriptor)` может выдавать отдельный origin на плагин без правок ядра.
- **Не-цели:** авторизация/RBAC, БД, подпись кода, SSR, миграция схем данных плагина, серверная рассылка версий, произвольное позиционирование виджетов.
- **Dev-only демо:** production SPA-fallback ожидает собранный `dist/index.html`, скрипта сборки хоста нет.
- **Два известных Minor (не блокируют):** `demo/host/Shell.ts` перезаписывает сообщение об ошибке статусом «загружено», если после успешной загрузки не удалось обновить реестр-UI; `MessageRouter` не снимает handshake-дедлайн после отклонённого `hello`, из-за чего через 10 с приходит лишнее «handshake timed out».
- Остальные отложенные замечания (defensive copies политики, неатомная запись `registry.json`, классификация ошибок `PUT /active`, `BootOptions.root`, мелочи CLI и примеров) — безопасные follow-up'ы и на сценарий не влияют.

---

## Документация

| Документ | О чём |
| --- | --- |
| [Спецификация](docs/superpowers/specs/2026-11-25-plugin-platform-design.md) | утверждённый дизайн: цели, контракты, модель безопасности, версионирование |
| [План реализации](docs/superpowers/plans/2026-11-25-plugin-platform.md) | 20 задач с точными интерфейсами и TDD-шагами |
| [demo/README.md](demo/README.md) | запуск демо и полный путь автора плагина |
| [demo/docs/integration.md](demo/docs/integration.md) | перенос в основную систему, все 9 методов `HostAdapter`, conformance |
| [contracts/README.md](contracts/README.md) | экспорты и скрипты пакета контрактов |
