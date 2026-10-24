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
| The mock platform | `src/platform/mock.ts`, injected with `setPlatformForTests` | Tests |
| Native-only features | `src/library/`, `src/projects/` | Native only, loaded through one loader |
| Asset defaults | `#asset-defaults` | Per build |

`#platform` and `#asset-defaults` are `package.json` `imports` with a `native` condition. Native mode (`vite --mode native`) selects it; the web build and the Node tests resolve the `default` target.

### Capabilities, not checks

Feature code never asks which platform it is on. It asks `platform.capabilities`, a read-only object fixed at startup. Add a capability when a second place needs the same difference, and name it for what it allows, not for a platform. A string that differs by capability is a keyed variant picked by one helper, not a forked component.

The lint enforces the boundary (`npm run check-lint`):

- `@tauri-apps/*`, `src/platform/native/` and the native-only folders are imported only from the native code and its one loader.
- `__NATIVE__` and `isTauri` appear only in the build configuration, the native code and the loader.
- `platform.kind` and `platform.os` appear only in `src/platform/`.

### Adding a capability

1. Add the field to `PlatformCapabilities` in `src/platform/types.ts`, named for what it allows.
2. Set it in `src/platform/web.ts`, in `src/platform/native/` and in the mock’s defaults (`src/platform/mock.ts`).
3. Read it as `platform.capabilities.<name>` where behaviour differs. Never branch on `kind` or `os` outside `src/platform/`.
4. Test the code with both values (see Tests).

### Adding a string variant

A string that must read differently by capability is one keyed variant, picked by one helper, not a forked component. Add both keys to `src/i18n/en/index.json` and to the other six locales (`fr`, `ja`, `ko`, `tr`, `zhs`, `zht`) in the same commit. Follow the existing strings: terse and plain, no contractions, Title Case buttons.

### Native-only features

A feature the web can't do safely lives in `src/library/` or `src/projects/` and registers its commands from the native loader, so the web bundle never contains it. The web never shows a teaser or a disabled control for it.

To add one:

1. Put the code in `src/library/` or `src/projects/`. Nothing else imports it, statically or with `import()`; the lint stops that.
2. Register its commands and views from the native loader, which only the native build includes.
3. Add a capability only if shared code must know whether the feature exists.
4. Run `npm run build:native` and `npm run check:native-bundle`.

## UI design

Read these before you change the UI and when you review a UI change:

- [docs/design-language.md](docs/design-language.md): surfaces, shape, sizes, spacing and the History surfaces.
- [docs/color-system.md](docs/color-system.md): colour roles and the control recipes in `src/controls.css`.
- [docs/ui-review-checklist.md](docs/ui-review-checklist.md): the questions to ask in review, from past defects.

They are principles with reasons. Depart from one when a case needs it, and say why in the change. If a change makes a claim in them false, fix the page in the same change.

## Built-in assets

`builtin-assets/` makes the Built-in set (`public/builtin/*.scp`) and the app icon renders. Edit a template in `builtin-assets/svg/` or the manifest, then run `npm run build:builtin-assets` and commit the result. `npm run check:builtin-assets` fails when the committed files differ from a rebuild.

The art is CC0 and must be original. The generator scripts are MIT. `REUSE.toml` says which licence covers which path, and `tests/licensing.test.mjs` fails on a new image, sound or icon that has no annotation.

`tests/fixtures/next-sekai-names.json` holds the names the engine declares. A maintainer refreshes it with `scripts/extract-engine-names.mjs` from a built engine when the engine changes.

## Tests

- `npm run check-type`, `npm run check-lint` and `npm run check-format`.
- `npm test`: the unit suites, including the pipeline and licensing tests. Shared code that depends on a capability is tested with both capability sets: inject `createMockPlatform({ capabilities: { ... } })` with `setPlatformForTests` once per set, and restore it afterwards.
- A native test is needed for anything that touches the native implementation, the filesystem, the OS or the Rust side. Shared tests use the mock platform and need no Rust.
- `npm run test:release`: the release scripts.
- `npm run test:browser`: the Playwright specs; run the ones for your area with `npx playwright test <spec> --project=chromium`.

## Formats

Stored formats change only through the version rules (Part 0, 0.11.7):

- Readers before writers. A release that can read format N+1 ships at least one release before the first that writes it, and the writer’s release notes say which version is needed. The level model counts: a new archetype, field or choice value raises `levelVersion`.
- Never write what you do not understand. A file with content a build does not read opens separately; newer data opens read-only or is refused.
- Every stored file carries a version, and every new format or field goes into the format table in the same change.
- Fixtures are committed, one per format version, and every self-test reads them. See the notes in the code next to each format.

Read these before you change a format:

- [docs/format-versioning.md](docs/format-versioning.md): what each version number does, the extension points and the checklist for a format change.
- [docs/history-format.md](docs/history-format.md): the History data model, the `.nxsp` history parts, every History operation, the safety rules and how to add an operation.

## Engineering principles

Read this before you write or review code or tests:

- [docs/engineering-principles.md](docs/engineering-principles.md): defaults and unknowns, one source per fact, owned module state, failures that are not empty, honest tests, shared spec helpers, true text, no compatibility code before ship, proportionate protection, and tests and UI elements that earn their place.

## Performance

Read this before you measure or optimize scrolling or playback:

- [docs/performance-testing.md](docs/performance-testing.md): the perf harness (`npm run perf`), what to judge (per-frame work against 4.17 ms and 8.33 ms), the setup that gives stable numbers, the charts to use and the current baseline.

## Forks

A fork builds everything unsigned with no setup beyond the Node version: `npm install`, then `npm run build` or `npm run build:native`.
