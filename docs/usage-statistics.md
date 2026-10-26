# What the usage statistics send

The web editor sends usage statistics to a server that the maintainer runs. This page lists each field it sends, when it sends it and how exact each value is. It also lists what the server works out for itself and what the server keeps. The privacy page explains what we collect, how we use it and your choices. Maintainers find the technical detail in [analytics.md](analytics.md).

## When statistics are sent

- Nothing is sent before the first click, key press, touch or scroll in a visit, made while the page is visible. A visit with none sends nothing.
- The first send is the first time the page is hidden, or a minute after that first interaction if the page is still visible. Later sends happen each time the page is hidden, at most once a minute, and once more when the page closes.
- Nothing is sent when Settings › About › Send Usage Statistics is off. Turning it off also drops everything that was waiting, in every open tab.
- Before you choose, the setting is on unless the browser sends Do Not Track or Global Privacy Control. The setting stays as you leave it, in this browser only. Clearing the site’s data in the browser resets it to this default.
- Nothing is sent in safe mode, when the browser asks to save data, from an automated browser, or from a copy of the editor on another site.
- Events are recorded when they happen and wait in memory for the next send. A send can be skipped while another request is still in flight.
- Nothing is sent while the browser is offline. After one failed request, nothing more is sent in that visit.

## What is never sent

Chart content, file names, level information, titles, text you type, paths and addresses with a query or a fragment. Shortcuts, the contents of the toolbar and presets are not sent either. The usage statistics client creates, stores and sends no visitor identifier. It never sends an identifier that the editor stores in the browser, such as the identifier of a local session.

## How exact the values are

Most numbers are sent as ranges, so a value is never more exact than needed. The ranges are in the next section. These rules cover the rest:

- **Counts** are whole numbers from 0 to 9999. A larger count is sent as 9999.
- **Activity counters** are sent only when something was counted. Measured counts, such as interactions and Recent Sessions, can be zero.
- **Action times** are whole milliseconds, from 0 to 600000 (ten minutes). A longer time is sent as 600000.
- **Times of use** (`playSeconds` and `visibleTime`) are whole seconds, from 0 to 86400 (one day) since the previous send.
- **Processor cores** are exact from 1 to 32, then in ranges.
- **Pixel density** is exact for 1, 2 and 3, and a range otherwise.
- **Screen size** is exact, in pixels.
- **Chart counts** are exact from 0 to 9, then in ranges.
- **The Undo window** (`historySteps`) is an exact number of steps, up to 1000.
- **The Recent Sessions count** (`sessions`) is exact, up to 9999.
- **Music lengths and file sizes** are always ranges.
- **A missing or invalid measurement** is left out. The field is absent from the event.

Chart counts and file sizes are each ranged, but together they can sometimes match a chart that has been published.

### The ranges

Most ranges include the lower value and exclude the upper value. Chart-count and processor-core ranges include both written endpoints. Single-value labels are exact. `usageShare` includes 80 in `70-80`, so `80-90` starts above 80. Pixel-density ranges starting at 1, 2 or 3 exclude that exact value. Note-speed range `10-10.5` starts above 10, and `11.5-12` includes 12.

| Range | Used for | Labels |
| --- | --- | --- |
| Chart counts | `notes`, `slides`, `bpms`, `timeScales`, `events`, `stages`, `groups`, `objects` | `0` to `9` exactly, then ten ranges for each power of ten. The ranges of 10 to 99 start at 10, 13, 16, 20, 25, 32, 40, 50, 63 and 80, such as `13-15` and `80-99`. The ranges of 100 to 999 and so on are ten times as large, such as `250-319`. The last ranges are `80000-99999` and `100000+` |
| Music length, in seconds | `length` | `<10`, `10-13`, `13-16`, `16-20`, `20-25`, `25-32`, `32-40`, `40-50`, `50-63`, `63-80`, `80-100`, `100-125`, `125-160`, `160-200`, `200-250`, `250-320`, `320-400`, `400-500`, `500-630`, `630-800`, `800-1000`, `1000-1200`, `1200+` |
| File size and storage used | `size`, `usage` | `<16K`, `16K-32K`, `32K-64K`, `64K-128K`, `128K-256K`, `256K-512K`, `512K-1M`, `1M-2M`, `2M-4M`, `4M-8M`, `8M-16M`, `16M-32M`, `32M-64M`, `64M-128M`, `128M-256M`, `256M-512M`, `512M-1G`, `1G-2G`, `2G-4G`, `4G-8G`, `8G-16G`, `16G+`. K, M and G are 1024, 1024 times 1024 and 1024 cubed bytes |
| Storage limit | `quota` | `<256M`, `256M-1G`, `1G-4G`, `4G-16G`, `16G-64G`, `64G-256G`, `256G+` |
| Share of the storage limit used, in percent | `usageShare` | `<50`, `50-70`, `70-80`, `80-90`, `90-95`, `95-100`, `100+` |
| Workspace width, in pixels | `viewport` | `<360`, `360-400`, `400-480`, `480-640`, `640-768`, `768-1000`, `1000-1100`, `1100-1440`, `1440-1920`, `1920-2560`, `2560+` |
| Pixel density | `dpr` | `<1`, `1`, `1-1.5`, `1.5-2`, `2`, `2-2.5`, `2.5-3`, `3`, `3+` |
| Processor cores | `cores` | `1` to `32` exactly, then `33-48`, `49-64`, `65-96`, `97-128`, `129+` |
| Preview note speed | `previewNoteSpeed` | `1-5`, `5-8`, `8-9`, `9-10`, `10`, `10-10.5`, `10.5-11`, `11-11.5`, `11.5-12` |
| Time to show a Timeline step, in milliseconds | `peek.<time>` | `<25`, `25-50`, `50-100`, `100-150`, `150-200`, `200-300`, `300-500`, `500-1k`, `1k-2k`, `2k-5k`, `5k-10k`, `10k-30k`, `30k+` |
| Length of a long frame, in milliseconds | `frames.<state>.<length>` | `50-100`, `100-200`, `200-500`, `500-1000`, `1000-2000`, `2000+` |
| Duration of a slow response, in milliseconds | `slowEvents.<length>` | `104-200`, `200-500`, `500-1000`, `1000+` |

## What every request carries

The page view and every event carry these fields. The page view is the first item of a visit. It has no event name and no other fields.

| Field | Meaning | Format |
| --- | --- | --- |
| `website` | The id of this site in the statistics server. It is the same for every visitor of the site | Fixed |
| `hostname` | The host the page is on, such as `nse.qwewqa.dev` or `test.nse.qwewqa.dev`, or `localhost` when the editor runs on the visitor’s own machine | Exact |
| `timestamp` | When the event was captured, in whole seconds since 1 January 1970. Without it, the server would use the time the request arrives | Exact |
| `language` | The editor’s language setting, as a language tag such as `en`, `ja`, `zh-Hans` or `zh-Hant`. It is not the browser’s language | Choice |
| `screen` | The size of the whole screen in pixels, written width x height, such as `1920x1080` | Exact |
| `referrer` | The origin of the page you followed a link from, or empty when you came from the editor itself or with no link. An origin is the protocol, the domain and a port that is not the default, such as `https://example.com`. It has no path, query or fragment | Origin only |
| `url` | Always `/`, whatever page or address you were on | Fixed |
| `title` | Always empty | Fixed |

The support page for browsers that are too old sends a shorter request: `website`, `hostname`, `timestamp`, `url`, `title` and the event name. It has no language, screen size or referrer.

## Device details on measured events

Some events repeat six details of the device, so a time or a count can be read against the device that produced it. The events are `startup`, `open`, `save`, `export`, `check`, `bgm`, `peek` and `perf`. `visit` carries the same details in its own fields.

| Field | Meaning | Format |
| --- | --- | --- |
| `cores` | The number of processor cores the browser reports | Exact from 1 to 32, then a range. Absent when the browser reports none |
| `deviceMemory` | The memory the browser reports, in GB, which the browser rounds | `0.25`, `0.5`, `1`, `2`, `4`, `8`, `16+`, or `other` for any other value. Absent when the browser reports none |
| `engine` | The browser engine, worked out by the editor from the browser’s user agent | `chromium`, `webkit`, `firefox` or `other` |
| `touch` | Whether the main way of pointing is imprecise, such as a finger on a touch screen | Yes or no |
| `dpr` | The pixel density of the screen | Exact for 1, 2 and 3, a range otherwise |
| `viewport` | The width of the editor’s workspace in pixels | Range |

When the details are read depends on the event. `open`, `save`, `export`, `check` and `bgm` take them when the action ends, so a window resized before the send does not change them. `startup` takes them when the statistics start. `peek` and `perf` take them when they are sent.

## Events and fields

Each event is sent with the common fields above. A format that is a list of values is a choice among them. An event is recorded only if it has something to report.

### `visit`

Recorded once when the statistics start and included in a later send.

| Field | Meaning | Format |
| --- | --- | --- |
| `version` | The editor’s version, such as `0.6.0`, without its build suffix | Version number |
| `site` | Which site this is | `production` or `test` |
| `os` | The operating system, worked out by the editor from the browser’s user agent | `windows`, `macos`, `linux`, `ios`, `android` or `other` |
| `engine` | The browser engine | `chromium`, `webkit`, `firefox` or `other` |
| `standalone` | Whether the editor runs in a window of its own, such as an installed web app | Yes or no |
| `touch` | Whether the main way of pointing is imprecise | Yes or no |
| `viewport` | The width of the editor’s workspace | Range |
| `viewportPortrait` | Whether the workspace is taller than it is wide | Yes or no |
| `dpr` | The pixel density of the screen | Exact for 1, 2 and 3, a range otherwise |
| `cores` | The number of processor cores | Exact from 1 to 32, then a range |
| `deviceMemory` | The memory the browser reports | As above |
| `browserLanguage` | The first part of the browser’s language, such as `en` or `ja`. The editor’s own language is in `language` | Two or three letters, or `other` |
| `returning` | Whether the editor had stored anything in this browser before this visit | Yes or no |
| `updated` | Whether the editor’s version changed since the last visit | Yes or no |

### `settings`

Recorded once when the statistics start and included in a later send. It holds the value of each setting listed here and no others.

| Field | Meaning | Format |
| --- | --- | --- |
| `theme` | The theme setting | `system`, `light` or `dark` |
| `themeShown` | The theme that is shown | `light` or `dark` |
| `locale` | The editor’s language setting | `en`, `fr`, `ja`, `ko`, `tr`, `zhs` or `zht` |
| `previewInWorker` | Whether the preview may draw in a separate thread | Yes or no |
| `previewRenderScale` | The preview’s render scale, rounded to the nearest quarter | `0.25`, `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75` or `2` |
| `previewAntialias`, `previewShowHitboxes` | Whether the preview smooths edges, and whether it shows hitboxes | Yes or no |
| `previewNoteSpeed` | The preview’s note speed | Range |
| `previewAssets.skin`, `previewAssets.particle`, `previewAssets.background`, `previewAssets.effect` | Where the preview takes each kind of asset from. A package from a server counts as a file | `default`, `builtin`, `bundled` or `file` |
| `showPreview`, `showHistory` | Whether the preview and the History panel are shown | Yes or no |
| `previewPosition`, `historyPosition` | Where the preview and the History panel are placed | `auto`, `left`, `right`, `top` or `disabled` |
| `showMinimap` | Whether the minimap is shown | `auto`, `on` or `off` |
| `dimUnchangedObjects` | Whether objects that a Timeline step did not change are dimmed | Yes or no |
| `waveform` | How the music waveform is drawn | `volume`, `fft` or `off` |
| `beatDisplay` | What the beat labels show | `beat`, `measure` or `both` |
| `toolbarQuickSwitch` | Whether Quick Switch is enabled in the toolbar | Yes or no |
| `toolbarCustomized` | Whether the toolbar was changed from its default. Its contents are not sent | Yes or no |
| `mouseSecondaryTool` | What the secondary mouse button does | `eraser`, `select` or `selectContextMenu` |
| `playFollow` | Whether the view follows playback | Yes or no |
| `touchQuickScrollShow`, `touchLongPressContextMenu` | When the Quick Scroll Zone is shown, and whether a long press opens the context menu. They are sent only from a device whose main way of pointing is imprecise | `on`, `off` or `touch`, and yes or no |
| `confirmCloseUnsavedFile` | The Ask Before Closing with Unsaved Changes setting | Yes or no |

### `startup`

Recorded once when the statistics start and included in a later send. It holds the result of starting the editor.

| Field | Meaning | Format |
| --- | --- | --- |
| `start` | How the visit began | `continued`, `reload`, `recovered` or `blank` |
| `outcome` | How starting ended. `slow` means it took more than ten seconds | `done`, `slow` or `error` |
| `ready` | The time from the page load until the editor was ready. It is left out when the page was hidden during startup, and when startup failed | Milliseconds |
| `hidden` | Whether the page was hidden before startup ended. A hidden page runs slowly, which lengthens `ready` | Yes or no |
| `navigation` | How the page was loaded | `navigate`, `reload`, `back_forward`, `other` or `unknown` |
| `documentDelivery` | A guess at where the page came from, from the browser’s timing record. A page from the cache can still have scripts or stored data that were not ready | `cache`, `network`, `serviceWorker` or `unknown` |
| `wasDiscarded` | Whether the browser had discarded this page earlier to free memory. Sent only where the browser reports it | Yes or no |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

When a visit finds any of the following, `startup` also carries the matching field set to yes. A field is absent when the visit found nothing of that kind.

| Field | Meaning |
| --- | --- |
| `found.continued` | The visit continued the most recent session |
| `found.storageCleared` | Work from earlier visits was missing, because the browser cleared the site’s storage |
| `found.journalKept` | A recovered change was kept as a separate session |
| `found.unsavedRecovered` | Unsaved work from an earlier visit was recovered as a session |
| `found.unsavedInLocalData` | Unsaved work from an earlier visit stayed in Local Data, because storage was unavailable |
| `found.migrationFailed` | The old auto save could not be restored |
| `found.migrated` | The old auto save was moved into the current storage |
| `found.migratedRevision` | The moved auto save was made for an older revision of the engine |
| `found.journalRecovered` | The last change to a session was recovered |
| `found.journalLater` | A recovered change requires a newer version of the editor |
| `found.storageNearlyFull` | Browser storage was still almost full after cleanup |
| `found.journalFailed` | A recovered change could not be applied or kept, because storage was full or busy |
| `found.journalsFull` | Recovered changes kept from earlier visits fill much of the space set aside for them |
| `found.notOpened` | A session could not be opened, because it was damaged or needs a newer version |
| `found.openElsewhere` | The most recent session was open in another tab, so this tab started blank |
| `found.deletedElsewhere` | The session this tab reloaded was deleted in another tab |
| `found.separateCopy` | This tab opened a separate copy, because the session is open in another tab |
| `found.bgmNotLoaded` | The music of the continued session could not be loaded |

### `storage`

Recorded when the storage status is known, again when storing is paused or moves to memory only, and once more when the Recent Sessions count becomes known. Each is included in a later send.

| Field | Meaning | Format |
| --- | --- | --- |
| `mode` | Whether the browser stores sessions (`stored`), can only read them (`readOnly`) or keeps them in memory only (`memory`) | `stored`, `readOnly` or `memory` |
| `reason` | Why storing is paused. Sent only when it is | `full`, `upgrading`, `olderTabs` or `failed` |
| `persisted` | Whether the browser has granted this site protection from automatic clearing | `granted`, `not` or `unsupported` |
| `usage` | How much storage the site uses. Left out when the browser gives no estimate | Range |
| `quota` | The most storage the browser lets the site use. Left out when the browser gives no estimate | Range |
| `usageShare` | The share of the limit in use, in percent. Left out when the browser gives no limit | Range |
| `cleanup` | The latest automatic cleanup seen: not run, busy, freed no space or freed space | `notRun`, `busy`, `noSpaceFreed` or `freed` |
| `sessions` | How many sessions Recent Sessions lists. Sent once the History tab has read the list | Count |

### `chart`

Recorded after Open File…, after a stored session is shown and after a Save, if the chart has notes or animation events, and included in a later send. The editor counts when the browser is idle, and not during playback.

| Field | Meaning | Format |
| --- | --- | --- |
| `trigger` | What caused the count | `open`, `restore` or `save` |
| `notes` | The number of notes | Range |
| `slides` | The number of slides, each a set of notes joined together | Range |
| `bpms` | The number of BPM entries | Range |
| `timeScales` | The number of time scale entries | Range |
| `events` | The number of animation event joints | Range |
| `stages`, `groups` | The number of stages, and of groups | Range |
| `objects` | The total of notes, time scale entries, animation event joints, BPM entries, stages and groups. Slides are not added, because their notes are counted already | Range |
| `dynamicStages` | Whether the chart uses dynamic stages | Yes or no |
| `bgm` | Whether the chart has music. The length is in `bgm` | `none` or `some` |
| `historySteps` | How many steps the Undo window holds. This is not the length of the Timeline | Exact, up to 1000 |

### `preview`

Recorded when the statistics start, if the preview is shown, and when the preview moves from its separate thread to the main thread after a failure. Each is included in a later send.

| Field | Meaning | Format |
| --- | --- | --- |
| `host` | Which thread draws the preview | `main` or `worker` |
| `reason` | Why the separate thread was given up: a WebGL 2 graphics context could not be created, it failed, it did not answer in time, or its canvas could not be handed over. Sent only on that handover | `webgl2`, `error`, `timeout` or `transfer` |
| `workerFrames` | Whether the separate thread had drawn any frames before it failed. Sent only on that handover | `none` or `some` |
| `graphics` | Whether the editor could use the browser’s graphics. Sent when the statistics start | `ok` or `unavailable` |

### `open`

Recorded when an Open File… of a chart file ends, and included in a later send. A file that is not a chart (audio, an archive, a package) is not reported. Dropping a file onto the editor opens nothing and is not recorded.

| Field | Meaning | Format |
| --- | --- | --- |
| `format` | The kind of chart file | `nxsp`, `levelData`, `sus`, `usc`, `chcy` or `other` |
| `via` | How the file was chosen | Always `picker` |
| `size` | The file’s size | Range |
| `outcome` | Whether the file opened, was cancelled, was refused or failed | `done`, `cancelled`, `refused` or `failed` |
| `reason` | Why a file was refused: it is not supported, or it is not valid | `unsupported` or `invalid` |
| `took` | How long the open took, counted from the moment the file was chosen | Milliseconds |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### `save`

Recorded when a Save, Save As…, Download Again or Recent Sessions Save… ends, and included in a later send.

| Field | Meaning | Format |
| --- | --- | --- |
| `action` | Which of the four was used | `save`, `saveAs`, `saveToFile` or `downloadAgain` |
| `target` | Where the file went: written back to its file, chosen in a file picker, or downloaded | `writeBack`, `picker` or `download` |
| `history`, `bgm` | Whether the saved file included the History and the music | Yes or no |
| `size` | The size of the file written | Range |
| `took` | How long the write took, counted from after the last picker or dialog closed | Milliseconds |
| `buildMs` | How long building the file took. It can be longer than `took` when the build came before the picker | Milliseconds |
| `outcome` | How the action ended | `done`, `cancelled`, `noChanges`, `forked`, `unlinked`, `refused`, `conflict`, `failed` or `error` |
| `reason` | Why it failed or was refused: a file error, or that the session is not kept, is not a project file, is level data, or is in safe mode | `conflict`, `not-found`, `denied`, `not-local`, `no-space`, `read-only`, `io`, `notKept`, `notProject`, `levelData` or `safeMode` |
| `step` | The step where a failure happened | `build`, `read`, `readBack`, `download` or `check` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### `export`

Recorded when an export write succeeds or fails, and included in a later send. Cancelling an export is not recorded.

| Field | Meaning | Format |
| --- | --- | --- |
| `format` | The kind of file exported | Always `levelData` |
| `target` | Whether the file was chosen in a file picker or downloaded | `picker` or `download` |
| `size` | The size of the file written | Range |
| `took` | How long the write took, counted from after the last picker closed | Milliseconds |
| `buildMs` | How long building the file took | Milliseconds |
| `outcome` | How the export ended | `done` or `failed` |
| `reason` | Why it failed: a file error | `conflict`, `not-found`, `denied`, `not-local`, `no-space`, `read-only` or `io` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### `check`

Recorded when a Check File and History ends without being cancelled, and included in a later send.

| Field | Meaning | Format |
| --- | --- | --- |
| `outcome` | Whether the check found no problems, found problems or could not run | `ok`, `problems` or `failed` |
| `took` | How long the check took | Milliseconds |
| `scope` | Whether the check covered the stored History only, or a file as well | `stored` or `fileAndStored` |
| `size` | The size of the file that was checked. Sent only when a file was checked | Range |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### `bgm`

Recorded each time music is chosen, and included in a later send.

| Field | Meaning | Format |
| --- | --- | --- |
| `format` | The kind of music file | `mp3`, `ogg`, `wav`, `flac`, `m4a` or `other` |
| `size` | The file’s size | Range |
| `length` | The music’s length. Sent when the music loaded | Range |
| `took` | How long loading took | Milliseconds |
| `outcome` | Whether the music loaded, was cancelled or failed | `done`, `cancelled` or `failed` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### Counts at each send

These events are included at each send, including the first send after a minute of use. Each carries the counts since the last send. Activity counters are sent only when something was counted.

#### `usage`

| Field | Meaning | Format |
| --- | --- | --- |
| `<command>.<source>` | How often each command was used, and where the press came from. The command is one of the editor’s built-in commands, named as in its command list, such as `save` or `zoomXIn`. A command that is not built in is not counted | Count |

The source is `key`, `toolbar`, `menu`, `gesture`, `wheel`, `panel` or `button`. A command run by another command is not counted. A held key counts once, not for each repeat, and the mouse wheel counts once a visit for each command.

#### `edits`

How often each kind of edit was made, by its name, how often a Timeline step was restored, and how often Undo and Redo were used.

| Field | Meaning | Format |
| --- | --- | --- |
| `undo`, `redo` | Undo and Redo | Count |
| `note.add`, `note.generate`, `note.elevation`, `note.combine`, `note.split`, `note.vertical` | Notes added or generated, and notes changed in height, joined, split or made vertical | Count |
| `object.add`, `object.edit`, `object.move`, `object.replace`, `object.paste`, `object.brush`, `object.delete`, `object.cut`, `object.flip`, `object.scale` | Objects added, edited, moved, replaced, pasted, brushed, deleted, cut, flipped or scaled | Count |
| `property.set`, `header.set`, `levelInfo.set`, `bgm.change`, `dynamicStages.enable` | Properties set, Initial Life or the music offset set, level information set, music changed, dynamic stages turned on | Count |
| `owner.create`, `owner.rename`, `owner.set`, `owner.move`, `owner.moveMany`, `owner.duplicate`, `owner.delete`, `owner.ungroup` | Stages, groups and their folders created, renamed, changed, moved, duplicated, deleted or ungrouped | Count |
| `restore` | A Timeline step was restored | Count |

#### `features`

| Field | Meaning | Format |
| --- | --- | --- |
| `historyPanel`, `historyDialog`, `recentTab` | The History panel was shown, the History dialog was opened, and the Recent Sessions tab was opened | Count |
| `peek`, `peekRefused` | A Timeline step was viewed, and a command was refused while one was viewed | Count |
| `restore`, `restoreSession`, `restoreCopy` | A Timeline step was restored, a stored session was restored, and a stored session was restored as a copy | Count |
| `saveRowToFile`, `deleteSessions` | Save… was chosen for a stored session, and Delete Sessions… was confirmed | Count |
| `minimapDrag`, `minimapJump` | The minimap was dragged, and the minimap was used to jump | Count |
| `autoscroll`, `quickSwitch` | Autoscroll started, and Quick Switch picked a tool | Count |

#### `notices`

| Field | Meaning | Format |
| --- | --- | --- |
| `info`, `warning`, `error` | How many notices of each severity the editor showed. The text is not sent | Count |

#### `errors`

No crash reports are sent. The `errors` event contains only counts, without error messages or stack traces.

| Field | Meaning | Format |
| --- | --- | --- |
| `error` | How many errors the editor caught. The text of an error is not sent | Count |
| `csp` | How many times the browser blocked something the page tried to load, under the page’s content security policy | Count |

### `peek`

Included with `perf` at a send, and only when Timeline steps were viewed since the last send.

| Field | Meaning | Format |
| --- | --- | --- |
| `peek.<time>` | How many Timeline steps took each length of time to show. The time runs from the start of the load, after a short wait, until the step shows its change | Count for each range |
| `peek.cached` | How many steps were shown from the cache, and not timed | Count |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### `perf`

Included at each send, including the first send after a minute of use, for the time since the last send.

| Field | Meaning | Format |
| --- | --- | --- |
| `loafSupported`, `eventTimingSupported` | Whether the browser can report long frames, and slow responses | Yes or no |
| `frames.<state>.<length>` | How many long frames (frames that took 50 milliseconds or more) there were, by what the editor was doing when the frame began and by its length. The state is `playing` for visible playback, `busy` during an Open, Save, Check, Restore or music load, and `other` for the rest | Count for each state and range |
| `frames.unclassified` | Long frames that began too long ago to be sorted by state | Count |
| `frameAttribution` | Whether every long frame in this send was sorted by state (`full`) or some were not (`partial`) | `full` or `partial` |
| `slowEvents.<length>` | How many clicks, key presses and similar inputs took 104 milliseconds or more to be answered, by duration | Count for each range |
| `interactions` | The browser’s own count of interactions. Absent where the browser has none | Count |
| `playSeconds` | The time spent playing since the last send, counted only while the page is visible | Seconds |
| `visibleTime` | The time the page was visible since the last send | Seconds |
| `previewHost` | Which thread drew the preview over this interval: `none` when the preview was not shown, `mixed` when it changed, `unknown` when it could not be told | `main`, `worker`, `none`, `mixed` or `unknown` |
| `previewRenderScale` | The preview’s render scale over this interval, with `mixed` when it changed | `0.25`, `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75`, `2`, `mixed` or `unknown` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport` | The device details above | As above |

### `unsupported`

Sent by the support page, when the editor cannot run in the browser, on the first interaction with that page. It is one request. It follows the setting and the browser signals described above.

| Field | Meaning | Format |
| --- | --- | --- |
| `engine` | The browser family | `chromium`, `webkit`, `firefox` or `other` |

## What the server works out

The server receives your IP address and your browser’s user agent with each request. The editor reads the user agent to identify the browser engine and operating system. The full user agent reaches the server in the browser’s request headers. It is not included in the event fields.

The server uses your IP address to estimate your location, and your user agent to identify your browser and operating system. It uses the user agent and screen width to estimate the device type, such as desktop, laptop, mobile or tablet. It also uses them to:

- make a visitor code from the site, your IP address and your user agent, together with a value that changes every day. The code groups the events of one browser in one day. People who use the same kind of browser on the same connection can share a code, and the code is different the next day;
- drop requests from known automated clients.

The server may also work out a region and a city. It does not store them. Of these, only the country, browser, operating system, device type and the daily code are stored. The server does not set cookies and stores nothing in your browser.

The `language` and `screen` fields of the request are stored with the visitor as the editor sends them.

## What the server keeps

- **Individual records** (events and their fields, and the visitors they belong to) are kept for 13 months. A nightly job deletes older ones. A visitor is deleted once none of its events remain. Backups on AWS are deleted after about five weeks.
- **Monthly totals** are kept with no time limit. They hold counts, sums and percentiles and no visitor code. They hold:
    - the visits and sessions of the month, by editor version, browser, operating system, device type, country and language, one at a time;
    - how often each event was sent, and each value of the choice and yes-or-no fields;
    - the total and the number of each count field, such as the use of a command;
    - the median and the 90th and 99th percentile of each time in milliseconds (`ready`, `took` and `buildMs`), over all visits and by version and device type.
- **Weekly totals** are kept with no time limit. They hold only the visits, the sessions and the number of events of each name, for each week from Monday, and no breakdown.
- **Separate statistics for each site.** Statistics are stored separately for each site. Only the maintainer has access to the dashboard.
- **Only the fields on this page are totaled.** Anything else a request carries is left out of the totals.
- **No small groups.** A total is kept only when at least 10 different visitor codes are behind it. A smaller group is merged into a group named `other` when that reaches 10, and is left out when it does not. A name keeps at most 50 values a month (100 for countries), the most common first, and the rest become `other`. A time is summarized only from groups of at least 10 visitor codes, so a left-out measurement is in no percentile.

[analytics.md](analytics.md) has the technical detail, under “Privacy rules” and “What the server keeps”.
