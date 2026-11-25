# VIBE plugin platform — демо

Это демонстрационный потребитель пакета `@vibe/plugin-contracts`: two-origin
хост с плитками виджетов и полноэкранными приложениями. Вся изоляция, RPC,
версии и состояние раскладки живут в контрактах; здесь — только тонкая обвязка
(`HostAdapter` + UI + бэкенд реестра).

Общий обзор репозитория, архитектура и границы — [README в корне](../README.md);
перенос в основную систему — [docs/integration.md](docs/integration.md).

## Требования

- **Node ≥ 24.** Подпути пакета указывают на `.ts`-исходники, а CLI использует
  нативную type stripping; проверенная версия — Node `v24.8.0`. На Node 20/22
  пакет потребует отдельной сборки в JS.
- npm, Chromium для Playwright (`npx playwright install chromium` при первом запуске).

## Запуск одной командой

```sh
npm install
npm run dev
```

`npm run dev` поднимает **оба origin и бэкенд в одном процессе**:

| Адрес | Что отдаёт |
| --- | --- |
| `http://localhost:4000` | SPA-хост + REST API (`/api/plugins`, `/api/meta`) |
| `http://localhost:4001` | статика плагинов (`/plugins/<id>/<version>/…`), другой origin + CSP |

Главная страница и deep-link'и (`/`, `/app/<iid>/<path>`) возвращают
`host/index.html`; Vite в dev-режиме обслуживает TS-исходники хоста, а
`storage/` исключён из watcher'а, чтобы загрузка архива не перезагружала страницу.

```sh
npm run examples:pack   # собрать и запаковать все примеры → dist/<id>-<version>.zip
npm test                # typecheck + Vitest + Playwright (conformance и e2e)
npm run test:e2e        # только сценарий §16
```

`npm test` запускает `tsc --noEmit`, затем Vitest (только `host/`, `server/`,
`examples/`) и затем Playwright с явными путями `tests/conformance.test.ts`
и `tests/e2e.spec.ts`. Vitest не собирает Playwright-файлы и наоборот.
Playwright сам пакует примеры и стартует демо через `webServer`.

## Путь «create → pack → upload → плитка» (< 15 минут)

1. **Create.** В каталоге плагина:

   ```sh
   npx vibe-plugin create my-widget
   cd my-widget
   ```

   Шаблон лежит в `contracts/templates/plugin/` и развёрнут как
   `examples/_template/`. Он уже содержит `manifest.json`, `index.html`,
   `src/main.ts`, Vite-конфиг и `scripts/pack.mjs`.

2. **Пишем плагин.** Одна функция `createPlugin({ mount(el, host) { … } })`
   из `@vibe/plugin-contracts/sdk`; для `kind: "app"` добавляем `routes`.
   Фреймворк не важен — есть готовые `clock-ts`, `clock-react`, `clock-vue`.

3. **Pack.**

   ```sh
   npm run pack                              # build + inject boot + checksums + zip
   npx vibe-plugin check dist/my-widget-1.0.0.zip   # → ok
   ```

   `pack` запускает `npm run build` плагина, инжектирует
   `window.__VIBE_BOOT__`, считает `checksums.json` и пишет
   `dist/<id>-<version>.zip`. Тот же валидатор работает на бэкенде при загрузке.

4. **Upload.** В шапке хоста: «Загрузить zip» → выбрать архив. Бэкенд проверяет
  manifest, hostApi-мажор, пути и контрольные суммы **до** распаковки; ошибка
   показывается текстом в шапке.

5. **Плитка.** «+ виджет» → кнопка с заголовком плагина → новая плитка на
   холсте (BSP-дерево). Добавляйте сколько угодно экземпляров — активна ровно
   одна версия каждого `id`.

Далее: загрузите вторую версию с тем же `id`, нажмите «доступно обновление»
(«Обновить») или «Откатить» — `iid`, позиция и данные переживают переключение.
 `notes-app` открывается на весь холст и имеет роутинг `/app/<iid>/<path>`
с back/forward.

## Примеры

| Каталог | Что показывает |
| --- | --- |
| `clock-ts-1.2.0` | ванильный TS-виджет, `theme.read`, запись `k` в `host.storage` |
| `clock-ts` | версия 2.0.0 того же `id` для обновления |
| `clock-react` / `clock-vue` | тот же SDK с React 19 / Vue 3 |
| `notes-app` | полноэкранное приложение с роутами и back/forward |
| `hostile-widget` | семь атак §13, изоляция видна вживую |

Подробности переноса в основную систему — [docs/integration.md](docs/integration.md).
