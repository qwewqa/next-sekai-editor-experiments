# Next SEKAI Editor

[Editor](https://nse.qwewqa.dev/)

Use the Node.js version in `.node-version`.

```sh
npm ci
npm run dev
```

The web editor’s preview uses the Next SEKAI skins, particle and sound effects from coconut.sonolus.com
(`deployment/preview-assets.lock.json`). `npm run dev` stages the five packages in
`public/resource/` before it starts: a package that matches the lock stays, otherwise it comes
from a cache in `node_modules/.cache/nse-preview-assets/`, otherwise it is downloaded and checked
against the lock. If a package is missing, the editor uses Built-in only, as the apps do, and says
so at start. `NSE_SKIP_PREVIEW_ASSETS=1 npm run dev` does that on purpose. To stage them by hand,
as CI does:

```sh
node --input-type=module -e "const { stagePreviewAssets } = await import('./scripts/release-assets.mjs'); await stagePreviewAssets(process.cwd(), 'public')"
```

`npm run build:release` builds `dist` with preview assets.

## Maintaining

Setup, tests, formats and releasing are in [CONTRIBUTING.md](CONTRIBUTING.md). The specs are
[History and browser storage](docs/history-format.md), [the project file](docs/nxsp-format.md)
and [format versioning](docs/format-versioning.md). The release notes are in [CHANGELOG.md](CHANGELOG.md).

## Built-in assets and the native build

`public/builtin/` holds the Built-in preview set, made by `npm run build:builtin-assets` from
`builtin-assets/` and committed. `npm run check:builtin-assets` rebuilds it and compares the bytes.
`npm run build:native` builds `dist-native/`, the apps' frontend, from an allowlisted public folder, and
`npm run check:native-bundle` checks that no web-only file or reference is in it. Neither needs Rust.

## Licensing

- The code is MIT (`LICENSE.txt`).
- The Built-in art and the app icon are CC0 1.0 (`builtin-assets/LICENSE.txt`).
- Every other file is covered as `REUSE.toml` says.

## Browser compatibility

The production build targets Chrome/Edge 106, Firefox 105 and Safari/iOS 16
(the October 2022 baseline). Keep these targets explicit when updating Vite;
its [default build targets](https://v8.vite.dev/config/build-options) can move forward.
Build targets cover syntax; browser APIs still need feature detection or fallbacks.
Note rendering falls back when `roundRect` is unavailable, and viewport sizing
falls back to `vh` when dynamic viewport units are unavailable.

At run time the support gate (`public/gate.js`) needs IndexedDB, `navigator.storage.estimate`,
Web Locks, OffscreenCanvas and `structuredClone`, and shows a plain page in a browser that lacks one.
With the build targets, that makes the minimum Safari and iOS 17, Chrome and Edge 106, and Firefox 105.

```sh
npx playwright install firefox webkit
npm run test:compatibility
```

This builds and tests the production UI in Firefox, WebKit and mobile WebKit:
import and export, touch context menus, scaling, elevation layouts in both
orientations, WebGL editor rendering, preview texture decoding and rendering,
internal copy and paste when browser clipboard permissions are denied, audio
scheduling and waveform rendering.

Playwright 1.27.1’s archived Chromium 107.0.5304.18 and Firefox 105.0.1 binaries are close to the
floor and can run the production UI checks. Its WebKit 16.0 is below the minimum and gets the gate’s
page. Use archived binaries only for isolated local testing.

[Playwright WebKit](https://playwright.dev/docs/browsers#webkit) is a Safari engine
check, not a real iPhone or branded Safari test. Its Windows build lacks Web Audio, so
audio tests are skipped there, and production UI tests stub audio initialization.
Linux CI runs those audio tests without the stub. Real iOS Safari still needs device
checks for audio activation, clipboard permissions, file pickers/downloads, browser
chrome resizing, and safe areas.

## Renderer maintenance

See [renderer ownership and upgrades](docs/rendering.md) for GPU resource ownership,
text policies, the pinned Pixi patches, and the verified Rust/Lyon geometry kernel.
See [performance testing](docs/performance-testing.md) for measuring scrolling and playback.
