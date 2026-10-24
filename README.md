# Sonolus Next SEKAI Editor

[Editor](https://nse.qwewqa.dev/)

Use the Node.js version in `.node-version`.

```sh
npm ci
npm run dev
```

Local preview requires `public/resource/skin.scp`; `public/resource/particle.scp` is optional.

`npm run build:release` builds `dist` with preview assets.

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

The production build targets Chrome/Edge 106, Firefox 105, and Safari/iOS 16
(the October 2022 baseline). Keep these targets explicit when updating Vite;
its [default build targets](https://v8.vite.dev/config/build-options) can move forward.
Build targets cover syntax; browser APIs still need feature detection or fallbacks.
Note rendering falls back when `roundRect` is unavailable, and viewport sizing
falls back to `vh` when dynamic viewport units are unavailable.

```sh
npx playwright install firefox webkit
npm run test:compatibility
```

This builds and tests the production UI in Firefox, WebKit, and mobile WebKit,
including import/export, touch context menus, scaling, elevation layouts in both
orientations, WebGL editor rendering, preview texture decoding/rendering, and
internal copy/paste when browser clipboard permissions are denied.
The suite also checks audio scheduling and waveform rendering.

The October 2026 audit additionally passed all five production UI checks in
archived Chromium 107.0.5304.18, Firefox 105.0.1, and WebKit 16.0 binaries from
Playwright 1.27.1. Archived binaries are for isolated local testing only.

[Playwright WebKit](https://playwright.dev/docs/browsers#webkit) is a Safari engine
check, not a real iPhone or branded Safari test. Its Windows build lacks Web Audio:
audio tests are skipped there, and production UI tests stub audio initialization.
Linux CI runs those audio tests without the stub. Real iOS Safari still needs device
checks for audio activation, clipboard permissions, file pickers/downloads, browser
chrome resizing, and safe areas.

## Renderer maintenance

See [renderer ownership and upgrades](docs/rendering.md) for GPU resource ownership,
text policies, the pinned Pixi patches, and the verified Rust/Lyon geometry kernel.
See [performance testing](docs/performance-testing.md) for measuring scrolling and playback.
