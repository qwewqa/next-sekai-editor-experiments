# Performance testing

How to measure scrolling and preview playback so the numbers mean something, with the tools in `scripts/perf/`. The tools drive a perf build in headed Chromium, time every frame, and trace a run so the time can be attributed to source functions. Most of this page is what works and what misleads.

## Quick start

```sh
npm run perf -- scripts/perf/plans/smoke.json --name smoke --affinity 0xFFFF0000
npm run perf:report -- perf-results/smoke frames
npm run perf:report -- perf-results/smoke work
npm run perf:report -- perf-results/smoke long perf-results/smoke/traces/<cell>.json.gz 16
```

`npm run perf` runs these steps:

1. It builds with `NSE_PERF=1` and sourcemaps into `perf-results/dist`.
2. It serves that build with `vite preview` on port 5360.
3. It runs each plan group in a fresh headed Chromium profile.
4. It writes `perf-results/<name>/`:
    - `results.jsonl`, one record per cell;
    - `log.txt`;
    - a screenshot per cell;
    - `traces/*.json.gz`, which open in DevTools' Performance panel.

`perf-results/` is ignored by git.

Options:

- `--no-build` reuses the last build.
- `--url` measures a server you started yourself, such as the dev server. The dev server needs `NSE_PERF=1` too.
- `--affinity` and `--priority` pin the run (see "Where the processes run").

## The probes

A perf build (`NSE_PERF=1`, the `__NSE_PERF__` define) adds two things:

- `window.nsePerf`, the harness's handle on the view, settings, state, player and minimap stats (`src/perf/hook.ts`).
- Per-frame timings (`src/perf/probe.ts`):
    - `chartDraw` and `overlayDraw`: the chart's frame callbacks;
    - `clockFrame`: the app clock's whole frame, which covers the time watchers, Vue's flush and the draws it triggers;
    - `previewDraw`, `elevationDraw` and `minimapOverlay`.

Other builds define the flag false: `timed` returns its callback, and the hook is never imported or bundled. Probes collect only while a run has switched them on.

## Plans

A plan is JSON (see `scripts/perf/plans/example.json`): `defaults` for every cell, then `groups`. Each group has:

- `id`;
- `profile`: `desktop1600`, `desktop1280`, `desktop1280x4`, `phone`, or an object with `viewport`, `deviceScaleFactor`, `hasTouch`, `isMobile` and `throttle`;
- `hz`: `"native"`, or 60 or 120 for the frame gate;
- `chart`: a level data path from the editor root;
- optional `bgm`;
- `cells`.

Each cell can set:

- `scenario`: `wheel`, `trackpad`, `pagekeys`, `quicktouch`, `flick`, `minimapdrag`, `play1x`, `play2x`, `resizedrag` (with `handle`, a separator's accessible name, and `dx`), or `idle`;
- `layout`;
- `minimap`, `preview`, `elevation` (beside the chart) and `selection` (every note and connector);
- `pps` (100 is fully zoomed out);
- `start`;
- `seconds` and `speed` for playback;
- `reps` and `warmup`;
- `trace` and `traceCold`;
- `tag`.

## What works, and what misleads

### Build and browser

- **Measure a production build with sourcemaps.** Vue's dev mode and unbundled modules change the timings.
    - The sourcemaps let `trace.mjs` turn minified frames back into `src/...:line`.
    - Use the dev server only to compare.
- **Run headed with the real GPU.** Headless Chromium can fall back to SwiftShader, which makes every chart number meaningless.
    - Every group records `UNMASKED_RENDERER_WEBGL` in `info.renderer`.
    - Check that it names your GPU (for example `ANGLE (NVIDIA, …, D3D11)`), not SwiftShader.
- Open the chart through Open and load its BGM through the BGM dialog. This is the user's path: the waveform draws and the session counts as edited.

### Display rate and what to judge

- **Judge per-frame work, not frame intervals.** The budgets are:
    - **4.17 ms per frame for the 240 Hz desktop**;
    - **8.33 ms for a 120 Hz phone**, using the 4× profile.

    Compare the probes' p50, p95 and p99, and the traced run's main-thread scripting, style and layout, paint, and GPU time, against them.

- A vsync-locked frame interval hides every cost under one frame. At 60 Hz every cell reads 16.7 ms until something takes over 16.7 ms.
- Chromium's `--limit-fps` and `--force-display-refresh-rate` do nothing: rAF still runs at the monitor's rate.
- To emulate a slower display, set `hz` to 60 or 120. The gate runs animation frames on every nth vsync; check that the frame interval p50 reads 16.7 or 8.3 ms.
- To measure at the monitor's rate, set `hz: "native"`. The browser window must be on that monitor; check that the interval p50 reads 4.2 ms on a 240 Hz display.

### The phone stand-in

- The `phone` profile is 390×844 at DPR 3, with touch, `isMobile` and a **4× CDP CPU throttle**.
- The throttle slows the CPU only. GPU costs at DPR 3 are not scaled, so a real phone can be slower on fill rate than these runs show.
- Use touch scenarios on it (`quicktouch`, `flick`, `minimapdrag`): wheel and keys are not phone input.

### Runs, cold and warm, and the two axes

- **Warm up first.** The first run over a region compiles chart sections and atlases. It is kept as `cold`, because a user's first pass looks like it, but medians come from the repeats that follow.
- Repeat each cell at least 5 times (3 for long playback). Report the median of the per-run statistics with their range.
- **Keep two axes apart:**
    - **Average cost:** the steady per-frame work, p50 and p95 against the budget. It decides the sustained frame rate.
    - **Stutters and unevenness:**
        - the tail: p99, max, and the counts over budget, over 2× and over 4×;
        - jitter: the interval SD, and the share of neighbouring frames that differ by more than 0.9 of a frame;
        - each spike tied to its trace event with `perf:report … long`.

        One 400 ms frame every 45 s barely moves a median and is what a user remembers.
- Spikes that recur on a timer show up in any scenario long enough to meet them: background writes and garbage collection. When a max jumps in one run of five, look for them before blaming the scenario.

### Tracing

- The traced run is extra and is used for attribution only. Tracing with the CPU profiler adds about **1.5×** to main-thread time and stalls about 1 s when it starts (before the run's window).
- Categories: `devtools.timeline`, `disabled-by-default-devtools.timeline` and its `.frame` and `.stack`, `disabled-by-default-v8.cpu_profiler`, `v8.execute`, `v8`, `disabled-by-default-v8.gc`, `blink.user_timing`, `blink`, `gpu`, `viz`, `cc`, `benchmark`, `latencyInfo`, `input`, `toplevel`, `loading`.
- A `nse-perf-sync` user-timing mark ties the page clock to the trace clock, so `perf:report … work` reads exactly the frames the run measured.
- Profile frames for native calls (a DOM setter, a GL call, `clearTimeout`) are shown with their script caller; their exact attribution is approximate.
- Chrome's own `PipelineReporter` states (`STATE_DROPPED`) refer to the compositor's rate, not the gated rAF rate. Do not use them under a gate.

### Where the processes run

- On a machine with several core complexes (CCDs), the scheduler moves threads between them, so timings drift from run to run.
- Pin every process of the run to one CCD at a raised priority:
    - the Node harness;
    - the preview server;
    - the browser and all its children.
- `--affinity <hex mask>` does this on Windows. It pins the harness first, so the browser inherits the affinity, and re-applies the priority (`--priority`, default AboveNormal) after launch and after every cell. Each record's `offPin` counts processes that left the set.
- Example: a Ryzen 9 9950X3D has two CCDs. CCD0 (logical processors 0–15) carries the 3D V-cache and CCD1 (16–31) the higher clocks, so runs use `--affinity 0xFFFF0000`.
- Run analysis and everything else on the other CCD, and run one measurement at a time with nothing else busy.
- Name the run's folders and command lines so a priority watcher can exempt them. Ours exempts anything with `nse-perf` in its command line.

### Charts

- **The densest charts, fully zoomed out (`pps` 100, the minimum), in Composed, show the most.** At that zoom many more notes, names, labels and stage slices are on screen at once. Also measure the default zoom (`pps` 1000) for comparison, and Basic.
- `tests/fixtures/generated-large.json`: in the repo, about coconut's size.
- `test_level_data/coconut-next-sekai-24887.json`: coconut, 1,679 notes; local only.
- The stress chart: `npm run perf:stress -- <level.json> <out.json> [copies] [offset]`. It repeats a level's notes, connectors and sim lines (8 copies, 400 beats apart, by default). Events and stages are not repeated, so it stresses chart size, not local density.
- Real charts are not committed. They are in the engine repo's level cache, `sonolus-next-sekai-engine/.cache/next-sekai/`:
    - each level's `resources/levels/<id>/data` (gzip) and `bgm`;
    - or `repository/<hash>`, where the hash is `item.data.hash` in `metadata/levels/<id>.json`.

    Gunzip the data to a `.json` outside the repo and point the plan at it. Useful ones:

| Level id                 | Title         | Notes       | Connectors | Length | Lanes | Stages | Time-scale changes |
| ------------------------ | ------------- | ----------- | ---------- | ------ | ----- | ------ | ------------------ |
| coconut-next-sekai-21888 | 画脂鏤氷      | 11,302      | 5,340      | 200 s  | ±21   | 15     | 1,647              |
| coconut-next-sekai-23792 | Phony [Sekai] | about 8,600 | 4,079      | 146 s  | ±200  | 46     | 311                |
| coconut-next-sekai-16471 | BIKE          | about 5,200 | 2,567      | 103 s  | ±121  | 69     | 1,716              |
| coconut-next-sekai-21506 | Brain Rot     | 1,257       | 483        | 136 s  | ±120  | 31     | 107                |

Note counts are the editor's where known, else level data's.

## Baseline

Commit `8fabd64e`, 2026-10-24. Machine: Ryzen 9 9950X3D pinned to CCD1 at AboveNormal, RTX 5090 (ANGLE D3D11), Chromium 153, 239 Hz display.

Each row gives the median over runs, in ms per frame: the chart draw, then the clock frame, as p50/p95 (max).

| Case                                                       | Chart draw     | Clock frame | Against the budget                  |
| ---------------------------------------------------------- | -------------- | ----------- | ----------------------------------- |
| Desktop, coconut, Basic, any scroll                        | 0.5/0.8        | 0.8/1.3     | pass                                |
| Desktop, coconut, Composed, Page Up held                   | 1.0/8.2 (21.6) | 1.3/8.3     | miss: stage surface every frame     |
| Desktop, coconut, Composed flick                           | 0.6/8.5 (19.5) | 0.8/8.8     | miss at p95: stage windows          |
| Desktop, 21888 zoomed out, Composed wheel (239 Hz)         | 1.9/3.0 (12.1) | 2.4/3.7     | pass on average                     |
| Desktop, 21888 zoomed out, Composed playback (239 Hz)      | 0.8/1.7        | 4.1/7.8     | miss: 24% of frames late            |
| Desktop, coconut ×8, playback                              | 0.5/0.9        | 6.5/9.7     | miss: preview 5.4/8.3               |
| Phone 4×, coconut, Composed flick                          | 1.6/5.1 (35.5) | 2.2/5.7     | spikes of 35–75 ms                  |
| Phone 4×, 21888 zoomed out, Composed quick-scroll (120 Hz) | 6.6/9.2        | 6.6/9.0     | miss at p95                         |
| Phone 4×, 21888 zoomed out, playback (120 Hz)              | 2.8/4.8        | 17.5/25.3   | miss: preview about 14              |
| Phone 4×, coconut ×8, playback                             | 2.4/5.2        | 33.8/47.9   | miss: about 25 fps                  |
| Phone 4×, Brain Rot, Composed flick (120 Hz)               | 2.2/13.2 (82)  | 2.8/8.7     | tail: 7 frames over 4× budget a run |

The minimap painted nothing in any scroll or playback frame. Its overlay costs 0.004 ms per frame on desktop and 0.014 ms at 4×.

Recurring spikes, with the trace events behind them:

- **Pixi's GC pass:** `GCSystem.run` every 30 s. 30 ms at 1×, 150 ms at 4×.
- **V8 major GC under the preview's per-frame allocations:** 13–19 ms at 1×, 108–134 ms at 4×.
- **First-visit section compiles:** `notes.ts` `prepareSections` and `vectorRanges.ts` `captureVectors`. 20–45 ms at 4×.
