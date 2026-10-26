# Contributing

## Setup

Use the Node.js version in `.node-version`.

```sh
npm ci
npm run dev
```

Frontend work needs nothing else, and no Rust. `npm run build:native` and `npm run check:native-bundle` are Node only too.

Coding agents: see [AGENTS.md](AGENTS.md).

## Where code goes

One frontend is built twice: `npm run build` for the web and `npm run build:native` for the apps.

| What | Where | In which build |
| --- | --- | --- |
| Editor, sessions, storage, writer, ZIP, UI | `src/` | Both |
| The platform interface and detection | `src/platform/index.ts`, `detect.ts` | Both |
| The web implementation | `src/platform/web.ts` | Web, through `#platform` |
| The native implementation | `src/platform/native/` | Native only, through `#platform`'s `native` condition |
| The mock platform | `src/platform/mock.ts`, injected with `setPlatformForTests` | Tests |
| Native-only features | `src/library/`, `src/projects/` (with the native apps) | Native only, loaded through one loader |
| Usage statistics ([docs/analytics.md](docs/analytics.md)) | `src/analytics/` | Web, when the build has a target |
| Asset defaults | `#asset-defaults` | Per build |
| The AWS services around the editor: their templates, scripts and runbooks | `infra/` | Neither |

`#platform` and `#asset-defaults` are `package.json` `imports` with a `native` condition. Native mode (`vite --mode native`) selects it; the web build and the Node tests resolve the `default` target. A web build or dev server without the five Next SEKAI packages takes the `builtin-only` target, the apps’ Built-in defaults (README).

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

A string that must read differently by capability is one keyed variant, picked by one helper, not a forked component. Add both keys to `src/i18n/en/index.json` and to the other six locales (`fr`, `ja`, `ko`, `tr`, `zhs`, `zht`) in the same commit. Follow [docs/writing.md](docs/writing.md).

### Native-only features

A feature the web cannot do safely lives in `src/library/` or `src/projects/` and registers its commands from the native loader, so the web bundle never contains it. The web never shows a teaser or a disabled control for it. These folders and the loader (`src/nativeLoader.ts`) arrive with the native apps. The lint already reserves their paths (`eslint.config.js`).

To add one:

1. Put the code in `src/library/` or `src/projects/`. Nothing else imports it, statically or with `import()`; the lint stops that.
2. Register its commands and views from the native loader. Only the native build includes the loader.
3. Add a capability only if shared code must know whether the feature exists.
4. Run `npm run build:native` and `npm run check:native-bundle`.

## Docs

`docs/` and this file hold what stays useful to later, unrelated work: rules with their reasons, format specifications and guides to the code. A status report, a log of fixes or the spec for a single feature helps little later and goes out of date, so keep it out of the repository.

The rules in these docs are principles with reasons. Depart from one when a case needs it, and say why in the change. To change a rule itself, because it gets in the way or misses a case, raise it with the maintainer and discuss it first. If a change makes a claim in the docs false, fix the page in the same change.

In code, tests and docs, cite only what is in the repository: the docs, by file name and section, such as "history-format.md §4.6". Never cite an outside plan or design record. A reader cannot open it. `tests/citations.test.mjs` fails on the common forms of such a citation.

Keep a rule at the scope it was made for. Do not turn a rule for one control or feature into a project-wide rule. Do not document a specific behaviour that the code already shows.

## UI design

Read these before you change the UI and when you review a UI change:

- [docs/design-language.md](docs/design-language.md): surfaces, shape, sizes, spacing, the History surfaces, and waits and feedback.
- [docs/color-system.md](docs/color-system.md): colour roles and the control recipes in `src/controls.css`.
- [docs/ui-review-checklist.md](docs/ui-review-checklist.md): the questions to ask in review, from past defects.
- [docs/writing.md](docs/writing.md): the writing rules for user-facing text, these docs, code comments and commit messages.

## Built-in assets

`builtin-assets/` makes the Built-in set (`public/builtin/*.scp`) and the app icon renders. Edit a template in `builtin-assets/svg/` or the manifest, then run `npm run build:builtin-assets` and commit the result. `npm run check:builtin-assets` fails when the committed files differ from a rebuild.

The art is CC0 and must be original. The generator scripts are MIT. `REUSE.toml` says which licence covers which path, and `tests/licensing.test.mjs` fails on a new image, sound or icon that has no annotation.

`tests/fixtures/next-sekai-names.json` holds the names the engine declares. A maintainer refreshes it with `scripts/extract-engine-names.mjs` from a built engine when the engine changes.

## Tests

CI runs these (`.github/workflows/check.yml`):

- `npm run check-type`, `npm run check-lint` and `npm run check-format`.
- `npm test`: the unit suites, including the pipeline and licensing tests. CI runs them in UTC (`TZ=UTC npm test`). Shared code that depends on a capability is tested with both capability sets: inject `createMockPlatform({ capabilities: { ... } })` with `setPlatformForTests` once per set, and restore it afterwards.
- `uv run python -I tools/nxsp_check.py tests/local/nxsp/golden-v1/*.nxsp tests/zip/plan-conformance-v1/*/expected.nxsp`: the independent checker over the `.nxsp` fixtures. It needs `uv`.
- `npm run test:release`: the release scripts and the changelog format.
- `npm run check:builtin-assets`, and `npm run build:native` then `npm run check:native-bundle`.
- `npm run test:compatibility` in Firefox, WebKit and mobile WebKit, in jobs that run beside the checks above. The storage specs run in shards, and only the core of them: the ones in `coreStorageSpecs` in `playwright.compatibility.config.ts`. A new storage spec goes in that list unless it is slow. The slow ones (`startupSessions` and `openProject`) run in `.github/workflows/browsers-full.yml` together with the core, every night, on a push to a `ci/` branch and when started by hand: `gh workflow run browsers-full.yml --ref main`. A run stops after four failed browser tests, and a newer push to a branch or pull request cancels the older run.

A change under `infra/` or to an infra workflow also runs `.github/workflows/infra-check.yml`: `cfn-lint`, `infra/check_templates.py`, `shellcheck`, and a contract test of the real Umami and PostgreSQL images. Run the first three locally as `infra/README.md` shows.

Also:

- A native test is needed for anything that touches the native implementation, the filesystem, the OS or the Rust side. Shared tests use the mock platform and need no Rust.
- `npm run test:browser`: the Playwright specs in Chromium, `preview.spec.ts` and `previewSelection.spec.ts` again in the worker host (`chromium-worker`), then the timing specs alone (`npm run test:timing`). Run the ones for your area with `npx playwright test <spec> --project=chromium`, and for a preview change also with `--project=chromium-worker`. Many need the preview assets (README).
- `npm run test:production`: the production build's specs, after `npm run build:release`.
- `npm run test:compatibility`: Firefox, WebKit and mobile WebKit (README, "Browser compatibility").

## Formats

Stored formats change only through the rules in [docs/format-versioning.md](docs/format-versioning.md): readers before writers, the lowest version that holds the content, and its checklist. Until v0.6.0 ships they change in place at v1.

- Readers before writers. A release that can read format N+1 ships at least one release before the first that writes it, and the writer’s release notes say which version is needed. The level model counts: a new archetype, field or choice value raises `levelVersion`.
- Never write what you do not understand. A newer `patch`, an `x` value, an `extra` key or a `cache/` entry opens normally. Other content a build does not read opens the file as a separate copy. Newer data in browser storage opens read-only or is not read.
- Every stored file carries a version, and every new format or field goes into the format table in the same change.
- Fixtures are committed, one per format version, and every self-test reads them. See the notes in the code next to each format.

Read these before you change a format:

- [docs/format-versioning.md](docs/format-versioning.md): what each version number does, the extension points and the checklist for a format change.
- [docs/history-format.md](docs/history-format.md): the History data model, the `.nxsp` history parts, every History operation, the safety rules and how to add an operation.
- [docs/nxsp-format.md](docs/nxsp-format.md): the `.nxsp` project file byte by byte, for a reader or writer built without the editor's code.

## Engineering principles

Read this before you write or review code or tests:

- [docs/engineering-principles.md](docs/engineering-principles.md): defaults and unknowns, one source per fact, owned module state, failures that are not empty, honest tests, shared spec helpers, true text, no compatibility code before ship, proportionate protection, and tests and UI elements that earn their place.

## Performance

Read this before you measure or optimize scrolling or playback:

- [docs/performance-testing.md](docs/performance-testing.md): the perf harness (`npm run perf`), what to judge (per-frame work against 4.17 ms and 8.33 ms), the setup that gives stable numbers, the charts to use and the known costs.

## Releasing

1. Add each user-visible change as a line under `## Unreleased` in `CHANGELOG.md`, in the commit that makes it. A line is `- `, an optional `(Web)` or `(Apps)`, then plain text with no contractions and ’ for apostrophes. `npm run test:release` checks the format.
2. Once Check and Deploy Pages have passed for the commit on `main`, and Browsers Full has too (start it with `gh workflow run browsers-full.yml --ref main`; for an earlier commit, push the commit to a `ci/` branch), run `npm run release:tag -- X.Y.Z` there (`--commit <sha>` tags an earlier commit; `--edit` opens the notes first). It needs `gh`, signed in. It makes the annotated tag `vX.Y.Z` with the `## Unreleased` lines as its message, then the commit "Changelog for X.Y.Z". That commit moves those lines under `## X.Y.Z (date)` and sets the version in `package.json` and `package-lock.json`. It refuses a patch version (Z above 0) when a format version changed since the last tag. A release build sends usage statistics only when the repository variables `ANALYTICS_ORIGIN` and `ANALYTICS_WEBSITE_PRODUCTION` are set before its tag is pushed (`docs/analytics.md`, "Build variables").
3. Run the push it prints, `git push --atomic origin main vX.Y.Z`. Pushing the tag is the release. Deploy Pages then runs Check, builds with `npm run build:release`, runs `npm run test:production` and `npm run check:release`, and deploys when the tag is the highest `v*` tag. A push to `main` deploys nothing. A pushed tag is never moved or deleted.
4. For a fix while `main` holds unfinished work, make a branch from the last tag, commit the fix there and run the script on it. CI does not check that branch before the tag, so the script prints the local checks to run first. Merge the branch into `main` afterwards.
5. After the deploy, check the live site: `PRODUCTION_TEST_URL=https://nse.qwewqa.dev npm run test:production`.

The AWS services in `infra/` are not part of a release. They deploy by hand, by the steps in `infra/README.md` and `infra/stats/README.md`, and never with a tag.

## Forks

A fork builds everything unsigned with no setup beyond the Node version: `npm ci`, then `npm run build` or `npm run build:native`.
