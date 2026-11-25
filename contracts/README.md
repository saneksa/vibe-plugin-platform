# @vibe/plugin-contracts

Версионированный пакет контрактов VIBE plugin platform. Владеет wire-протоколом,
правилами манифеста, SDK плагина, переносимым рантаймом хоста, conformance-харнессом
и CLI `vibe-plugin`. **Не зависит от `demo/`** и не использует npm-workspaces.

- Установка: `npm i @vibe/plugin-contracts@^2` (в демо — `file:../contracts`).
- **Node ≥ 24:** подпути указывают на `.ts`-исходники, CLI использует нативную
  type stripping. `npm run build` при необходимости собирает JS в `dist/`.
- Обзор всего проекта — [README в корне](../README.md).

## Экспорты

| Подпуть | Что даёт |
| --- | --- |
| `@vibe/plugin-contracts/protocol` | `Envelope` + codec, валидация полей, `api`-мажоры, `getPolicy` / `getMeta`, `CAPS_CATALOGUE` |
| `@vibe/plugin-contracts/manifest` | `PluginManifest`, JSON Schema, semver-gate, `computeChecksums`, `verifyArchiveNames` |
| `@vibe/plugin-contracts/sdk` | `createPlugin`, типизированный `HostApi`, RPC-клиент с таймаутом, `routeMatcher`, `readBoot` |
| `@vibe/plugin-contracts/host-core` | `HostAdapter`, `MessageRouter`, `FrameManager` / `FrameHost`, `HostState`, BSP, `upgrade`, `adapters/v1` |
| `@vibe/plugin-contracts/conformance` | `runCoreConformance` (DOM-free), `runConformance` (двух-origin browser rig), фикстуры, `startTwoOrigins` |
| `@vibe/plugin-contracts/cli` | `create` / `pack` / `check` |
| `@vibe/plugin-contracts/compatibility.json` | политика версий |

Бинарник: `vibe-plugin` → `cli/index.mjs`. `compatibility.json` — **единственный
источник правды** о поддерживаемых мажорах, окне депрекации и матрице SDK↔протокол;
копировать его в потребителя нельзя.

`@playwright/test` загружается **лениво** только внутри `runConformance`, поэтому
импорт conformance-подпути и вызов `runCoreConformance` работают без Playwright.
`fflate` — обычная `dependency` (используется `pack`/`check` в рантайме), не devDependency.

## Скрипты

| Команда | Назначение |
| --- | --- |
| `npm test` | Vitest, окружение `jsdom` |
| `npm run test:e2e` | Playwright: двух-origin browser rig |
| `npm run typecheck` / `npm run build` | `tsc --noEmit` / сборка в `dist/` |
| `npm run check:boundary` | ноль импортов из `demo/` в `src/`, `conformance/`, `cli/`, `templates/` (`.ts` / `.js` / `.mjs`) |
| `npm run check:playwright-free` | доказывает, что conformance-ядро работает без разрешимого `@playwright/test` |

## Правило границы

Пакет не знает о существовании демо: `check-boundary.mjs` падает, если где-либо
в `contracts/` появляется импорт из `demo/`. Потребитель реализует **только**
`HostAdapter` (9 методов); изоляция, RPC, версии и состояния поставляются пакетом.
Пошаговый разбор — [demo/docs/integration.md](../demo/docs/integration.md).
