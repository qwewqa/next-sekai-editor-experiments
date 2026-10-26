# Usage statistics

The web editor sends usage statistics to a self-hosted Umami server: which tools people use, the main settings, file types and sizes, and how long actions take. This page is for maintainers. The privacy page (`privacy/index.html`) tells users what is sent, and `infra/stats/README.md` covers the server.

The code is in `src/analytics/`:

- `tally.ts`: the counters and the input that arms a visit. It is in the main bundle, and it is the only analytics code that the edit and command paths call.
- `catalogue.ts`: every event and the values each property may take, with the functions that turn numbers into ranges.
- `config.ts`: the rule that decides whether a page sends.
- `start.ts`: starts and stops the client, and follows the switch in this tab and in other tabs.
- `client.ts` and `sender.ts`: loaded after startup, only when statistics are on. They build the events and send them.

## No effect on the user

Usage statistics must never make the editor worse to use. These rules hold for every change here:

- **No UI** but the switch in Settings › About and the note under it. No notice, prompt or console output in any state.
- **Nothing per frame.** No code in a frame callback, the clock or the draw paths. The lint forbids importing `src/analytics/` from `src/frame.ts`, `src/rendering/` and `src/preview/engine/`.
- **O(1) on the edit, flush, Save and startup paths.** A hook is one `bump` or `bumpCommand`: a `Map` increment behind one boolean, with no await or I/O.
- **The client loads after startup.** It loads once startup has ended, with the session open or with the gate's error, and the page is idle.
- **Few, small requests.** At most one in flight and one a minute while the page is open, each at most 32 KB, and 30 a visit.
- **No retries.** Nothing is sent while offline, and nothing more that visit after one failed request. A page that asks to save data sends nothing.
- **Bounded memory:** at most 1,000 counters (900 of them `usage`), 50 queued events and 32 KB.
- **Silent failure.** A blocked, offline, failing or hanging endpoint, or a client chunk gone after a deploy, shows nothing and holds nothing up.
- **No storage.** No IndexedDB, Cache Storage or quota. The only stored value is the switch's setting. The lint keeps `src/analytics/` away from the notice, dialog and storage modules. Only `status.ts` may import the local-data modules, and only to read.
- **Opt-out at once.** Turning the switch off drops the queue and the counters, and nothing more is sent, even when the page closes. Other open tabs stop too. Reset Settings… keeps the choice.
- **The data paths are never touched.** The client reads what the flows already know. It never calls a storage, Save or History function.

A change that adds work to a hot path is measured with the perf tools, with statistics on and off (`docs/performance-testing.md`).

## Engaged visits only

Nothing is sent from a visit, not even the pageview, until its first trusted `pointerdown`, `keydown`, `touchstart` or `wheel` while the page is visible. One passive listener waits for it and is removed once the visit is armed. Events measured before then wait in memory with the time they were captured. A visit that never arms sends nothing. So Umami's pageviews count visits where someone used the editor.

The startup gate blocks input until the session is open, so input during startup does not arm a visit. When startup ends in an error, the client loads all the same, because a failed startup is the signal that matters most. The gate still blocks keys and clicks outside itself, so only a click on the error page's own buttons or text arms the visit, and then the `startup` event reports the failure. In safe mode nothing is sent.

## The hooks

A hook is one call into `tally.ts`, or a read by the client. Nothing else on a hot path may call analytics.

| Where | What |
| --- | --- |
| `runCommand(command, source)` | `bumpCommand` by the built-in name (`editor/commands/names.ts`) and the source its caller names; a refusal while peeking is `features.peekRefused`. A command added by `registerCommand` has no name and is not counted |
| `onHistoryAction` | The client's listener bumps by operation id |
| `notify`, `recordDiagnostic` | `notices.<severity>`, `errors.<kind>` |
| `finishStartup`, `failStartup` | `markStartup`: the time, the outcome, and whether the page was ever hidden |
| `local/start.ts` | `note('reload')` when the tab's claim is its own reload |
| Open, Save, Export, Check, Choose Audio | `record` with the raw size and the time since the last picker or dialog closed. Save and Export add `buildMs`, read from the clock on either side of the build await that already exists in their flows (`runBuild` and the Recent Sessions Save… build, and the `build` wrapper in `exportLevel/flow.ts`). No hook adds an await. Check adds `scope` and `size` from the plan it already holds. All but Export also call `busy` while they run, as Restore does, for the long-frame split. A Save-family action ends in `afterOutcome`, an Open in `open/report.ts` |
| `peekEntry`, `restoreEntry`, the History dialog and panel, Recent Sessions, Delete Sessions…, the minimap, autoscroll, Quick Switch | `features.<name>` and `peekShown` |
| `history/index.ts`, `editor/save/report.ts` | `chartChanged` after a file is opened, a stored session is shown, and after a Save; the client counts the chart in an idle callback; while playback runs it schedules nothing, and the count waits until playback stops |
| The preview worker host | `record('preview', …)` when the worker fails and the main thread takes over |
| The editor canvas | `note('graphicsUnavailable')` when its renderer fails |

The client reads the rest: the settings (`snapshot.ts`), the load events, the storage status and the pressure runs (`status.ts`), the playing state and the observers (`field.ts`). A `source` is where the press came from. Two choices to know: the key presses inside the History lists are `key`, and an Open of a project file is `restore` in `chart`, because it shows a stored session.

## When it sends

- The first send is at the first hide, or a minute after the visit is armed if the page is still visible.
- Later sends are at each hide, at most one a minute, and at `pagehide` whatever the minute rule says.
- While the page is open it sends with `fetch` and `keepalive`. At `pagehide` it uses `sendBeacon`. Both send `text/plain`, so there is no preflight.
- It never listens for `unload` or `beforeunload`, which would cost the page its back-forward cache.
- Each event carries `timestamp`, the Unix seconds when it was captured. Umami would otherwise date it when the request arrives.

## Who sends

`config.ts` decides. A page sends only when all of these hold:

- the build has a target (below);
- the switch is on: the user's choice, or, before they choose, on unless the browser sends Do Not Track or Global Privacy Control;
- safe mode is off, and the browser does not ask to save data;
- the browser is not automated (`navigator.webdriver`), unless a dev build's test key or a loopback origin points it at a mock;
- the page is on its site's host (`nse.qwewqa.dev` or `test.nse.qwewqa.dev`) or on this machine, so a copy of the files hosted elsewhere sends nothing.

The switch appears only in a build with a target. Reset Settings… skips it, and its hint says so in those builds.

## Privacy rules

1. No chart content, file names, level info, titles, free text, paths, URLs with a query or hash, and no ids that link visits.
2. Only fixed values, booleans, ranges, use counts capped at 9999, action times in whole milliseconds capped at ten minutes (600000), times in whole seconds capped at a day (86400), the Undo window's step count (at most 1,000), and the screen size in Umami's usual form.
3. The client creates, stores and sends no identifier. Umami's daily session hash is the only grouping.
4. Nothing is sent before the setting and the browser's signals are read, and nothing at all when the result is off.

How the code enforces them:

- `record` takes only the types the catalogue gives. A range is a branded type that only `bucket` makes.
- The client checks every event against the catalogue before it queues it, and drops one that fails.
- The lint forbids `src/analytics/` from importing the level info, file names and the document title.
- A unit test (`tests/editor/analyticsPrivacy.test.ts`) maps every property to a category, and each category to the words of its line on the privacy page. A property the page does not cover fails it.
- A browser spec saves a chart whose title, artist and file name contain a canary, and fails if any request contains it, or any key outside the catalogue.

## What the server keeps

- **Raw records** (events, their data, sessions and what hangs off them) are kept 13 months. The nightly job deletes older ones (`infra/stats/host/retention.sql`). A session goes once none of its events remain. Backups on AWS expire after about five weeks, and a dump or download left on the host is deleted after two days, so no copy outlives those limits by much.
- **Monthly totals** are kept with no time limit, in `nse_monthly`, a table of ours in the Umami database. The job adds a month’s rows once the month is complete, before it deletes any raw record of that month, and a failure in that step deletes nothing. They hold no session or visit code, only counts, sums and percentiles:
    - visits and sessions a month, each by version, browser, OS, device class, country and language, one dimension at a time;
    - events by name, and by property value for the flags and fixed choices;
    - the total and count of the numeric properties, such as use counts;
    - p50, p90 and p99 of the millisecond timings (`ready`, `took`, `buildMs`), over all visits and by version and device class. This is the one cross.
- A new numeric property that is a time in milliseconds is a timing: add it to the two lists in `retention.sql`. A unit test checks them against the catalogue. A new event or property needs nothing else, because the totals read whatever the catalogue lets through.
- The runbook (`infra/stats/README.md`) has the details, and `queries/monthly.sql` reads the totals.

## The catalogue

`catalogue.ts` is the source; a unit test keeps this table in step with it. A property written `found.<kind>` stands for one property per value. "At hide" means the event goes with each send and carries the counts since the last one.

| Event | When | Properties |
| --- | --- | --- |
| (pageview) | client start | `url` (always `/`), `title` (empty), `hostname`, `language`, `screen`, `referrer` (another site's origin only) |
| `visit` | client start | `version`, `site`, `os`, `engine`, `standalone`, `touch`, `viewport`, `viewportPortrait`, `dpr`, `cores`, `deviceMemory`, `browserLanguage`, `returning`, `updated` |
| `settings` | client start | `theme`, `themeShown`, `locale`, `previewInWorker`, `previewRenderScale`, `previewAntialias`, `previewShowHitboxes`, `previewNoteSpeed`, `previewAssets.<type>`, `showPreview`, `previewPosition`, `showMinimap`, `showHistory`, `historyPosition`, `dimUnchangedObjects`, `waveform`, `beatDisplay`, `toolbarQuickSwitch`, `toolbarCustomized`, `mouseSecondaryTool`, `playFollow`, `touchQuickScrollShow`, `touchLongPressContextMenu`, `confirmCloseUnsavedFile` |
| `startup` | client start | `start`, `outcome`, `ready`, `hidden`, `navigation`, `documentDelivery`, `wasDiscarded`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `found.<kind>` |
| `storage` | status known, on a change to paused or memory, and when the Recent Sessions count becomes known | `mode`, `reason`, `persisted`, `usage`, `quota`, `usageShare`, `cleanup`, `sessions` |
| `chart` | after Open, a restore and a Save | `trigger`, `notes`, `slides`, `bpms`, `timeScales`, `events`, `stages`, `groups`, `objects`, `dynamicStages`, `bgm`, `historySteps` |
| `preview` | client start if the preview is shown, and a handover | `host`, `reason`, `workerFrames`, `graphics` |
| `open` | each Open… | `format`, `via`, `size`, `outcome`, `reason`, `took`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `save` | each Save, Save As…, Download Again and Recent Sessions' Save… | `action`, `target`, `history`, `bgm`, `size`, `took`, `buildMs`, `outcome`, `reason`, `step`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `export` | each Export | `format`, `target`, `size`, `took`, `buildMs`, `outcome`, `reason`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `check` | each Check File and History | `outcome`, `took`, `scope`, `size`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `bgm` | each BGM chosen | `format`, `size`, `length`, `took`, `outcome`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `usage` | at hide | `<command>.<source>` |
| `edits` | at hide | `<operation>`, `undo`, `redo` |
| `features` | at hide | `historyPanel`, `historyDialog`, `recentTab`, `peek`, `peekRefused`, `restore`, `restoreSession`, `restoreCopy`, `saveRowToFile`, `deleteSessions`, `minimapDrag`, `minimapJump`, `autoscroll`, `quickSwitch` |
| `notices` | at hide | `info`, `warning`, `error` |
| `peek` | at hide, only when there were peeks | `peek.<time>`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `perf` | at hide | `loafSupported`, `eventTimingSupported`, `frames.<state>.<length>`, `frames.unclassified`, `frameAttribution`, `slowEvents.<length>`, `interactions`, `playSeconds`, `visibleTime`, `previewHost`, `previewRenderScale`, `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` |
| `errors` | at hide | `error`, `csp` |
| `unsupported` | the support page, on its first input | `engine` |

The device details (`cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`) go on each measured event, so a figure is read against the device that made it. The per-action events (`open`, `save`, `export`, `check`, `bgm`) take them when the action is recorded (`tally.record` calls the reader that the client installs), so a resize before the send does not relabel them; `peek` and `perf` cover an interval and take them when they are sent. `storage.mode` is `stored`, `readOnly` or `memory`; the client does not guess a private window. `viewport` is the workspace's width, and `viewportPortrait` on `visit` says whether its height is greater. `deviceMemory` is the browser's rounded figure in GiB, `16+` above 16 and `other` for a value that is not a power of two; it is absent where the browser reports none.

Scales (`src/analytics/scales.ts`) use half-open `[lower, upper)` ranges, except where a label names an exact value (`dpr` `1`, `2` and `3`, `noteSpeed` `10`) and `usageShare`, whose `70-80` includes exactly 80 because cleanup starts only above 80% (`HIGH_SHARE`). A missing, non-finite or negative measurement is left out. Chart counts are exact from 0 to 9, then ten ranges a decade, such as `250-319`, up to `100000+`. Audio length is in seconds from `<10`, and file sizes double from `<16K` to `16G+`.

`took` is the action's time in whole milliseconds, at most 600000, which means 600000 or more. `ready` is the same. `buildMs` is the part of a Save or Export spent building the file. `took` begins after the last picker or dialog closes. A Save or Export that builds before its picker opens leaves the build out of `took`, and `buildMs` still reports it. `startup.ready` is left out for a hidden or failed start, and `hidden` says whether the page was hidden before startup ended.

`startup.navigation` is the navigation type, and `documentDelivery` is a guess from the navigation timing entry: `serviceWorker` when a worker started for the load, `cache` when the browser says so or the document had a body and no transfer, else `network`, and `unknown` when the entry is missing or unclear. A cached document does not mean the scripts or stored data were warm. `wasDiscarded` is sent where the browser has the property.

`chart.objects` is the sum of the raw counts of notes, time scales, animation event joints, BPM entries, stages and groups, ranged once. It leaves out slides, which are sets of notes already counted. `chart.historySteps` is the size of the Undo window, at most 1,000 steps (`STACK_CAP`), not the length of the Timeline. The counts and the file sizes are each ranged, but together they can sometimes match a chart that has been published. `chart.bgm` says only whether the chart has music (`none` or `some`); the length is in the `bgm` event.

`storage.usageShare` is the usage as a percent of the quota, from the same estimate, and is left out without a positive quota. `cleanup` is the latest cleanup run seen: `notRun`, `busy`, `noSpaceFreed` or `freed`.

`check.scope` is `fileAndStored` when the run read the bound file, else `stored`. `check.size` is that file's size, and is left out for `stored`.

`playSeconds` and `visibleTime` measure the time since the previous send in whole seconds, capped at a day (86400) per event. `playSeconds` counts playback only while the page is visible. The part of a second left over stays for the next send. Other durations and sizes use ranges.

`peek.<time>` is the time from the start of the load, after the debounce, until the step shows with its change. Up to 100 ms of it is the wait for the change. A step whose state comes from the cache is counted as `cached` and not timed. The `peek` event is sent with `perf`, and only when there were peeks.

`perf` reports the long frames (`frames.<state>.<length>`, from the Long Animation Frames API) and slow events (`slowEvents.<length>`, Event Timing from 104 ms, which is its 8 ms rounding of 100 ms). Each long frame is sorted by the state it began in: `playing` is visible playback, `busy` is an Open, Save, Check, Restore or BGM load, and `other` is the rest. The client keeps a short list of the times these states changed (`intervals.ts`: at most 64 changes, trimmed as entries arrive), with no polling. A frame that the list no longer covers is counted in `frames.unclassified` and sets `frameAttribution` to `partial` for that send. `loafSupported` and `eventTimingSupported` say whether the browser has each API. `interactions` is the browser's own count, and is left out where it has none.

`previewHost` and `previewRenderScale` hold the value for the whole interval since the last send, `mixed` if it changed, and `none` for the host when the preview was not shown. Both follow synchronous watchers on change, not a frame callback, so a change that comes back within one tick still gives `mixed`.

The Recent Sessions count (`sessions`) is known only after the History tab has read its list. If the first `storage` event went without it, one more goes when the count becomes known. The client reads no storage of its own for it.

`unsupported` is sent by `public/gate.js`, not by the client, when the support gate stops the editor. The build puts the target in a tag on the editor's page, `<meta name="nse-analytics" content="ORIGIN WEBSITE HOST">`, and only in a build with a target; `check:release` compares it with the manifest. The page sends one beacon on its first trusted input while visible, under the same rules as the client (a signal, an off switch, an automated browser, a request to save data, another host).

Umami's own visit counts, durations and bounce rates are wrong for this client. Without a preflight it cannot send Umami's cache header, so a visit that crosses an hour splits. Count visits from the pageviews, and time from `visibleTime` (seconds).

## Adding an event or a property

1. Add it to `catalogue.ts`, with a closed set of values or a range, and to the table above.
2. Hook it with one `bump`, `bumpCommand` or `record` at the place that already knows the value. Never compute something on a hot path for it.
3. Extend the unit tests, and the browser spec if it adds a request or a new kind of value. A renamed or removed property also changes `infra/stats/scripts/contract-events.json` and the saved queries in `infra/stats/queries/` that read it. Infra check runs them.
4. Map it to a category in `tests/editor/analyticsPrivacy.test.ts`. If it is a new kind of data, add a line to the privacy page, give it a category, and change the page's date.
5. Add a CHANGELOG line.

## Build variables

| Variable | Meaning |
| --- | --- |
| `NSE_ANALYTICS_ORIGIN` | The server's origin, such as `https://stats.nse-services.qwewqa.dev` |
| `NSE_ANALYTICS_WEBSITE` | Umami's website id, a UUID |

With neither set, the build has no target and no client chunk, and the switch is hidden. Half a pair, a malformed value, any target in the apps' build, and a perf build's target that is not on this machine all fail the build. The origin goes into the page's `connect-src`, its only cross-origin source.

- **Releases:** `deploy-pages.yml` sets them on a version tag only, from the repository variables `ANALYTICS_ORIGIN` and `ANALYTICS_WEBSITE_PRODUCTION`. The test site's workflow sets its own website id. `check:release` compares the manifest's `analytics` field with the variables, checks that the bundle names that origin and id, and checks that a build without them has no client.
- **Dev builds** send nothing unless both variables are set on purpose, for example to a local Umami.
- **Browser specs** run on a dev server with no variables. A spec points the statistics at a Playwright route with the test key `nse.test.analytics`, a JSON `{ "origin", "website" }` that only dev builds read. No spec request leaves the machine.
- **Production specs** run on a release build. `navigator.webdriver` keeps them silent.
