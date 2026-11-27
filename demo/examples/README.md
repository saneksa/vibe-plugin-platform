# Plugin examples

All examples consume the same `@vibe/plugin-contracts/sdk` and are built with
the same `vite build` / `npm run pack` pipeline. They resolve React, Vue,
Vite (and the Vue SFC plugin) from `demo/node_modules` (framework
dependencies live in `demo/package.json`); each example's `package.json`
documents the canonical `file:../../contracts` link from
`contracts/templates/plugin`.

| Directory | Shows |
| --- | --- |
| `_template/` | Verbatim copy of the canonical `contracts/templates/plugin`; scaffolding reference, not a packable example. |
| `clock-ts-1.2.0/` | Vanilla TS widget: theme, `theme.changed`, writes the note `k` through `host.storage`. |
| `clock-ts/` | `2.0.0` of the **same plugin**: same `id` (`clock`) and `hostApi: "^2"`, updated two-panel render reading the same note. |
| `clock-react/` | React 19 in TSX (`src/main.tsx`, `jsx: react-jsx`) mounted with `createRoot` into the SDK's `el`. |
| `clock-vue/` | Vue 3 SFC (`src/App.vue`) mounted with `createApp` into the SDK's `el`; the hostAPI arrives by `provide`/`inject`. |
| `tasks-app/` | `kind: "app"` routed by **react-router**: the SDK route table feeds a small bridge (`src/hostRouting.tsx`) that mirrors app navigation into the host's `/app/<iid>/<path>` space. Storage-backed tasks/projects, filters, deep links, 404. |
| `notes-app/` | `kind: "app"` with `routes: ["/", "/list", "/settings/:tab"]`, `storage.*` and `navigate` — the SDK route table drives the views directly, no router library. |
| `hostile-widget/` | The seven §13 attacks from a normal SDK plugin (the standalone rig fixture in `contracts/conformance/fixtures/hostile-plugin` is separate). |

## Two directories, one plugin id

`clock-ts@1.2.0` and `clock-ts@2.0.0` deliberately share `manifest.id` ("clock")
and `hostApi` ("^2") but live in separate directories so packing produces two
distinct archives, `clock-1.2.0.zip` and `clock-2.0.0.zip`. The demo's live
scenario uploads the first, adds instances, uploads the second, then upgrades
and rolls back — instance `iid`s, layout and instance-scoped storage survive.

## Build and validate

```sh
cd demo/examples/clock-ts && npm run pack   # writes dist/clock-2.0.0.zip
npx vibe-plugin check dist/clock-2.0.0.zip  # ok
```

`pack()` injects `window.__VIBE_BOOT__` from the manifest, checksums every
archive member and writes `checksums.json`; `check()` revalidates the manifest,
the hostAPI gate, member names and all checksums.
