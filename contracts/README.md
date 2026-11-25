# @vibe/plugin-contracts

Versioned contracts for the Vibe plugin platform. This package owns the wire protocol,
manifest rules, the plugin SDK, the portable host runtime, the conformance harness and the
`vibe-plugin` CLI. It is independent of `demo/` and has no workspace configuration.

## Exports

| Subpath | Target (skeleton; compiled to `dist/*` by `npm run build`) |
| --- | --- |
| `@vibe/plugin-contracts/protocol` | `src/protocol/index.ts` |
| `@vibe/plugin-contracts/manifest` | `src/manifest/index.ts` |
| `@vibe/plugin-contracts/sdk` | `src/sdk/index.ts` |
| `@vibe/plugin-contracts/host-core` | `src/host-core/index.ts` |
| `@vibe/plugin-contracts/conformance` | `conformance/index.ts` |
| `@vibe/plugin-contracts/cli` | `cli/index.mjs` |
| `@vibe/plugin-contracts/compatibility.json` | `compatibility.json` |

Binary: `vibe-plugin` → `cli/index.mjs`. `compatibility.json` is the single exported source
of truth for the version policy (supported majors, deprecation window and SDK↔protocol
matrix); consumers must not copy it.

## Scripts

- `npm test` — Vitest unit tests (`jsdom` environment).
- `npm run test:e2e` — Playwright browser tests (two-origin conformance rig).
- `npm run typecheck` / `npm run build` — TypeScript checks and emit into `dist/`.
- `npm run check:boundary` — CLI guard: fail if `src/**/*.ts` imports from `demo/`.
