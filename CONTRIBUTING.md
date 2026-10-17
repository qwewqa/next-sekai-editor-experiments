# Contributing

## Setup

Use the Node.js version in `.node-version`.

```sh
npm install
npm run dev
```

Frontend work needs nothing else, and no Rust. `npm run build:native` and `npm run check:native-bundle` are Node only too.

## Where code goes

One frontend is built twice: `npm run build` for the web and `npm run build:native` for the apps.

| What | Where | In which build |
| --- | --- | --- |
| Editor, sessions, storage, writer, ZIP, UI | `src/` | Both |
| The platform interface and detection | `src/platform/index.ts`, `detect.ts` | Both |
| The web implementation | `src/platform/web.ts` | Web, through `#platform` |
| The native implementation | `src/platform/native/` | Native only, through `#platform`'s `native` condition |
| The mock platform | `src/platform/mock.ts` | Tests |
| Native-only features | `src/library/`, `src/projects/` | Native only, loaded through one loader |
| Asset defaults | `#asset-defaults` | Per build |

`#platform` and `#asset-defaults` are `package.json` `imports` with a `native` condition. Native mode (`vite --mode native`) selects it; the web build and the Node tests resolve the `default` target.

### Capabilities, not checks

Feature code never asks which platform it is on. It asks `platform.capabilities`, a read-only object fixed at startup. Add a capability when a second place needs the same difference, and name it for what it allows, not for a platform. A string that differs by capability is a keyed variant picked by one helper, not a forked component.

The lint enforces the boundary (`npm run check-lint`):

- `@tauri-apps/*`, `src/platform/native/` and the native-only folders are imported only from the native code and its one loader.
- `__NATIVE__` and `isTauri` appear only in the build configuration, the native code and the loader.
- `platform.kind` and `platform.os` appear only in `src/platform/`.

### Native-only features

A feature the web can't do safely lives in `src/library/` or `src/projects/` and registers its commands from the native loader, so the web bundle never contains it. The web never shows a teaser or a disabled control for it.

## Built-in assets

`builtin-assets/` makes the Built-in set (`public/builtin/*.scp`) and the app icon renders. Edit a template in `builtin-assets/svg/` or the manifest, then run `npm run build:builtin-assets` and commit the result. `npm run check:builtin-assets` fails when the committed files differ from a rebuild.

The art is CC0 and must be original. The generator scripts are MIT. `REUSE.toml` says which licence covers which path, and `tests/licensing.test.mjs` fails on a new image, sound or icon that has no annotation.

`tests/fixtures/next-sekai-names.json` holds the names the engine declares. A maintainer refreshes it with `scripts/extract-engine-names.mjs` from a built engine when the engine changes.

## Tests

- `npm run check-type`, `npm run check-lint` and `npm run check-format`.
- `npm test`: the unit suites, including the pipeline and licensing tests.
- `npm run test:release`: the release scripts.
- `npm run test:browser`: the Playwright specs; run the ones for your area with `npx playwright test <spec> --project=chromium`.

## Formats

Stored formats change only through the version rules: readers ship before writers. See the notes in the code next to each format.
