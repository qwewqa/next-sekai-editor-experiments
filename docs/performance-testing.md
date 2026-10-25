# Performance testing

How to measure scrolling and preview playback so the numbers mean something, with the tools in `scripts/perf/`. The tools drive a perf build in headed Chromium, time every frame, and trace a run so the time can be attributed to source functions. Most of this page is what works and what misleads.

## Quick start

```sh
npm run perf -- scripts/perf/plans/smoke.json --name smoke --affinity 0xFFFF0000
npm run perf:report -- perf-results/smoke frames
npm run perf:report -- perf-results/smoke work
npm run perf:report -- perf-results/smoke long perf-results/smoke/traces/<cell>.json.gz 16
```

`scripts/perf/plans/full.json` is the full plan: every scenario below on coconut, the real charts and the stress chart, on the desktop and the phone stand-in. Its charts are read from `perf-results/data/` (see "Charts"), and a full run takes hours.

`npm run perf` runs these steps:

1. It builds with `NSE_PERF=1` and sourcemaps into `perf-results/dist`.
2. It serves that build with `vite preview` on port 5360.
3. It runs each plan group in a fresh headed Chromium profile.
4. It writes `perf-results/<name>/`:
    - `results.jsonl`, one record per cell;
    - `log.txt`;
    - a screenshot per cell;
    - `traces/*.json.gz`, to open in DevTools' Performance panel.

`perf-results/` is ignored by git.

Each run in a record has `startedAt` and `endedAt` (to compare with a load log) and `pathCache`, per canvas: the path cache's counters over the run (`hits`; builds, as `native` and `fallback`; `evictions`; and `trimmed` and `trimmedBytes`, the evictions that made room in its budget), and its resident `bytes` and `pinned` bytes at the end. `memory` snapshots record the same as `pathCaches`.

`npm run perf:report` reads a run: `frames`, `work` and `long` as above, and for the scenarios that mark moments (`traceEach` cells):

- `tasks`: the tasks over a threshold after each mark, with what ran in them;
- `idle`: counts of tasks, callbacks, timers and frames in an idle trace;
- `edit`: the cost of each edit, undo, drop and hide, and the work that follows it;
- `callers` and `inside` (full traces): the chains above, and the `src/` code below, a function matching a pattern;
- `heap`: a `memory` run's sampled live bytes, or an `allocProfile` run's sampled allocations, by module and allocator.

Options:

- `--no-build` reuses the last build.
- `--url` measures a server you started yourself, such as the dev server. The dev server needs `NSE_PERF=1` too.
- `--affinity` and `--priority` pin the run (see "Where the processes run").
- `--preview-host main` or `worker` sets the host that draws the preview (`docs/rendering.md`), whatever the setting says; a group's `previewHost` sets it for one group. Without either, the host follows Settings › Preview › Parallel Rendering. Each record's `info.previewHost` names the host that drew.

## The probes

A perf build (`NSE_PERF=1`, the `__NSE_PERF__` define) adds two things:

- `window.nsePerf`, the harness's handle on the view, settings, state, player and minimap stats (`src/perf/hook.ts`). It also has `selectNear(time, count)` to select the plain notes nearest a time and return their screen points, `chartEnd()` for the last entity's time, and `pathCaches()` for the chart and overlay canvases' path-cache counters and resident bytes.
- Per-frame timings (`src/perf/probe.ts`):
    - `chartDraw` and `overlayDraw`: the chart's frame callbacks;
    - `clockFrame`: the app clock's whole frame, with the time watchers, Vue's flush and the draws it triggers. The clock runs only while something moves through it (eases, inertia, playback, a tool drag), so direct scrolls such as `quicktouch` and `minimapdrag` have few or no clock frames: compare their `chartDraw` and frame intervals;
    - `previewDraw`, `elevationDraw` and `minimapOverlay`. In the worker host, `previewDraw` is the main thread's part of a frame: resolving the state, building the chart's diff and posting the frame;
    - the worker host's `previewWorkerDraw`, the worker's draw with any rebuild, and `previewWorkerAnswer`, the time from posting a frame until the worker's `drawn` message arrives. `previewReplaced` counts the frames that a newer request replaced before they were sent. `perf:report … frames` gives the worker's frames per second beside the clock's;
    - `stageTile`: each Composed stage tile build. `perf:report … frames` gives the builds per chart draw.

Other builds define the flag false: `timed` returns its callback, and the hook is never imported or bundled. Probes collect only while a run has switched them on.

## The preview in Node

`npm run perf:preview -- <level.json> --start 15 --seconds 9` draws the preview's frames in Node with the real skin and particles, and a renderer that does the real one's CPU work: the vertices, the layer sort and the pack. It prints the per-frame times and the heaviest seconds. Start a plan's playback cells there.

`--digest` adds a hash of every draw, and of paused frames with everything selected. A change that should draw exactly the same must leave the digest unchanged on several charts and windows. To compare with another commit, unpack its `src/` under `perf-results/` (`git archive <commit> src`) and pass it as `--src`. Hashing slows the frames, so take times from a run without `--digest`.

## Plans

A plan is JSON (see `scripts/perf/plans/example.json`): `defaults` for every cell, then `groups`. Each group has:

- `id`;
- `profile`: `desktop1600`, `desktop1280`, `desktop1280x4`, `phone`, or an object with `viewport`, `deviceScaleFactor`, `hasTouch`, `isMobile` and `throttle`;
- `hz`: `"native"`, or 60 or 120 for the frame gate;
- `chart`: a level data path from the editor root;
- optional `bgm`;
- optional `settings`, app settings set before each cell, such as `{ "playFollow": false }`;
- optional `browserArgs`, extra Chromium flags such as `--js-flags=--no-allocation-site-pretenuring`;
- `cells`.

Each cell can set:

- `scenario`:
    - scrolling and playback: `wheel`, `trackpad`, `pagekeys`, `quicktouch`, `flick`, `minimapdrag`, `play1x`, `play2x`;
    - `resizedrag`, with `handle` (a separator's accessible name) and `dx`;
    - `idle`: nothing for `seconds` (5), with the process tree's CPU and memory before and after;
    - `notch`: one wheel notch after an 800 ms pause, then 1.2 s still. It marks `nse-notch`;
    - `editflip`: selects `count` (50) notes near the view, flips them with U, waits `wait` ms (2500), undoes, and waits again. It marks `nse-edit` and `nse-undo`;
    - `drag`: selects `count` notes, drags one of them `dx` px (60) over 1 s, waits `wait`, undoes, and waits again. It marks `nse-drag`, `nse-drop` and `nse-undo`;
    - `hide`: an edit of `count` (20) notes, then the page is hidden `after` ms (2000) later and shown again 2 s after that, then undone. It marks `nse-edit` and `nse-hide`. The hide is simulated (see the pitfalls), and the record has `hiddenMs`, the time the page's own listeners took;
    - `journal`: an edit, then scrolling back and forth for `seconds` (22) with a second edit halfway, across the 10 s journal ticks. Pair it with a group's `storage` flag;
    - `edits`: selects `count` (50) notes near the view, then flips, undoes, redoes, deletes, undoes, copies, pastes (hovering the pasted notes for 1 s before placing them) and undoes, `wait` ms (1500) apart. Each step is marked (`nse-flip`, `nse-paste` and so on);
    - preview interactions: `scrub`, a 3 s drag back and forth across the preview; `seek`, a tap on the step button named `button` (for example `Forward 100 ms`) every 120 ms for 3 s; `cursorjumps`, the cursor moved to a new time every 120 ms for 3 s; `notespeed`, the note speed changed every frame for 2 s, as a slider drag does; `reopen`, the chart opened again over itself, marked `nse-open` and `nse-opened`;
    - `heaps`: the main thread's heap and each worker's heap after a forced GC, when the chart has opened and again after `seconds` (60) of playback. Each worker's heap is read through its own CDP session;
    - `memory`: one long run that records the JS heap and DOM counts after a forced GC at each stage: opened, after sweeps of the whole chart at several zooms and layouts, after `seconds` (200) of playback at `speed` (1, 1.5 or 2) sampled every `sampleEvery` s (40, without GC), after New, after Open again, and after one more sweep. It writes `heap-<stage>.json` sampling profiles to the run folder (read them with `perf:report … heap`) and records the process tree's memory at each stage;
- `layout`;
- `minimap`, `preview`, `elevation` (beside the chart) and `selection` (every note and connector);
- `pps` (100 is fully zoomed out);
- `start`;
- `seconds` and `speed` for playback;
- `reps` and `warmup`;
- `trace`, `traceCold` and `traceEach` (a light trace of every repeat, see "Tracing");
- `noLoop`: the collector does not request frames. Use it with `idle`;
- `settings`: app settings for this cell, applied after the group's. They stay set for the group's later cells;
- `allocProfile`: sample allocations, every `allocInterval` bytes (32,768), over each untraced run, into `alloc-<cell>-<n>.json`;
- `keepRaw`: keep the raw probe samples, long tasks and long animation frames in the record;
- `tag`.

A group can set `storage`, an object written to the `nse.test.storage` test key before the app starts, for example `{ "noStorage": true }` for a browser without storage. A group's own `defaults` override the plan's.

## What works, and what misleads

### Build and browser

- **Measure a production build with sourcemaps.** Vue's dev mode and unbundled modules change the timings.
    - The sourcemaps let `trace.mjs` turn minified frames back into `src/...:line`.
    - Use the dev server only to compare.
- **Run headed with the real GPU.** Headless Chromium can fall back to SwiftShader, and then every chart number is meaningless.
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

        One 400 ms frame a minute barely moves a median and is what a user remembers.
- Spikes that recur on a timer show up in any scenario long enough to meet them: garbage collection passes and the storage journal. When a max jumps in one run of five, look for them before blaming the scenario (see "Known costs").
- **Dense cells vary 2 to 3 times between runs**, even pinned. Use medians of at least 5, and do not read a smaller difference as real.

### Tracing

- The traced run is extra and is used for attribution only. Tracing with the CPU profiler adds about **1.5×** to main-thread time and stalls about 1 s when it starts (before the run's window).
- **Light traces** (`traceEach`) leave out the CPU profiler: they record task timings (`devtools.timeline`, `v8.execute`, GC, user timing, `gpu`, `viz`, `toplevel`), so tasks cost what they cost. Use them for what happens around a mark and for counts, and a full trace for attributing time to functions. `perf:report … tasks`, `idle` and `edit` read them; `callers`, `inside`, `heap` and `long` need a full trace or a heap profile.
- A trace over 512 MB (native-rate playback) cannot be parsed as one string. `trace.mjs` reads it line by line.
- Categories of a full trace: `devtools.timeline`, `disabled-by-default-devtools.timeline` and its `.frame` and `.stack`, `disabled-by-default-v8.cpu_profiler`, `v8.execute`, `v8`, `disabled-by-default-v8.gc`, `blink.user_timing`, `blink`, `gpu`, `viz`, `cc`, `benchmark`, `latencyInfo`, `input`, `toplevel`, `loading`.
- A `nse-perf-sync` user-timing mark ties the page clock to the trace clock, so `perf:report … work` reads exactly the frames the run measured.
- Profile frames for native calls (a DOM setter, a GL call, `clearTimeout`) are shown with their script caller; their exact attribution is approximate.
- `(program)` is 30 to 45% of the CPU profile's samples. It is time outside JavaScript, so read the other rows against the rest, not against 100%.
- CPU time at 4× is meaningless: the throttle changes how long JavaScript takes, not what the compositor, GPU and other processes use. Compare scripting and main-thread time only.
- Chrome's own `PipelineReporter` states (`STATE_DROPPED`) refer to the compositor's rate, not the gated rAF rate. Do not use them under a gate.

### Scenario pitfalls

- **Playwright keeps a background tab visible.** `hide` therefore sets `document.visibilityState` to hidden and dispatches `visibilitychange`. This is the path the app's lifecycle handler takes. It does not test the browser's own page lifecycle. The harness adds its own first and last listeners, so `vis` in a kept record shows the order.
- **The idle collector loop requests frames.** `idle` without `noLoop` measures the collector, not the editor. The loop also keeps frames coming while the app clock is stopped, so a wake from idle, such as `notch`'s wheel, needs `noLoop` and `traceEach` to be measured as a user meets it.
- **The app's clock stops when nothing moves** (`docs/rendering.md`). An idle editor requests no animation frames, and over 60 s on the desktop profile its browser processes use 1–2.6% of a core. Idle CPU well above that means something keeps the clock or another frame loop running.
- **The gate's pump adds animation frames to counts.** Under `hz: 60` or `120`, animation frame counts include the gate's, so compare counts only within one `hz`.
- **`previewDraw` on an edit frame includes the preview's rebuild.** It is not the steady cost. In the worker host the rebuild is in `previewWorkerDraw`.
- **The worker host's frames reach the screen separately from the main thread's.** The worker's canvas is committed when the task that drew it ends. To see whether a worker frame and a main-thread frame reach the same display frame, read the `viz` events of a light trace.
- **Preview playback is cheapest at a chart's opening.** Dense passages cost 2–5 times more, so a playback cell for the preview should include them (`start`). `npm run perf:preview` prints the heaviest seconds.
- **Moving the cursor plays a moment of BGM**, and Chrome then animates its tab audio indicator. That adds about a second of browser frames that the app does not cause. The harness launches Chromium with `--mute-audio` for this reason.
- **The GC pass grows with the session.** Later in a session (`memory`, or after many cells in one group) it costs more than in a fresh one, because it walks every tracked resource. Compare cells from fresh groups.
- **The process tree** (`idle`, `memory`) is read with `scripts/perf/proc.ps1` on Windows: CPU seconds, working set, private bytes, and GPU dedicated and shared memory per process.

### Where the processes run

- On a machine with several core complexes (CCDs), the scheduler moves threads between them, so timings drift from run to run.
- Pin every process of the run to one CCD at a raised priority:
    - the Node harness;
    - the preview server;
    - the browser and all its children.
- `--affinity <hex mask>` does this on Windows. It pins the harness first, so the browser inherits the affinity, and re-applies the priority (`--priority`, default AboveNormal) after launch and after every cell. Each record's `offPin` counts processes that left the set.
- Example: a Ryzen 9 9950X3D has two CCDs. CCD0 (logical processors 0–15) carries the 3D V-cache and CCD1 (16–31) the higher clocks, so runs use `--affinity 0xFFFF0000`.
- Run analysis and everything else on the other CCD, and run one measurement at a time with nothing else busy.
- On a shared machine, check before each run that no other perf run is active (processes with `nse-perf` in their command line) and that both CCDs are quiet, and sample each CCD's load during the run. Run again any run that met other work: other tests at 100% on both CCDs doubled a playback run's clock p95. Bursts last minutes, so compare each run's `startedAt` and `endedAt` with the load log. Two runs waiting for a quiet machine can both see it in the same second, so check again a few seconds after the check passes.
- Name the run's folders and command lines so a priority watcher can exempt them. Ours exempts anything with `nse-perf` in its command line.

### Charts

- **The densest charts, fully zoomed out (`pps` 100, the minimum), in Composed, show the most.** At that zoom many more notes, names, labels and stage slices are on screen at once. Also measure the default zoom (`pps` 1000) for comparison, and Basic.
- `tests/fixtures/generated-large.json`: in the repo, about coconut's size.
- `test_level_data/coconut-next-sekai-24887.json`: coconut, 1,679 notes; local only.
- The stress chart: `npm run perf:stress -- <level.json> <out.json> [copies] [offset]`. It repeats a level's notes, connectors and sim lines (8 copies, 400 beats apart, by default). Events and stages are not repeated, so it stresses chart size, not local density.
- Real charts are not committed. They are in the engine repo's level cache, `sonolus-next-sekai-engine/.cache/next-sekai/`:
    - each level's `resources/levels/<id>/data` (gzip) and `bgm`;
    - or `repository/<hash>`, where the hash is `item.data.hash` in `metadata/levels/<id>.json`.

    Gunzip the data to a `.json` outside the repo or in the git-ignored `perf-results/`, and point the plan at it. Useful ones:

| Level id                 | Title         | Notes       | Connectors | Length | Lanes | Stages | Time-scale changes |
| ------------------------ | ------------- | ----------- | ---------- | ------ | ----- | ------ | ------------------ |
| coconut-next-sekai-21888 | 画脂鏤氷      | 11,302      | 5,340      | 200 s  | ±21   | 15     | 1,647              |
| coconut-next-sekai-23792 | Phony [Sekai] | about 8,600 | 4,079      | 146 s  | ±200  | 46     | 311                |
| coconut-next-sekai-16471 | BIKE          | about 5,200 | 2,567      | 103 s  | ±121  | 69     | 1,716              |
| coconut-next-sekai-21506 | Brain Rot     | 1,257       | 483        | 136 s  | ±120  | 31     | 107                |

Note counts are the editor's where known, else level data's.

`full.json` reads these from `perf-results/data/`:

- `coconut.json` and `coconut.mp3`: copies of `test_level_data/coconut-next-sekai-24887.json` and its `.bgm.mp3`;
- `real-<id>.json` for the four levels above (`real-21888.json`, `real-23792.json`, `real-16471.json`, `real-21506.json`), and `brainrot.mp3`, the `bgm` of `coconut-next-sekai-21506`;
- `stress-x8.json`: `npm run perf:stress -- perf-results/data/coconut.json perf-results/data/stress-x8.json`.

## Known costs

These recur, and a spike in a run is often one of them. Check them before blaming the scenario.

- **Pixi's GC pass** (`GCSystem.run`, then `runOnHash`) walks every tracked resource, so its cost grows with what is live: 2–8 ms early in a session and 10–20 ms later at 1×, 15–30 ms rising to 60 ms at 4×. It runs every 10 s (`GC_FREQUENCY`), at idle time and never inside a frame (`RenderingScheduler`, `docs/rendering.md`). In a trace it is an idle callback.
- **V8 major GCs** in long playback on dense charts take 15–40 ms, mostly to finish marking a 300–400 MB heap. Per-frame allocations in a draw path make them more frequent. Major GCs every second or so during playback can mean that a per-frame allocation site also builds long-lived data, so V8 allocates the site's objects in the old generation (`docs/rendering.md`). To check, count `MajorGC` events in light traces with and without the `browserArgs` value `--js-flags=--no-allocation-site-pretenuring`. In Node, `node --trace-gc --import tsx scripts/perf/preview.mjs …` prints each `Mark-Compact`.
- **First-visit section compiles** (`notes.ts` `prepareSections`, `vectorRanges.ts` `captureVectors`) take 20–45 ms at 4×. The idle compile ahead (`docs/rendering.md`) compiles sections near the view early, but a jump or the `cold` run still meets them. An idle capture can delay an input that lands in it, so measure a wake from a pause with `notch`.
- **Composed stage tile builds** are the cost in zoomed-out Composed flicks: at `pps` 100 one tile can hold over a thousand divider strokes. Check `stageTile`, and the builds per chart draw in `perf:report … frames`.
- **Path-cache churn.** A path built anew every frame and kept in the path cache fills its 128 MiB budget with geometry nothing draws again, and the grown maps and garbage then stall chart frames. A context's current path lasts one frame for this reason (`docs/rendering.md`). A record whose `pathCache` shows steady `trimmed` counts during playback has a new case of it.
- **The journal with storage unavailable** serializes and gzips the whole chart every 10 s while there are edits (`storing.ts`): 25 ms on coconut and 125 ms on ×8 at 1×, 110–635 ms at 4×. Its idle callback's 5 s timeout can land it in the middle of a scroll. Measure it with `journal` and a group's `storage` flag.
