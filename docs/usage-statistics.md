# What Usage Statistics Contain

The web editor sends usage statistics to a server run by the maintainer. The [privacy page](https://nse.qwewqa.dev/privacy/) explains how these statistics are used and what choices you have about collection. Technical details are in [analytics.md](analytics.md).

## When Statistics Are Sent

- The editor can collect statistics before your first interaction. Statistics are sent only after you click, press a key, touch the screen or scroll while the page is visible.
- The first request is sent when the page becomes hidden, or one minute after that first interaction if the page stays visible. Later requests are sent when the page becomes hidden, at most once a minute. A final request may be sent when the page closes, even within that minute.
- If the editor shows a window with the Send Usage Statistics setting when it starts, no statistics are sent until that window is closed and you use the editor.
- Turning off **Settings › About › Send Usage Statistics** stops collection and discards unsent statistics in every open tab.
- The setting is on by default unless the browser sends Do Not Track or Global Privacy Control. Your choice is stored only in your browser. Clearing the editor’s site data resets the setting to its default.
- The editor disables statistics in safe mode, when the browser’s data saver is on, in automated browsers and in copies of the editor hosted on another site.
- Recorded events are kept in memory and sent together in batches. If an earlier request is still in progress, the next request is skipped and the pending statistics remain queued.
- The editor skips requests while the browser is offline. After a failed request, it sends no more statistics for the rest of the visit.

## What Is Never Sent

The editor does not send chart content, file names, level info, the page title, text you type, or the path, query or fragment of an address. Shortcuts, toolbar contents and presets are also excluded.

The editor does not create or store a visitor identifier for statistics. It does not send identifiers stored in the browser, such as the identifier of a stored session. The server’s daily visitor identifier is described under [Data Derived by the Server](#data-derived-by-the-server).

## How Exact the Values Are

Most numeric values are sent as ranges.

- **Counts** (the Count format in the tables) are whole numbers from 0 to 9999. A larger count is sent as 9999.
- **Activity counts** are sent only when greater than zero. Other counts, such as `interactions` and the number of sessions in Recent Sessions, can be zero.
- **Durations** are whole milliseconds, from 0 to 600000 (ten minutes). A longer duration is sent as 600000.
- **Time spent** (`playSeconds` and `visibleTime`) is measured since the previous batch and reported in whole seconds from 0 to 86400 (one day).
- **Processor cores** are exact from 1 to 32, then in ranges.
- **Pixel density** is exact for 1, 1.25, 1.5, 1.75, 2 and 3, and a range otherwise.
- **Screen size** is exact, in pixels.
- **Chart counts** are exact from 0 to 9, then in ranges.
- **Undo history** (`historySteps`) is an exact number of steps, up to 1000.
- **The Recent Sessions count** (`sessions`) is exact, up to 9999.
- **Music lengths and file sizes** are always ranges.
- **A missing or invalid measurement** is left out.

Chart counts and file-size ranges can sometimes identify a published chart when combined.

### The Ranges

Most ranges include the lower value and exclude the upper value. Chart-count and processor-core ranges include both endpoints. Single-value labels are exact. For `usageShare`, `70-80` includes 80, so `80-90` starts above 80. Pixel-density ranges that start at 1, 1.25, 1.5, 1.75, 2 or 3 exclude that value. The note-speed range `10-10.5` starts above 10, and `11.5-12` includes 12.

| Range | Used for | Labels |
| --- | --- | --- |
| Chart counts | `notes`, `slides`, `bpms`, `timeScales`, `events`, `stages`, `groups`, `objects` | Exact values from `0` to `9`. Between 10 and 99, the ranges start at 10, 13, 16, 20, 25, 32, 40, 50, 63 and 80. Examples are `13-15` and `80-99`. The same pattern repeats from 100 to 999 and at each larger power of ten, with the starting values multiplied by ten each time. For example, one range is `250-319`. The last ranges are `80000-99999` and `100000+` |
| Music length, in seconds | `length` | `<10`, `10-13`, `13-16`, `16-20`, `20-25`, `25-32`, `32-40`, `40-50`, `50-63`, `63-80`, `80-100`, `100-125`, `125-160`, `160-200`, `200-250`, `250-320`, `320-400`, `400-500`, `500-630`, `630-800`, `800-1000`, `1000-1200`, `1200+` |
| File size and storage used | `size`, `usage` | `<16K`, `16K-32K`, `32K-64K`, `64K-128K`, `128K-256K`, `256K-512K`, `512K-1M`, `1M-2M`, `2M-4M`, `4M-8M`, `8M-16M`, `16M-32M`, `32M-64M`, `64M-128M`, `128M-256M`, `256M-512M`, `512M-1G`, `1G-2G`, `2G-4G`, `4G-8G`, `8G-16G`, `16G+`. K is 1024 bytes, M is 1024 K and G is 1024 M |
| Storage limit | `quota` | `<256M`, `256M-1G`, `1G-4G`, `4G-16G`, `16G-64G`, `64G-256G`, `256G+` |
| Share of the storage limit used, in percent | `usageShare` | `<50`, `50-70`, `70-80`, `80-90`, `90-95`, `95-100`, `100+` |
| Workspace width, in pixels | `viewport` | `<360`, `360-400`, `400-480`, `480-640`, `640-768`, `768-1000`, `1000-1100`, `1100-1440`, `1440-1920`, `1920-2560`, `2560-2880`, `2880-3440`, `3440-3840`, `3840-5120`, `5120+` |
| Workspace height, in pixels | `viewportHeight` | `<400`, `400-500`, `500-600`, `600-768`, `768-900`, `900-1080`, `1080-1440`, `1440-2160`, `2160+` |
| Workspace width divided by height | `viewportAspect` | `<0.4`, `0.4-0.5`, `0.5-0.6`, `0.6-0.7`, `0.7-0.8`, `0.8-0.9`, `0.9-1`, `1-1.1`, `1.1-1.2`, `1.2-1.3`, `1.3-1.4`, `1.4-1.5`, `1.5-1.6`, `1.6-1.7`, `1.7-1.8`, `1.8-1.9`, `1.9-2`, `2-2.2`, `2.2-2.4`, `2.4-2.6`, `2.6-2.8`, `2.8-3`, `3-3.5`, `3.5-4`, `4+` |
| Pixel density | `dpr` | `<1`, `1`, `1-1.25`, `1.25`, `1.25-1.5`, `1.5`, `1.5-1.75`, `1.75`, `1.75-2`, `2`, `2-2.5`, `2.5-3`, `3`, `3+` |
| Processor cores | `cores` | `1` to `32` exactly, then `33-48`, `49-64`, `65-96`, `97-128`, `129+` |
| Preview note speed | `previewNoteSpeed` | `1-5`, `5-8`, `8-9`, `9-10`, `10`, `10-10.5`, `10.5-11`, `11-11.5`, `11.5-12` |
| Duration of loading a Timeline step, in milliseconds | `peek.<time>` | `<10`, `10-16`, `16-25`, `25-40`, `40-63`, `63-100`, `100-160`, `160-250`, `250-400`, `400-630`, `630-1k`, `1k-1.6k`, `1.6k-2.5k`, `2.5k-4k`, `4k-6.3k`, `6.3k-10k`, `10k-16k`, `16k-25k`, `25k+` |
| Duration of a long frame, in milliseconds | `frames.<state>.<length>` | `50-100`, `100-200`, `200-500`, `500-1000`, `1000-2000`, `2000+` |
| Duration of a slow response, in milliseconds | `slowEvents.<length>` | `104-200`, `200-500`, `500-1000`, `1000+` |

## Common Fields

The page view and every event include the fields below. The page view is the first item in each visit and has no event name or event-specific fields. “Choice” means one of a fixed set of values.

| Field | Meaning | Format |
| --- | --- | --- |
| `website` | This site’s identifier on the statistics server, the same for all visitors | Fixed |
| `hostname` | The host name of the page, such as `nse.qwewqa.dev` or `test.nse.qwewqa.dev`, or `localhost` when the editor runs on your own machine | Exact |
| `timestamp` | When the page view or event was recorded, in whole seconds since 1 January 1970 | Exact |
| `language` | The editor’s language setting, as a language tag such as `en`, `ja`, `zh-Hans` or `zh-Hant` | Choice |
| `screen` | The size of the whole screen in pixels, written width x height, such as `1920x1080` | Exact |
| `referrer` | The origin of the page you followed a link from, or empty when you opened the editor directly or followed a link within the same site. An origin is the protocol, domain and any non-default port, such as `https://example.com`. It has no path, query or fragment | Origin only |
| `url` | Always `/`, regardless of the actual address | Fixed |
| `title` | Always empty | Fixed |

The page shown to unsupported browsers sends only `website`, `hostname`, `timestamp`, `url`, `title`, the event name and `engine`. See [`unsupported`](#unsupported).

## Device Details in Events

The events `startup`, `open`, `save`, `export`, `check`, `bgm`, `peek` and `perf` include the device details below. `visit` includes them too.

| Field | Meaning | Format |
| --- | --- | --- |
| `cores` | The number of processor cores reported by the browser | Exact from 1 to 32, then a range. Omitted when the browser reports none |
| `deviceMemory` | The device memory in GB, as rounded by the browser | `0.25`, `0.5`, `1`, `2`, `4`, `8`, `16+`, or `other` for any other value. Omitted when the browser reports none |
| `engine` | The browser engine, detected by the editor from the browser’s user agent | `chromium`, `webkit`, `firefox` or `other` |
| `touch` | Whether the primary pointing device has limited precision, as with a touch screen | Yes or no |
| `dpr` | The pixel density of the screen | Exact for 1, 1.25, 1.5, 1.75, 2 and 3, a range otherwise |
| `viewport` | The width of the editor’s workspace in pixels | Range |
| `viewportHeight` | The height of the editor’s workspace in pixels | Range |
| `viewportAspect` | The workspace’s width divided by its height. Below 1, it is taller than it is wide | Range |

For `open`, `save`, `export`, `check` and `bgm`, device details are recorded when the action ends. For `startup`, they are recorded when statistics collection starts. For `peek` and `perf`, they are recorded when the events are sent.

## Events and Fields

Each event also includes the common fields above.

### `visit`

Recorded once when statistics collection starts.

| Field | Meaning | Format |
| --- | --- | --- |
| `version` | The editor’s version, such as `0.6.0`, without its build suffix | Version number |
| `site` | Whether this is the main site or the test site | `production` or `test` |
| `os` | The operating system, detected by the editor from the browser’s user agent | `windows`, `macos`, `linux`, `ios`, `android` or `other` |
| `engine` | The browser engine | `chromium`, `webkit`, `firefox` or `other` |
| `standalone` | Whether the editor runs in a window of its own, such as an installed web app | Yes or no |
| `touch` | Whether the primary pointing device has limited precision | Yes or no |
| `viewport` | The width of the editor’s workspace | Range |
| `viewportHeight` | The height of the editor’s workspace | Range |
| `viewportAspect` | The workspace’s width divided by its height | Range |
| `dpr` | The pixel density of the screen | Exact for 1, 1.25, 1.5, 1.75, 2 and 3, a range otherwise |
| `cores` | The number of processor cores | Exact from 1 to 32, then a range |
| `deviceMemory` | The memory reported by the browser | As above |
| `browserLanguage` | The browser’s language without its region or script, such as `en` or `ja`. The editor’s own language is in `language` | Two or three letters, or `other` |
| `returning` | Whether the editor had stored anything in this browser before this visit | Yes or no |
| `updated` | Whether the editor’s version changed since the last visit | Yes or no |

### `settings`

Recorded once when statistics collection starts. Only the settings below are included.

| Field | Meaning | Format |
| --- | --- | --- |
| `theme` | The chosen theme | `system`, `light` or `dark` |
| `themeShown` | The theme currently displayed | `light` or `dark` |
| `locale` | The editor’s language setting | `en`, `fr`, `ja`, `ko`, `tr`, `zhs` or `zht` |
| `previewInWorker` | Whether the preview may draw in a separate thread | Yes or no |
| `previewRenderScale` | The preview’s render scale, rounded to the nearest quarter | `0.25`, `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75` or `2` |
| `previewAntialias`, `previewShowHitboxes` | Whether antialiasing is enabled and whether hitboxes are shown | Yes or no |
| `previewNoteSpeed` | The preview’s note speed | Range |
| `previewAssets.skin`, `previewAssets.particle`, `previewAssets.background`, `previewAssets.effect` | The source of each kind of preview asset. A package from a server is reported as `file` | `default`, `builtin`, `bundled` or `file` |
| `showPreview`, `showHistory` | Whether the preview and the History panel are shown | Yes or no |
| `previewPosition`, `historyPosition` | Where the preview and the History panel are placed | `auto`, `left`, `right`, `top` or `disabled` |
| `showMinimap` | Whether the minimap is shown | `auto`, `on` or `off` |
| `dimUnchangedObjects` | Whether objects that a Timeline step did not change are dimmed | Yes or no |
| `waveform` | How the music waveform is drawn | `volume`, `fft` or `off` |
| `beatDisplay` | What the beat labels show | `beat`, `measure` or `both` |
| `toolbarQuickSwitch` | Whether Quick Switch is enabled in the toolbar | Yes or no |
| `toolbarCustomized` | Whether the toolbar was changed from its default | Yes or no |
| `mouseSecondaryTool` | What the secondary mouse button does | `eraser`, `select` or `selectContextMenu` |
| `playFollow` | Whether the view follows playback | Yes or no |
| `touchQuickScrollShow` | When the Quick Scroll Zone is shown. Sent only when the primary pointing device has limited precision | `on`, `off` or `touch` |
| `touchLongPressContextMenu` | Whether a long press opens the context menu. Sent only when the primary pointing device has limited precision | Yes or no |
| `confirmCloseUnsavedFile` | Whether the Ask Before Closing with Unsaved Changes setting is on | Yes or no |

### `startup`

Recorded once when statistics collection starts, with the startup result.

| Field | Meaning | Format |
| --- | --- | --- |
| `start` | How the visit began | `continued`, `reload`, `recovered` or `blank` |
| `outcome` | The startup result. `slow` means startup took more than ten seconds | `done`, `slow` or `error` |
| `ready` | The time from the page load until the editor was ready. Omitted when the page was hidden during startup or startup failed | Milliseconds |
| `hidden` | Whether the page was hidden before startup ended. Browsers can slow down hidden pages | Yes or no |
| `navigation` | How the page was loaded | `navigate`, `reload`, `back_forward`, `other` or `unknown` |
| `documentDelivery` | Where the page was loaded from, as estimated from the browser’s timing data. A cached page does not mean that scripts or stored data were already loaded | `cache`, `network`, `serviceWorker` or `unknown` |
| `wasDiscarded` | Whether the browser had discarded this page earlier to free memory. Sent only when the browser reports it | Yes or no |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

Each of the following fields is included and set to yes when its condition applies during startup. Other fields in this list are omitted.

| Field | Meaning |
| --- | --- |
| `found.continued` | The most recent session was continued |
| `found.storageCleared` | Work from earlier visits was missing because the browser cleared the site’s storage |
| `found.journalKept` | A recovered change was kept as a separate session |
| `found.unsavedRecovered` | Unsaved work from an earlier visit was recovered as a session |
| `found.unsavedInLocalData` | Unsaved work from an earlier visit stayed in Local Data because storage was unavailable |
| `found.migrationFailed` | The old auto save could not be restored |
| `found.migrated` | The old auto save was migrated to the current storage |
| `found.migratedRevision` | The migrated auto save was created for an older revision of the game engine |
| `found.journalRecovered` | The last change to a session was recovered |
| `found.journalLater` | A recovered change required a newer version of the editor |
| `found.storageNearlyFull` | Browser storage was still almost full after cleanup |
| `found.journalFailed` | A recovered change could not be applied or kept because storage was full or busy |
| `found.journalsFull` | Recovered changes kept from earlier visits filled much of the space set aside for them |
| `found.notOpened` | A session could not be opened because it was damaged or needed a newer version of the editor |
| `found.openElsewhere` | The most recent session was open in another tab, so this tab started blank |
| `found.deletedElsewhere` | The session this tab reloaded was deleted in another tab |
| `found.separateCopy` | This tab opened a separate copy of a session |
| `found.bgmNotLoaded` | The music of the continued session could not be loaded |

### `storage`

Recorded when the storage status or the number of sessions in Recent Sessions becomes known. Also recorded when the editor pauses session storage or switches to keeping sessions only in memory.

| Field | Meaning | Format |
| --- | --- | --- |
| `mode` | Whether sessions are stored, read-only or kept in memory only | `stored`, `readOnly` or `memory` |
| `reason` | Why session storage is paused. Sent only while it is paused | `full`, `upgrading`, `olderTabs` or `failed` |
| `persisted` | Whether the browser has granted this site protection from automatic clearing | `granted`, `not` or `unsupported` |
| `usage` | How much storage the site uses. Omitted when the browser provides no estimate | Range |
| `quota` | The maximum storage the browser allows the site to use. Omitted when the browser provides no estimate | Range |
| `usageShare` | The percentage of the storage limit in use. Omitted when the browser does not report usage or a storage limit greater than zero | Range |
| `cleanup` | The result of the latest automatic cleanup | `notRun`, `busy`, `noSpaceFreed` or `freed` |
| `sessions` | The number of sessions in Recent Sessions. Sent after the Recent Sessions tab loads the list | Count |

### `chart`

Recorded after a chart is opened through **Open File…**, a stored session is shown or a chart is saved. The chart must contain notes or animation events.

| Field | Meaning | Format |
| --- | --- | --- |
| `trigger` | What caused the count | `open`, `restore` or `save` |
| `notes` | The number of notes | Range |
| `slides` | The number of slides, each a set of notes joined together | Range |
| `bpms` | The number of BPM entries | Range |
| `timeScales` | The number of time scale entries | Range |
| `events` | The number of animation event joints | Range |
| `stages`, `groups` | The number of stages and the number of groups | Range |
| `objects` | The total of notes, time scale entries, animation event joints, BPM entries, stages and groups. Slides are not added because their notes are already counted | Range |
| `dynamicStages` | Whether the chart uses dynamic stages | Yes or no |
| `bgm` | Whether the chart has music. The music’s length is in the `bgm` event | `none` or `some` |
| `historySteps` | The number of steps kept in the Undo history (not the Timeline) | Exact, up to 1000 |

### `preview`

Recorded when statistics collection starts, if the preview is shown, and when the preview switches from its separate thread to the main thread after a failure.

| Field | Meaning | Format |
| --- | --- | --- |
| `host` | The thread used to draw the preview. `worker` is the separate thread | `main` or `worker` |
| `reason` | Why the preview switched to the main thread: a WebGL 2 graphics context could not be created, the separate thread failed or timed out, or the canvas could not be transferred. Sent only when this switch occurs | `webgl2`, `error`, `timeout` or `transfer` |
| `workerFrames` | Whether the separate thread had drawn any frames before it failed. Sent only when the preview switches to the main thread | `none` or `some` |
| `graphics` | Whether the editor could use the browser’s graphics. Sent when statistics collection starts | `ok` or `unavailable` |

### `open`

Recorded when an attempt to open a chart through **Open File…** ends. Opening non-chart files, such as audio, archives or packages, and dropping files onto the editor are not recorded.

| Field | Meaning | Format |
| --- | --- | --- |
| `format` | The kind of chart file | `nxsp`, `levelData`, `sus`, `usc`, `chcy` or `other` |
| `via` | How the file was chosen | Always `picker` |
| `size` | The file’s size | Range |
| `outcome` | The result of opening the file | `done`, `cancelled`, `refused` or `failed` |
| `reason` | Why the file was refused | `unsupported` or `invalid` |
| `took` | How long opening took, measured from when the file was chosen | Milliseconds |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### `save`

Recorded when a **Save**, **Save As…**, **Download Again** or **Save…** action in Recent Sessions ends.

| Field | Meaning | Format |
| --- | --- | --- |
| `action` | Which save command was used | `save`, `saveAs`, `saveToFile` or `downloadAgain` |
| `target` | How the file was saved: written to the existing file, written to a location chosen in a file picker, or downloaded | `writeBack`, `picker` or `download` |
| `history`, `bgm` | Whether the saved file included the History and the music | Yes or no |
| `size` | The size of the file written | Range |
| `took` | How long writing took, measured from when the last picker or dialog closed | Milliseconds |
| `buildMs` | How long building the file took. It can be longer than `took` when the build came before the picker | Milliseconds |
| `outcome` | How the action ended | `done`, `cancelled`, `noChanges`, `forked`, `unlinked`, `refused`, `conflict`, `failed` or `error` |
| `reason` | Why saving failed or was refused: a file error, a session that is not kept, a file that is not a project file, level data or safe mode | `conflict`, `not-found`, `denied`, `not-local`, `no-space`, `read-only`, `io`, `notKept`, `notProject`, `levelData` or `safeMode` |
| `step` | The part of saving that failed | `build`, `read`, `readBack`, `download` or `check` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### `export`

Recorded when writing an export succeeds or fails. Cancelling an export is not recorded.

| Field | Meaning | Format |
| --- | --- | --- |
| `format` | The kind of file exported | Always `levelData` |
| `target` | Whether the export was written to a location chosen in a file picker or downloaded | `picker` or `download` |
| `size` | The size of the file written | Range |
| `took` | How long writing took, measured from when the last picker closed | Milliseconds |
| `buildMs` | How long building the file took | Milliseconds |
| `outcome` | How the export ended | `done` or `failed` |
| `reason` | The file error that caused the export to fail | `conflict`, `not-found`, `denied`, `not-local`, `no-space`, `read-only` or `io` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### `check`

Recorded when **Check File and History** finishes, unless it was cancelled.

| Field | Meaning | Format |
| --- | --- | --- |
| `outcome` | Whether the check found no problems, found problems or could not run | `ok`, `problems` or `failed` |
| `took` | How long the check took | Milliseconds |
| `scope` | Whether the check covered only the stored History or also a file | `stored` or `fileAndStored` |
| `size` | The size of the file checked. Sent only when a file was checked | Range |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### `bgm`

Recorded each time music is chosen.

| Field | Meaning | Format |
| --- | --- | --- |
| `format` | The kind of music file | `mp3`, `ogg`, `wav`, `flac`, `m4a` or `other` |
| `size` | The file’s size | Range |
| `length` | The music’s length. Sent only when the music loaded | Range |
| `took` | How long loading took | Milliseconds |
| `outcome` | The result of loading the music | `done`, `cancelled` or `failed` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### Activity Counts

These events report activity accumulated since the previous batch, or since collection began for the first batch.

#### `usage`

| Field | Meaning | Format |
| --- | --- | --- |
| `<command>.<source>` | How often each command was used, grouped by the input or control used to run it. The command is one of the editor’s built-in commands, named as in its command list, such as `save` or `zoomXIn`. Commands that are not built in are not counted | Count |

The source is `key`, `toolbar`, `menu`, `gesture`, `wheel`, `panel` or `button`. A command run by another command is not counted. A held key counts once, not for each repeat, and the mouse wheel counts once per visit for each command.

#### `edits`

Counts by edit type, including Timeline restores and uses of Undo and Redo.

| Field | Meaning | Format |
| --- | --- | --- |
| `undo`, `redo` | Uses of Undo and Redo | Count |
| `note.add`, `note.generate`, `note.elevation`, `note.combine`, `note.split`, `note.vertical` | Notes added, generated, changed in elevation, combined, split or made vertical | Count |
| `object.add`, `object.edit`, `object.move`, `object.replace`, `object.paste`, `object.brush`, `object.delete`, `object.cut`, `object.flip`, `object.scale` | Objects added, edited, moved, replaced, pasted, changed with Brush, deleted, cut, flipped or scaled | Count |
| `property.set`, `header.set`, `levelInfo.set`, `bgm.change`, `dynamicStages.enable` | Changes to properties, Initial Life, the music offset, level info or music, and uses of Enable Dynamic Stages | Count |
| `owner.create`, `owner.rename`, `owner.set`, `owner.move`, `owner.moveMany`, `owner.duplicate`, `owner.delete`, `owner.ungroup` | Stages, groups and their folders created, renamed, changed, moved, duplicated, deleted or ungrouped | Count |
| `restore` | Timeline steps restored | Count |

#### `features`

| Field | Meaning | Format |
| --- | --- | --- |
| `historyPanel`, `historyDialog`, `recentTab` | Times the History panel was shown, the History dialog was opened and the Recent Sessions tab was opened | Count |
| `peek`, `peekRefused` | Timeline steps viewed and commands refused while viewing a step | Count |
| `restore`, `restoreSession`, `restoreCopy` | Timeline steps restored, stored sessions restored and stored sessions restored as copies | Count |
| `saveRowToFile`, `deleteSessions` | Uses of **Save…** for a stored session and confirmations of **Delete Sessions…** | Count |
| `minimapDrag`, `minimapJump` | Drags and jumps using the minimap | Count |
| `autoscroll`, `quickSwitch` | Times Autoscroll started and tools chosen through Quick Switch | Count |

#### `notices`

| Field | Meaning | Format |
| --- | --- | --- |
| `info`, `warning`, `error` | The number of notices of each severity shown by the editor | Count |

#### `errors`

No crash reports are sent. The `errors` event contains only counts, without error messages or stack traces.

| Field | Meaning | Format |
| --- | --- | --- |
| `error` | The number of errors caught by the editor | Count |
| `csp` | The number of times the browser blocked a resource under the page’s content security policy | Count |

### `peek`

Sent with `perf` when Timeline steps were viewed since the previous batch.

| Field | Meaning | Format |
| --- | --- | --- |
| `peek.<time>` | The number of Timeline steps in each duration range. Timing starts when loading begins, after any initial delay, and ends when the step is shown with its change | Count for each range |
| `peek.cached` | The number of steps shown from the cache and not timed | Count |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### `perf`

Sent with every batch. Measurements cover the interval since the previous batch, or since collection began for the first batch.

| Field | Meaning | Format |
| --- | --- | --- |
| `loafSupported`, `eventTimingSupported` | Whether the browser can report long frames and slow responses | Yes or no |
| `frames.<state>.<length>` | The number of long frames (frames that took 50 milliseconds or more), grouped by duration and by the editor’s state when the frame began. The state is `playing` for visible playback, `busy` during an Open, Save, Check, Restore or music load, and `other` for the rest | Count for each state and range |
| `frames.unclassified` | Long frames that began too long ago to be classified by state | Count |
| `frameAttribution` | Whether every long frame in this batch was classified by state (`full`) or some were not (`partial`) | `full` or `partial` |
| `slowEvents.<length>` | The number of clicks, key presses and similar inputs with response times of 104 milliseconds or more, grouped by duration | Count for each range |
| `interactions` | The browser’s interaction count. Omitted when the browser does not provide a count | Count |
| `playSeconds` | The time spent playing since the previous batch, counted only while the page was visible | Seconds |
| `visibleTime` | The time the page was visible since the previous batch | Seconds |
| `previewHost` | The thread used to draw the preview during this interval. `none` means the preview was not shown, `mixed` means the value changed, and `unknown` means the thread could not be determined | `main`, `worker`, `none`, `mixed` or `unknown` |
| `previewRenderScale` | The preview’s render scale during this interval, with `mixed` when it changed | `0.25`, `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75`, `2`, `mixed` or `unknown` |
| `cores`, `deviceMemory`, `engine`, `touch`, `dpr`, `viewport`, `viewportHeight`, `viewportAspect` | The device details above | As above |

### `unsupported`

The page shown to unsupported browsers sends one request, on the first interaction while the page is visible. The request follows the statistics setting, Do Not Track and Global Privacy Control. It is not sent when the browser’s data saver is on, in automated browsers or from copies hosted on another site.

| Field | Meaning | Format |
| --- | --- | --- |
| `engine` | The browser engine | `chromium`, `webkit`, `firefox` or `other` |

## Data Derived by the Server

The server receives your IP address and your browser’s full user agent with each request. The user agent is sent in the request headers. Requests from known automated clients are discarded.

The server estimates your country from your IP address and identifies your browser and operating system from the user agent. It estimates the device type, such as desktop, laptop, mobile or tablet, from the user agent and screen width. The location lookup can also return a region and city. Neither is stored.

To group activity within a day, the server creates a visitor identifier from the site, your IP address, your user agent and a value that changes daily. People whose browsers send the same user agent from the same IP address can share an identifier.

The server stores a visitor record containing the country, browser, operating system, device type and daily visitor identifier, along with the `language` and `screen` fields as the editor sent them. The statistics do not contain your IP address. The server sets no cookies and stores nothing in your browser.

## Data Retained by the Server

- **Individual records**, including events, their fields and associated visitor records, are kept for up to 13 months. Older records are deleted every night. Visitor records older than 13 months are deleted once they have no events left. Backups on AWS are kept for up to six weeks after each backup is made.
- **Monthly totals** are kept indefinitely, without visitor identifiers. They contain:
    - counts of visits and daily visitor identifiers, with separate breakdowns by editor version, browser, operating system, device type, country and language;
    - the number of times each event was sent and each value was recorded for choice and yes-or-no fields;
    - the sum of each count field and the number of events that included it;
    - the median and the 90th and 99th percentiles of each duration in milliseconds (`ready`, `took` and `buildMs`), overall and by version, device type and their combination.
- **Weekly totals** are kept indefinitely. For each week beginning on Monday, they contain counts of visits, daily visitor identifiers and events by name, without further breakdowns.

Statistics for the main site and the test site are stored separately. Only the maintainer has access to the statistics dashboard.

A group’s total is kept only if the group includes at least 10 distinct visitor identifiers. Smaller groups are combined into `other`, and `other` is kept only if it reaches that minimum.

In monthly breakdowns by version, language, country or browser language, the server keeps separate totals for at most 50 values, or 100 for countries. It selects the values with the most distinct visitor identifiers and combines the rest into `other`.

Duration percentiles use groups defined by version and device type. Groups with fewer than 10 distinct visitor identifiers are omitted, and their measurements are excluded from every percentile calculation.
