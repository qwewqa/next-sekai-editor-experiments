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
- **Opt-out at once.** Turning the switch off drops the queue and the counters, and nothing more is sent, even when the page closes. Other open tabs stop too. Reset Settings keeps the choice.
- **The data paths are never touched.** The client reads what the flows already know. It never calls a storage, Save or History function.

A change that adds work to a hot path is measured with the perf tools, with statistics on and off (`docs/performance-testing.md`).

## Engaged visits only

Nothing is sent from a visit, not even the pageview, until its first trusted `pointerdown`, `keydown`, `touchstart` or `wheel` while the page is visible. One passive listener waits for it and is removed once the visit is armed. Events measured before then wait in memory with the time they were captured. A visit that never arms sends nothing. So Umami's pageviews count visits where someone used the editor.

The startup gate blocks input until the session is open, so input during startup does not arm a visit. When startup ends in an error, the client loads all the same, because a failed startup is the signal that matters most. The gate keeps swallowing keys and clicks outside itself, so only a click on the error page's own buttons or text arms the visit, and then the `startup` event reports the failure. Safe mode sends nothing, as for any page.

## The hooks

A hook is one call into `tally.ts`, or a read by the client. Nothing else on a hot path may call analytics.

| Where | What |
| --- | --- |
| `runCommand(command, source)` | `bumpCommand` by the built-in name (`editor/commands/names.ts`) and the source its caller names; a refusal while peeking is `features.peekRefused`. A command added by `registerCommand` has no name and is not counted |
| `onHistoryAction` | The client's listener bumps by operation id |
| `notify`, `recordDiagnostic` | `notices.<severity>`, `errors.<kind>` |
| `finishStartup`, `failStartup` | `markStartup`: the time, the outcome, and whether the page was ever hidden |
| `local/start.ts` | `note('reload')` when the tab's claim is its own reload |
| Open, Save, Export, Check, Choose Audio | `record` with the raw size and the time since the last picker or dialog closed; `busy` while they run, for the long-frame split. A Save-family action ends in `afterOutcome`, an Open in `open/report.ts` |
| `peekEntry`, `restoreEntry`, the History dialog and panel, Recent Sessions, Delete Sessions…, the minimap, Quick Switch | `features.<name>` and `peekShown` |
| `history/index.ts` | `chartChanged` after a file is opened, a stored session is shown, and after a Save; the client counts the chart in an idle callback; while playback runs it schedules nothing, and the count waits until playback stops |
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

The switch appears only in a build with a target. Reset Settings skips it, and its hint says so in those builds.

## Privacy rules

1. No chart content, file names, level info, titles, free text, paths, URLs with a query or hash, and no ids that link visits.
2. Only fixed values, booleans, ranges and use counts capped at 9999, plus the screen size in Umami's usual form.
3. The client creates, stores and sends no identifier. Umami's daily session hash is the only grouping.
4. Nothing is sent before the setting and the browser's signals are read, and nothing at all when the result is off.

How the code enforces them:

- `record` takes only the types the catalogue gives. A range is a branded type that only `bucket` makes.
- The client checks every event against the catalogue before it queues it, and drops one that fails.
- The lint forbids `src/analytics/` from importing the level info, file names and the document title.
- A unit test (`tests/editor/analyticsPrivacy.test.ts`) maps every property to a category, and each category to the words of its line on the privacy page. A property the page does not cover fails it.
- A browser spec saves a chart whose title, artist and file name contain a canary, and fails if any request contains it, or any key outside the catalogue.

## The catalogue

`catalogue.ts` is the source; a unit test keeps this table in step with it. A property written `found.<kind>` stands for one property per value. "At hide" means the event goes with each send and carries the counts since the last one.

| Event | When | Properties |
| --- | --- | --- |
| (pageview) | client start | `url` (always `/`), `title` (empty), `hostname`, `language`, `screen`, `referrer` (another site's origin only) |
| `visit` | client start | `version`, `site`, `os`, `engine`, `standalone`, `touch`, `viewport`, `dpr`, `browserLanguage`, `returning`, `updated` |
| `settings` | client start | `theme`, `themeShown`, `locale`, `previewInWorker`, `previewRenderScale`, `previewAntialias`, `previewShowHitboxes`, `previewNoteSpeed`, `previewAssets.<type>`, `showPreview`, `previewPosition`, `showMinimap`, `showHistory`, `historyPosition`, `dimUnchangedObjects`, `waveform`, `beatDisplay`, `toolbarQuickSwitch`, `toolbarCustomized`, `mouseSecondaryTool`, `playFollow`, `touchQuickScrollShow`, `touchLongPressContextMenu`, `confirmCloseUnsavedFile` |
| `startup` | client start | `start`, `outcome`, `ready`, `found.<kind>` |
| `storage` | status known, on a change to paused or memory, and when the Recent Sessions count becomes known | `mode`, `reason`, `persisted`, `usage`, `quota`, `cleanup`, `sessions` |
| `chart` | after Open, a restore and a Save | `trigger`, `notes`, `slides`, `bpms`, `timeScales`, `events`, `stages`, `groups`, `dynamicStages`, `bgm`, `historySteps` |
| `preview` | client start, when the preview is shown, and a handover | `host`, `reason`, `workerFrames`, `graphics` |
| `open` | each Open | `format`, `via`, `size`, `outcome`, `reason`, `took` |
| `save` | each Save, Save As… and Save to File | `action`, `target`, `history`, `bgm`, `size`, `took`, `outcome`, `reason`, `step` |
| `export` | each Export | `format`, `target`, `size`, `took`, `outcome`, `reason` |
| `check` | each Check File and History… | `outcome`, `took` |
| `bgm` | each BGM chosen | `format`, `size`, `length`, `took`, `outcome` |
| `usage` | at hide | `<command>.<source>` |
| `edits` | at hide | `<operation>`, `undo`, `redo` |
| `features` | at hide | `historyPanel`, `historyDialog`, `recentTab`, `peek`, `peekRefused`, `restore`, `restoreSession`, `restoreCopy`, `saveRowToFile`, `deleteSessions`, `minimapDrag`, `minimapJump`, `quickSwitch` |
| `notices` | at hide | `info`, `warning`, `error` |
| `perf` | at hide | `peek.<time>`, `loafSupported`, `frames.<state>.<length>`, `playSeconds`, `slowInputs`, `interactions`, `visibleTime`, `cores` |
| `errors` | at hide | `error`, `csp` |
| `unsupported` | the support page, on its first input | `engine` |

`chart.historySteps` is the size of the Undo window, at most 1,000 steps (`STACK_CAP`), not the length of the Timeline.

A visit may send `storage` twice, and the later one is the fuller. The Recent Sessions count (`sessions`) is known only after the History tab has read its list. If the first `storage` event went without it, one more goes when the count becomes known. The client reads no storage of its own for it.

`unsupported` is sent by `public/gate.js`, not by the client, when the support gate stops the editor. The build puts the target in a tag on the editor's page, `<meta name="nse-analytics" content="ORIGIN WEBSITE HOST">`, and only in a build with a target; `check:release` compares it with the manifest. The page sends one beacon on its first trusted input while visible, under the same rules as the client (a signal, an off switch, an automated browser, a request to save data, another host).

Umami's own visit counts, durations and bounce rates are wrong for this client. Without a preflight it cannot send Umami's cache header, so a visit that crosses an hour splits. Count visits from the pageviews, and time from `visibleTime`.

## Adding an event or a property

1. Add it to `catalogue.ts`, with a closed set of values or a range, and to the table above.
2. Hook it with one `bump`, `bumpCommand` or `record` at the place that already knows the value. Never compute something on a hot path for it.
3. Extend the unit tests, and the browser spec if it adds a request or a new kind of value.
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
