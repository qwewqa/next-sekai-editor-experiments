# The `.nxsp` project file format (v1)

A complete description of the Next SEKAI Editor's project file, written so that a reader with no access to the editor's code can build a compatible viewer: open any v1 file, classify it as the editor does, rebuild the chart at the head and at every stored History step, and list and interpret the History timeline. A short section at the end gives the writer's rules for those who also write files.

- **Status.** Format v1 (`project.json` `version` 1, `minor` 0, `patch` 0; manifest `version` 1; records `v` 1; `levelVersion` 1). **Unshipped:** until v0.6.0 ships, v1 is changed in place, with no version bumps and no compatibility handling. From the ship it is frozen, and any change follows [format-versioning.md](format-versioning.md).
- **Authority.** The code is in `src/local/nxsp/`, `src/local/records/`, `src/zip/`, `src/history/operations/`, `src/levelData/` and `src/chart/parse/levelData/`. Where this page and the code disagree, the code wins and this page is wrong. The design rationale is in [history-format.md](history-format.md) (§2–§4) and [format-versioning.md](format-versioning.md), and this page does not repeat it.
- **Background assumed.** Sonolus level data, the Next SEKAI engine's archetypes and what notes, slides, connectors, guides, time-scale groups, stages, the five event kinds, BGM and offset mean. ZIP, raw DEFLATE (RFC 1951), CRC-32, SHA-256, JSON and UTF-8.
- **Cross-check tools.** `tools/nxsp_check.py` is an independent reader and strict checker that shares no code with the editor (§17). The goldens and conformance cases are listed in §17.

## Contents

1. [Conventions and terms](#1-conventions-and-terms)
2. [Reading a file, in order](#2-reading-a-file-in-order)
3. [The ZIP container](#3-the-zip-container)
4. [Entries and pointers](#4-entries-and-pointers)
5. [`project.json`](#5-projectjson)
6. [The chart model](#6-the-chart-model)
7. [`level.json`](#7-leveljson)
8. [Snapshots: records, hashes, chunks, nodes, roots](#8-snapshots-records-hashes-chunks-nodes-roots)
9. [History parts: manifest, segments, `chunks.bin`](#9-history-parts-manifest-segments-chunksbin)
10. [Entries and the timeline](#10-entries-and-the-timeline)
11. [Operations: the envelope and shared values](#11-operations-the-envelope-and-shared-values)
12. [Every operation](#12-every-operation)
13. [What each tool and action records](#13-what-each-tool-and-action-records)
14. [Classification and report reasons](#14-classification-and-report-reasons)
15. [Reject, tolerate, ignore; reader caps](#15-reject-tolerate-ignore-reader-caps)
16. [Writer rules (for round-tripping)](#16-writer-rules-for-round-tripping)
17. [Worked examples, fixtures and tools](#17-worked-examples-fixtures-and-tools)

## 1. Conventions and terms

**Notation.** JSON values are written as JSON. `a | b` is a choice; `x?` an optional key or position; `[a, b, c]` a positional array (a record). Byte layouts are little-endian. "Must" states a rule whose breach changes the classification (§14). "The writer" means the editor's v1 writer, and "the reader" means the editor's v1 reader. A compatible viewer imitates the reader.

**Integers and numbers.** A *safe integer* is an integer `n` with `|n| <= 2^53 - 1`. A *count* (`uint`) is a safe integer `>= 0`; an *id* a safe integer `>= 1`. Numbers are judged by value as `JSON.parse` reads them (`1`, `1.0` and `1e0` are one value; `-0` is the count 0, never an id). A *finite number* is any JSON number that is not infinite after parsing (a literal past the double range parses to infinity and fails).

**Text.** JSON text is UTF-8 without a byte-order mark; a reader strips one leading U+FEFF. A string is *well formed* when it holds no lone UTF-16 surrogate. The writer makes the strings of `project.json` and the entries well formed (a lone surrogate becomes U+FFFD). Record strings (§8.1) and `level.json` are written as the state holds them, with a lone surrogate escaped (`"\ud83d"`), so a reader must accept that escape. The editor makes text well formed where it enters the state (`docs/history-format.md`), so its own records hold none; the rule is for files other writers produce.

**Hashes.** *hash16* is the first 16 bytes of SHA-256. In files it is written as exactly 32 lowercase hex characters (`^[0-9a-f]{32}$`, the whole string); anything else (uppercase, 31 or 33 characters, a trailing newline) is not a hash. A full SHA-256 is 64 lowercase hex characters.

**Times.** `time`, `fromTime` and `targetTime` are milliseconds since the Unix epoch (UTC). `revision.savedAt` is the one string time (§5.3).

**Units.** Beats are beats. Lanes are lane units. The stage is 12 lanes wide, lane 0 its centre, so a left edge of `-6` and a width of `12` cover it. `bgmOffset` is in seconds everywhere in the file (the editor shows milliseconds). `initialLife` is a plain number.

**Terms.**

| Term | Meaning |
| --- | --- |
| chart | Notes, BPM changes, time scales, groups, stages, folders and events, with Initial Life and the dynamic-stages flag (§6). |
| state | A chart plus the header extras: BGM offset, level info and the BGM's metadata. |
| record | A JSON array whose positions are fields (§8.1). |
| snapshot | One state, stored as a tree: a root, kind nodes, a header chunk and body chunks, all named by hash (§8). The root's hash is the snapshot id. |
| chunk | A JSON array (the header record, or a list of records of one kind), stored raw-DEFLATE in `chunks.bin`. |
| entry | One row of the History chronology: an edit, an undo, a save, and so on (§10). |
| step | An undoable change: what an `edit`, `restore` or `init` entry pushes onto the undo stack, and what `undo` and `redo` cross. |
| operation | The JSON envelope that describes a step or an event: what the user did, never what the chart is (§11). |
| session | One visit's run of entries; in a file, sessions are separated by `continue` entries. |
| chain | All sessions of one document. A file's chronology is one chain's, oldest first. |
| head | The state the file shows now: `level.json` with `project.json`, or the History head when they match (§10.6). |
| History head | `undoStack.slots[index - base].snapshot` (§9.4). |
| owner | A group, stage, group folder or stage folder. |
| report | The list of reasons a reader did not read something (§14). Any reason other than `newer-patch` makes the open *partial*. |

## 2. Reading a file, in order

The editor's reader (`readNxsp`, `src/local/nxsp/read.ts`) does the following. A compatible viewer follows the same order, because the order decides the classification.

1. **Open the ZIP** (§3). Not a ZIP at all: `unreadable`. A directory that cannot be read but local headers that can: entries come from a scan, and the report gets `damaged` (the file can still open, without history). Duplicate names and overlapping data: `damaged` for each.
2. **Find `project.json`** by name. Absent: `not-project` (unless the name is ambiguous, then `unreadable`). Read it (cap 1 MiB, JSON depth 64); a failure is `unreadable`. Not an object, or `format` not `"nxsp"`: `not-project`.
3. **Check `version`.** A safe integer above 1: `newer-version`; only `level.json` is read, nothing else in `project.json` is interpreted, no history and no media. Otherwise anything but `1` adds `invalid-key` (path `version`) and reading goes on as v1.
4. **Read the v1 keys** of `project.json` (§5): unknown keys go to *extra* (kept, never reported), wrong forms are `invalid-key`, unknown keys inside the closed objects are `unknown-key`. Then `minor > 0`: `newer-minor`; `patch > 0`: `newer-patch`; `levelVersion > 1`: `newer-level`.
5. **Check the pointers** (§4): each in its own prefix, no two on one entry (else `damaged`); every other entry that is not ignored is `unknown-entry`.
6. **Read `level.json`** (cap 64 MiB). Missing or unreadable: `unreadable`. Top-level keys other than `bgmOffset` and `entities`: `unknown-key`.
7. **Read the media** (§5.5): each `file` entry checked for size and SHA-256 (`media-unreadable` on a mismatch or when missing).
8. **Read the history** (§9) only when `project.json` has `history` and the report holds no `damaged` and no `newer-minor`. Any failure here adds its reasons and leaves the history unread; the level still opens. A manifest or segment that fails as a ZIP entry, is not UTF-8, is not JSON or is nested deeper than 64 is `damaged`, as is a part past its cap or the parts together past theirs; any other failure is `history-unreadable`, `newer-history` or `unknown-key` (§14.2).
9. **Classify** (§14): `open` is `full` when the report is empty or holds only `newer-patch`, else `partial`.

Then the editor parses `level.json` into a chart (§7), decides the head (§10.6), and imports the history.

## 3. The ZIP container

### 3.1 What the writer writes

A plain ZIP: for each entry a local header and its data, then the central directory records in entry order, then the end record. Nothing between or after. Never ZIP64, never a data descriptor, never an extra field or a comment, never a directory entry.

Local header (30 bytes + name):

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 4 | `50 4b 03 04` |
| 4 | 2 | version needed `0x0014` |
| 6 | 2 | flags `0x0800` (bit 11, UTF-8 names; nothing else) |
| 8 | 2 | method: 0 (STORE) or 8 (DEFLATE) |
| 10 | 2 | DOS time |
| 12 | 2 | DOS date |
| 14 | 4 | CRC-32 of the uncompressed bytes |
| 18 | 4 | compressed size |
| 22 | 4 | uncompressed size |
| 26 | 2 | name length |
| 28 | 2 | extra length, 0 |
| 30 | n | name |

Central record (46 bytes + name): `50 4b 01 02`, version made by `0x0014`, version needed `0x0014`, flags `0x0800`, method, time, date, CRC, sizes, name length, then extra, comment, disk, internal attributes all 0, external attributes 0 (4 bytes), the local header's offset (4 bytes), the name.

End record (22 bytes): `50 4b 05 06`, disk numbers 0, the entry count twice, the directory's size, its offset, comment length 0.

- **CRC-32** is zlib's (reflected polynomial `0xEDB88320`, initial value and final XOR `0xFFFFFFFF`).
- **DEFLATE** is raw (RFC 1951, no zlib or gzip wrapper).
- **Times.** Every entry has the same DOS time and date, from `revision.savedAt` in UTC (seconds halved, rounded down; clamped to 1980-01-01 00:00:00 … 2107-12-31 23:59:58). `time = hour << 11 | minute << 5 | second >> 1`, `date = (year - 1980) << 9 | month << 5 | day`.
- **Names** are ASCII `0x21`–`0x7E`, relative, `/`-separated, no `..` segment, no leading `/`, not ending in `/`, unique.
- No `.nxsp` has a registered MIME type; the editor hands files over as `application/octet-stream`.

### 3.2 What a reader accepts

A reader is more tolerant, so that an operating system's re-zip still opens.

- **End record.** Search the last 65,535 + 22 + 20 bytes backwards for `50 4b 05 06`; take the first found (nearest the end) whose comment length runs exactly to the end of the file, else the one nearest the end whose comment fits. When the entry count is `0xFFFF` or the directory size or offset is `0xFFFFFFFF`, a ZIP64 locator must sit 20 bytes before it and the ZIP64 end record is used.
- **Central directory.** At most 65,535 entries; more is damage that no scan may get around (`unreadable` if it stops everything). The directory must lie inside the file and hold at least 46 bytes per entry. An entry whose least range (local header, name and compressed data) runs past the file means the file was cut, and the directory is not trusted.
- **Scan.** When the directory cannot be read, entries are read by walking local headers from offset 0 (stopping at the first non-header, at a data descriptor without sizes, or at a header whose data runs past the file). The result is flagged *recovered* and reported `damaged` (path `""`, "central directory"). Such a file never opens with history. No entry found: `unreadable`.
- **Names.** Bit 11 set: UTF-8 (invalid bytes become U+FFFD). Bit 11 clear: UTF-8 when valid, else CP437. A leading U+FEFF is kept (so `﻿bgm/a.mp3` is not `bgm/a.mp3`). Names are compared in Unicode NFC.
- **Directories and clutter are ignored:** names ending in `/`, anything under `__MACOSX/` or `cache/`, and any entry whose last path component is `.DS_Store`, `Thumbs.db`, `desktop.ini` or starts with `._`. Ignored entries are never `unknown-entry`, but they still count for overlaps.
- **Ambiguity.** Two entries with one NFC name are both unfindable by that name (`damaged` "two entries with this name"). Overlapping data ranges (by the least range from the directory, and again by the real range with each local header's extra field) are `damaged` "overlapping data" for both entries, ignored entries included.
- **Reading an entry** (every read, every entry): the encryption flag (bit 0) is refused; a method other than 0 or 8 is refused; the declared size must be within the entry's cap; STORE needs `compressedSize == size`, DEFLATE `compressedSize <= 2 * size + 1024`; the local header must repeat the directory's name bytes and method, and its CRC and sizes unless bit 3 is set and they are 0 or `0xFFFFFFFF`; DEFLATE must inflate to exactly the declared size with no input left over and the final block set; the CRC must match. Any failure is `damaged` for that entry (for `project.json` and `level.json`, `unreadable`).
- **Tolerated:** STORE or DEFLATE for any entry, data descriptors, extra fields, ZIP64, any entry order, any flags but bit 0, any DOS time.

## 4. Entries and pointers

| Entry | Writer's method | Named by | Holds |
| --- | --- | --- | --- |
| `project.json` | 8 | fixed name | Identity, revision, level info, pointers, summary (§5) |
| `level.json` | 8 | `level` (must be `"level.json"`) | The chart now, as level data (§7) |
| `history/segments/<n>.json` | 8 (a segment copied whole keeps its method) | `history.segments[n-1]` | Older parts of the chronology (§9) |
| `history/manifest.json` | 8 | `history.manifest` | The newest part and the undo stack (§9) |
| `history/chunks.bin` | 0 | `history.chunks` | Every chunk's stored bytes, concatenated (§9.3) |
| `assets/cover.<ext>` | 0 | `metadata.cover.file` | The head's cover, when held |
| `assets/preview.<ext>` | 0 | `metadata.preview.file` | The head's preview audio, when held |
| `bgm/<name>` | 0 | `bgm.file` | The head's BGM, when held |

The writer's order is the table's (segments by number). Readers do not depend on order.

**Pointer rules.** Each pointer must stay in its prefix: `level` must equal `level.json`; `bgm.file` must start with `bgm/`, `metadata.cover.file` with `assets/cover.`, `metadata.preview.file` with `assets/preview.`, and `history.manifest`, `history.chunks` and each segment with `history/`, and none may equal its bare prefix. Two pointers must not name one entry (compared in NFC). A breach is `damaged` at the pointer's path (`level`, `bgm.file`, `history.segments[0]`, …).

**Unknown entries.** Every entry that is not ignored (§3.2), not `project.json` and not named by a pointer is `unknown-entry` (partial open). A reader of a newer-major file does not check entries.

Entry names other than `project.json` and `level.json` are cosmetic. Readers find entries only through pointers. The writer's media names are in §16.3.

## 5. `project.json`

A JSON object, compact, UTF-8.

### 5.1 Keys

| Key | Form | Rule |
| --- | --- | --- |
| `format` | `"nxsp"` | Anything else: `not-project`. |
| `version` | integer | `1`. A safe integer above 1: `newer-version`. Anything else: `invalid-key` (read as 1). |
| `minor` | count | Absent reads as 0. Above 0: `newer-minor` (history not read). Not a count: `invalid-key`. |
| `patch` | count | Absent reads as 0. Above 0: `newer-patch` (a notice; the open stays full). Not a count: `invalid-key`. |
| `levelVersion` | safe integer `>= 1` | Above 1: `newer-level`. Else `invalid-key`. |
| `appVersion` | string | The last writer's app version. Required (`invalid-key`). |
| `id` | non-empty string | The document id. Required. |
| `lineageId` | non-empty string | Provenance; copied by forks and Save As. Required. |
| `revision` | object, optional on read | §5.3. Any form error: `invalid-key` and the whole `revision` reads as absent. |
| `name` | string, optional | The chain's name. The apps name a file brought into their library by it. The web reads it and does not write it, as its names are automatic (a copy's "(2)", a lost file's stem). |
| `exportName` | string, optional | The name Export uses (may be `""`). |
| `level` | string | Must be `"level.json"` (§4). |
| `editor` | object, optional (`{}`) | Only `defaultGuideColors`: an array of counts, indices into `level.json` `entities` (§7.6). Other keys: `unknown-key`. A bad array: `invalid-key`, read as absent. |
| `bgm` | media form, optional | The head's BGM (§5.5). Absent means left out, not removed. |
| `history` | object, present exactly when the file has history | `{manifest, chunks, entries, segments?}`: `manifest` and `chunks` strings, `entries` a count (the total entry count over all parts), `segments` an array of strings. More than 4,096 segments: `damaged` (`history.segments`). Any other key: `unknown-key`, and the whole `history` reads as absent. |
| `summary` | object, optional | `{noteCount, durationMs, revisionId}` (counts and a string) from the head. Used only when `revisionId == revision.id`; a bad or stale `summary` is ignored, never reported. |
| `metadata` | object, optional | Level info (§5.4). |
| `parts` | object | Reserved, never written. Every key in it: `unknown-key` (`parts.<key>`). Not an object: `damaged`. Never kept. |
| anything else | any JSON | *Extra*: kept and written back unchanged by every Save; never reported. |

Unknown keys inside `revision` and `summary` are ignored. Unknown keys inside `metadata` are extra (kept under `metadata`).

### 5.2 Example

From the minimal file of §17.1 (a Save with History off):

```json
{"format":"nxsp","version":1,"minor":0,"patch":0,"levelVersion":1,"appVersion":"0.6.0","id":"doc-01","lineageId":"lineage-01","revision":{"id":"a001-0000-4000-8000-000000000000","parent":null,"n":1,"savedAt":"2026-10-20T08:00:00Z","device":{"id":"d3v1ce00-0000-4000-8000-000000000001","label":"Web (Chrome)"},"ancestors":[],"fileName":"minimal.nxsp"},"level":"level.json","editor":{},"summary":{"noteCount":2,"durationMs":2000,"revisionId":"a001-0000-4000-8000-000000000000"}}
```

### 5.3 `revision`

`{id, parent, n, savedAt, device: {id, label}, ancestors, replaces?, fileName?, completeFrom?}`.

| Key | Rule |
| --- | --- |
| `id` | Non-empty string, new for every write. |
| `parent` | `null` (a new document) or a non-empty string: the revision this one descends from. |
| `n` | Count, display only (parent's `n` + 1). |
| `savedAt` | RFC 3339 `date-time`: `YYYY-MM-DDThh:mm:ss`, an optional `.fraction`, then `Z` or `±hh:mm`; uppercase `T` and `Z`; a date that exists; seconds 00–59 (no leap second). Anything else, a non-string included, reads as **absent**, never as a reason for a partial open. The writer writes UTC to the second (`2026-10-20T08:00:00Z`). |
| `device` | `{id, label}`, both strings. `id` names the writing install **for this document's lineage**: the web computes HMAC-SHA-256 with the browser's own `deviceId` as the key and `lineageId` as the message, both UTF-8, takes the first 16 bytes, sets the high nibble of byte 6 to 8 (UUID version 8) and the top two bits of byte 8 to `10` (the variant), and writes them as a lowercase hyphenated UUID. So one install's files of two lineages carry different ids and files of one lineage the same. Readers treat it as opaque and compare it only within a lineage. `label` is the install's label, such as `Web (Chrome)`. |
| `ancestors` | Array of non-empty strings, newest first; read as a set. The writer writes at most 1,024. |
| `replaces` | Optional string, written only by Replace. |
| `fileName` | Optional string: the file name this write used. |
| `completeFrom` | Optional, history writes only. A non-string reads as absent. **Placed** against `{id} ∪ ancestors`: the value when it is the file's own `id` or one of its ancestors, else the file's own `id`. It names the oldest revision whose history the file holds whole. |

### 5.4 `metadata` and level info

Keys, all optional: `title`, `artists`, `author`, `description` (strings), `rating` (finite number), `tags` (array of `{title}`, `title` a string), `cover`, `preview` (media forms). A wrong form is `invalid-key` at its path; a tag with another key is `unknown-key`.

The pinned mapping to a state's level info: an absent string is `""`; absent `tags` is `[]`; absent `rating` is "no rating" (a rating of `0` is written as `0`); `cover` and `preview` become media references (§6.6) from their forms. The writer leaves out empty strings and empty `tags`, and leaves `metadata` out when nothing is left.

### 5.5 Media forms

`bgm`, `metadata.cover` and `metadata.preview` take one of two forms, chosen by whether the key `file` is present:

| Form | Keys | Meaning |
| --- | --- | --- |
| Held | `{file, filename?, type, sha256, size}` | `file` the entry name; `sha256` 64 hex of the entry's bytes; `size` a count. |
| Metadata only | `{filename?, type, hash, size}` | `hash` a hash16 (32 hex). The file does not hold the bytes. |

Any key outside the form's list is `unknown-key` (so `file` with `hash`, or `sha256` without `file`, fails); a wrong type is `invalid-key`; either drops that media item. `type` may be `""`. The writer never writes an empty `filename`.

A held item's entry is read (cap 1 GiB): missing, or a size or SHA-256 that differs, is `media-unreadable` (with `media: bgm | cover | preview`); a ZIP failure reading it is `damaged`. The rest of the file still opens.

A form's **media reference** (§6.6) is `{hash, filename, size, type}`, `hash` being the first 32 characters of `sha256` or `hash`. For `bgm`, `filename` is `filename`, else (held) the entry name after `bgm/` in NFC, else `""`.

## 6. The chart model

The model a file stores, defined once; `level.json` (§7) and snapshot records (§8) are two encodings of it. Field names are the record field names. "Domain" is what the format accepts; the editor enforces tighter ranges in its tools and in the level-data parser (§7.7), never in records.

### 6.1 The chart and its header

| Field | Domain | Meaning |
| --- | --- | --- |
| `initialLife` | finite number (level data: integer `>= 1`) | Initial Life. The editor's new chart has 1000. |
| `isDynamicStages` | boolean | Dynamic stages on. Off: the chart has one stage and no events; level data holds no `Stage` entities. |
| `bgmOffset` | finite number, seconds | The BGM offset. |
| `groups` | list of groups (§6.2) | Time-scale groups, in tree order. |
| `stages` | list of stages (§6.2) | In tree order. |
| `groupFolders`, `stageFolders` | lists of folders (§6.3) | Editor-only folders. |
| `levelInfo` | §6.6 | Title, artists, author, description, tags, cover, preview, rating. |
| `bgm` | BGM reference or absent (§6.6) | Which audio the state uses, whether or not the file holds it. |
| `slides`, `bpms`, `timeScales`, `cameraEvents`, `stageMaskEvents`, `stagePivotEvents`, `stageStyleEvents`, `stageTransformEvents` | lists (§6.4, §6.5) | The chart objects. |

**Order is state.** Within each event kind, events on one track (the stage, or the group for time scales; one track for BPMs and camera events) that share a beat play in list order (chain order). A slide's notes are in beat order, ties in list order. Readers keep list order.

### 6.2 Groups and stages

| Object | Field | Domain | Meaning |
| --- | --- | --- | --- |
| group | `id` | id, unique among groups | |
| | `name` | string | The editor never stores an empty or all-whitespace name. |
| | `forceNoteSpeed` | finite number; `0` means none (level data: 0, or 1 to 12) | Force Note Speed. |
| | `folderId` | id of a group folder, optional | The group's folder. |
| stage | `id` | id, unique among stages | |
| | `name` | string | As for groups. |
| | `isFromStart`, `isUntilEnd` | boolean | From Start, Until End. |
| | `generateSimLines` | `global` \| `isolated` | Sim lines across all such stages, or within this stage only. |
| | `folderId` | id of a stage folder, optional | |

Every chart has at least one group and one stage. The *default* group or stage is the first in tree order.

### 6.3 Folders and the tree

A folder is `{id, name, index, folderId?}`. Folder ids are unique across both folder lists together. `index` (count) is how many entries precede the folder in the flat order; it places a folder without members. `folderId` on a folder is a parent link reserved for nesting. This build never sets it, the format keeps it, and it must not loop. Membership is the entry's `folderId`.

The tree a viewer shows is built from the flat list (`buildFolderTree`, `src/chart/folders.ts`):

1. Collect each folder's members (entries whose `folderId` names an existing folder), in list order. A link to a missing folder counts as none.
2. Folders without members are placed by `index`: sort them by `index` (stable).
3. Walk the entries in list order with a position counter starting at 0. Before each entry, emit every memberless folder whose `index <= position`; then increment the position. A loose entry is emitted as an item; the first member of a folder emits the folder with all its members; later members emit nothing.
4. After the walk, emit the remaining memberless folders.

The editor keeps lists normalised: each folder's members contiguous, entries in depth-first tree order, and each folder's `index` equal to the number of entries before it.

### 6.4 Notes and slides

A **slide** is a non-empty list of notes in beat order (ties in list order). A one-note slide is a single note. The connector between consecutive notes of a slide is described by the fields of its notes as level data does. The slide is cut into segments at its first note and at each note with `isConnectorSeparator`; a segment's type, colour, fake and critical flags, guide alpha, layer, pass-through and presentation come from its first note (the segment head); each note's `connectorEase` eases the connector leaving it.

| Field | Domain | Meaning |
| --- | --- | --- |
| `groupId` | id of a group | Time-scale group. |
| `stageId` | id of a stage | Stage. |
| `beat` | finite number (level data: `>= 0`) | Beat. |
| `elevation` | finite number, default 0 | Elevation (engine revision 2: not scaled by stage tilt). |
| `noteStyle` | `default neutral red green blue yellow purple cyan black` | Note colour; `default` is the engine's own. |
| `connectorStyle` | the same set | Connector colour; for a guide, `default` is the default guide colour (drawn green). |
| `noteType` | `default trace anchor damage forceTick forceNonTick` | `default`: tap, or tick in the middle of an active connector; `forceTick` and `forceNonTick` force the other; `trace`, `anchor`, `damage` as the engine. |
| `isAttached` | boolean | Attached to its connector (meaningful only for a middle note). |
| `left` | finite number, lanes | Left edge. |
| `size` | finite number, lanes (level data: `>= 0`) | Width. |
| `isCritical` | boolean | Critical. |
| `flickDirection` | `none up upLeft upRight down downLeft downRight` | Flick, or none. |
| `isFake` | boolean | Fake note. |
| `sfx` | `default none normalTap criticalTap normalFlick criticalFlick normalTrace criticalTrace normalTick criticalTick damage` | Sound effect. |
| `isConnectorSeparator` | boolean | Starts a new connector segment. |
| `connectorType` | `active guide damage` | Connector type. |
| `connectorEase` | an ease (§6.7) | Ease of the connector leaving the note. |
| `connectorIsFake` | boolean | Fake connector. |
| `connectorActiveIsCritical` | boolean | Critical active connector. |
| `connectorGuideAlpha` | finite number (level data: 0 to 2) | Guide alpha. |
| `connectorLayer` | `top bottom under over` | Connector layer. |
| `connectorIsPassThrough` | boolean | Passes through the judgment line. |
| `connectorPresentation` | `default fullscreen` | Connector presentation. |

### 6.5 BPM changes, time scales and events

| Kind (list) | Fields (domain) |
| --- | --- |
| BPM change (`bpms`) | `beat` (finite; one must be at beat 0), `bpm` (finite; level data `> 0`), `meter` (finite, default 4; level data `> 0`) |
| time scale (`timeScales`) | `groupId` (id of a group), `beat`, `editorLane` (finite: the lane the editor draws its marker in; level data default −6), `timeScale` (finite), `skip` (finite), `timeScaleEase` (an ease without Back and Elastic), `timeScaleTransition` (`timeScale` \| `scroll`), `hideNotes` (boolean) |
| camera event (`cameraEvents`) | `beat`, `cameraLeft`, `cameraSize` (lanes; level data: `cameraSize` 6 to 24), `cameraZoom` (level data `>= 0.01`), `cameraZoomTargetLane`, `cameraZoomTargetY` (level data −1 to 1), `cameraZoomVerticalAlign` (`default` \| `center`), `cameraRotation`, `cameraStageTilt` (level data 0 to 1), `eventEase` |
| stage mask event (`stageMaskEvents`) | `stageId`, `beat`, `maskLeft`, `maskSize` (lanes; level data `>= 0`), `isMaskNotes` (boolean), `eventEase` |
| stage pivot event (`stagePivotEvents`) | `stageId`, `beat`, `pivotLane`, `divisionSize` (level data: integer `>= 1`), `divisionParity` (`even` \| `odd`), `yOffset`, `yOffsetBeat`, `eventEase` |
| stage style event (`stageStyleEvents`) | `stageId`, `beat`, `editorLane` (marker lane), `judgmentLineColor` (`neutral red green blue yellow purple cyan black`), `judgmentLineStyle` (`default` \| `singleLine`), `leftBorderStyle`, `rightBorderStyle` (`default light medium disabled`), `isFullWidth` (boolean), `noteAlpha`, `laneAlpha`, `judgmentLineAlpha`, `divisionLineAlpha` (level data 0 to 1), `eventEase` |
| stage transform event (`stageTransformEvents`) | `stageId`, `beat`, `rotation`, `xTranslation`, `yTranslation` (lanes), `elevation`, `anchor` (`default` \| `center`), `eventEase` |

All unlisted numbers are finite numbers. `eventEase` is any ease (§6.7): the ease from this event to the next on its chain.

### 6.6 Level info and media references

Level info: `title`, `artists`, `author`, `description` (strings; `""` is unset), `tags` (list of `{title}`), `cover`, `preview` (media references, optional), `rating` (finite number, optional).

A **media reference** is `{hash, filename, size, type}`: `hash` the hash16 of the bytes (32 hex), `filename` the picked file's name or `""`, `size` a count, `type` the sniffed MIME type or `""`. A **BGM reference** adds an optional `durationMs` (count, the decoded length rounded). A state names media by reference whether or not any file holds the bytes; a restored state whose media are not in the file shows them as "not loaded".

### 6.7 Eases

`none`, `linear`, and the 40 names `<mode><Function>` with mode `in out inOut outIn` and function `Sine Quad Cubic Quart Quint Expo Circ Back Elastic Step` (for example `inOutSine`, `outInStep`). A time-scale ease excludes the Back and Elastic eight (34 values).

## 7. `level.json`

### 7.1 Form

`{"bgmOffset": number, "entities": [LevelDataEntity, ...]}`: ordinary Sonolus level data, not gzipped, the same the editor exports. An entity is `{name?: string, archetype: string, data: [{name, value: number} | {name, ref: string}, ...]}`. Top-level keys other than `bgmOffset` and `entities` are `unknown-key`. The file's chart *now* is this value with `project.json`'s level info and BGM (§10.6).

Ids are not in level data. A parse numbers groups, stages and folders afresh. Default guide colours (§7.6) and level info and BGM metadata (`project.json`) are kept outside it.

### 7.2 Entities the editor writes, in order

| # | Archetype | When | Data, in order |
| --- | --- | --- | --- |
| 1 | `Initialization` | always, first | `initialLife` (value), `revision` (value, the engine revision, 2), `firstCamera` (ref, when camera events exist) |
| 2 | `#BPM_CHANGE` | per BPM change | `#BEAT`, `#BPM`, `meter` |
| 3 | `#TIMESCALE_GROUP` | per group, in list order | `editorName` (**ref** holding the name), `forceNoteSpeed` (when not 0), `editorFolder` (ref, when in a folder), `first` (ref to its first time scale) |
| 4 | `Stage` | per stage, dynamic stages only | `editorName` (ref), `fromStart` (0/1), `untilEnd` (0/1), `generateSimLines` (0 global, 1 isolated), `editorFolder` (ref), `firstMaskChange`, `firstPivotChange`, `firstStyleChange`, `firstTransformChange` (refs, when that stage has such events) |
| 5 | `CameraChange` | dynamic stages only | `#BEAT`, `lane`, `size`, `zoom`, `zoomTargetLane`, `zoomTargetY`, `zoomVerticalAlign`, `rotate`, `stageTilt`, `ease`, `next` |
| 6 | `StageMaskChange` | dynamic only | `#BEAT`, `lane`, `size`, `maskNotes`, `ease`, `next` |
| 7 | `StagePivotChange` | dynamic only | `#BEAT`, `lane`, `divisionSize`, `divisionParity`, `yOffset`, `yBeatOffset`, `ease`, `next` |
| 8 | `StageStyleChange` | dynamic only | `#BEAT`, `editorLane`, `judgeLineColor`, `judgeLineStyle`, `leftBorderStyle`, `rightBorderStyle`, `fullWidth`, `noteAlpha`, `laneAlpha`, `judgeLineAlpha`, `divisionLineAlpha`, `ease`, `next` |
| 9 | `StageTransformChange` | dynamic only | `#BEAT`, `rotate`, `xLaneTranslate`, `yLaneTranslate`, `elevation`, `anchor`, `ease`, `next` |
| 10 | `#TIMESCALE_CHANGE` | per time scale | `#TIMESCALE_GROUP` (ref), `#BEAT`, `editorLane`, `#TIMESCALE`, `#TIMESCALE_SKIP`, `#TIMESCALE_EASE`, `transitionStyle` (0 timeScale, 1 scroll), `hideNotes` (0/1), `next` |
| 11 | notes, then `TransientHiddenTickNote` / `TransientHiddenDamageTickNote` and `Connector` entities, slide by slide; then `SimLine` entities | per slide | note data in §7.3 |
| 12 | `EditorGroupFolder` | per group folder | `editorName` (ref), `editorIndex` (value) |
| 13 | `EditorStageFolder` | per stage folder, dynamic only | as 12 |

`next` refs chain each event kind per track, and notes along a slide. Entity names are lowercase hex counters (`"0"`, `"1"`, …, `"a"`, …). Folder entities are named first, group folders then stage folders, whether or not anything refers to them; the parser skips a folder entity without a name. Every other entity is named in the order it is first referred to, and has no name if nothing refers to it. Records' order (§8.6) decides entity order and names, so level data is a function of the state.

### 7.3 Note entities

Archetype: `Fake` when `isFake`, then `Normal` or `Critical` (left out for anchor and damage), then the role's name and `Note`:

| Role | Plain | With a flick |
| --- | --- | --- |
| anchor | `Anchor` | `Anchor` |
| damage | `Damage` | `Damage` |
| trace (middle or single) | `Trace` | `TraceFlick` |
| trace at the head / tail of an active run | `HeadTrace` / `TailTrace` | `HeadTraceFlick` / `TailTraceFlick` |
| tick | `Tick` | `Tick` |
| single | `Tap` | `Flick` |
| head of an active run | `HeadTap` | `HeadFlick` |
| tail of an active run | `TailRelease` | `TailFlick` |

The role follows from `noteType` and the note's place in the slide's active connector runs: `anchor` → anchor; `damage` → damage; `forceTick` → tick; `trace` → trace, head trace or tail trace; `default` and `forceNonTick` → head, tail or single by place, and in the middle of an active run `default` is a tick and `forceNonTick` a single. A flick is `flickDirection != none`.

Data: `#TIMESCALE_GROUP` (ref), `stage` (ref; dynamic stages only), `#BEAT`, `lane = left + size / 2`, `size = size / 2`, `elevation` (only when not 0), `style`, `direction`, `isAttached` (1 only for an attached middle note), `isSeparator`, `connectorEase`, `segmentKind`, `segmentAlpha` (= `connectorGuideAlpha`), `segmentLayer`, `effectKind`, `segmentThroughJudgeLine`, `segmentPresentation`, then `next` (ref), `attachHead`/`attachTail` (attached middle notes), `activeHead` (the tail of an active run).

### 7.4 Value codes

| Field (level data) | Codes |
| --- | --- |
| `style` (noteStyle) | default 0, neutral 1, red 2, green 3, blue 4, yellow 5, purple 6, cyan 7, black 8 |
| `direction` | up 0, upLeft 1, upRight 2, down 3, downLeft 4, downRight 5 (a note without a flick writes 0 and a non-flick archetype) |
| `effectKind` (sfx) | default 0, none 1, normalTap 2, normalFlick 3, normalTrace 4, normalTick 5, criticalTap 6, criticalFlick 7, criticalTrace 8, criticalTick 9, damage 10 |
| `segmentLayer` | top 0, bottom 1, under 2, over 3 |
| `segmentPresentation` | default 0, fullscreen 1 |
| eases (`connectorEase`, `ease`, `#TIMESCALE_EASE`) | none 0, linear 1; then for functions in the order Quad, Sine, Cubic, Quart, Quint, Expo, Circ, Back, Elastic, Step (index `i`) and modes in, out, inOut, outIn (index `j`): `2 + 4i + j`. So inQuad 2, outQuad 3, inOutQuad 4, outInQuad 5, inSine 6 … outInCirc 29, inBack 30 … outInElastic 37, inStep 38 … outInStep 41. Time-scale eases exclude 30–37. |
| `zoomVerticalAlign` | default 0, center 1 |
| `divisionParity` | even 0, odd 1 |
| `judgeLineColor` | neutral 0, red 1, green 2, blue 3, yellow 4, purple 5, cyan 6, black 7 |
| `judgeLineStyle` | default 0, singleLine 1 |
| `leftBorderStyle`, `rightBorderStyle` | default 0, light 1, disabled 2, medium 3 (not the order of the names in §6.5) |
| `anchor` | default 0, center 1 |
| booleans (`fromStart`, `untilEnd`, `hideNotes`, `maskNotes`, `fullWidth`, `isAttached`, `isSeparator`, `segmentThroughJudgeLine`) | 1 or 0; a reader takes any non-zero number as true |
| camera and mask `lane`, `size` | `lane = left + size / 2`, `size = size / 2` |

**`segmentKind`.** For a guide: `100 + c`, `c` the guide colour's code (neutral 1 … black 8), a `default` guide colour written as green (103). Otherwise `family` is 3 for damage, 2 for a critical active connector, 1 for an active one; with `s` the `connectorStyle` code (0 for default): `(connectorIsFake ? 50 : 0) + (s > 0 ? 10 * family + s : family)`. The values are 1, 2, 3, 51, 52, 53, 101–108, and the coloured 11–18, 21–28, 31–38, 61–68, 71–78, 81–88.

### 7.5 Reading `level.json` into a chart

The editor's parse (`parseLevelDataChart`). A viewer that shows the head from level data follows it; a viewer that shows only History snapshots may skip it.

1. **Folders.** For `EditorGroupFolder`, then `EditorStageFolder`, every entity *with a name*: label `editorName` (blank or absent: the entity's name), index `editorIndex` (absent: infinity), parent `editorFolder`. A folder nested in another resolves to its outermost ancestor (a cycle roots at its first folder in entity order) and its members join that folder. Folder ids are numbered across both kinds, group folders first.
2. **Initialization** (only if it is the first entity): `initialLife` (default 1000), `firstCamera`.
3. **BPM changes**: every `#BPM_CHANGE` in entity order; `meter` default 4.
4. **Groups**: every `#TIMESCALE_GROUP` in entity order makes a group: name `editorName` (blank or absent: `#n`, one past the highest `#n` taken, or the localised "Default" for the first), `forceNoteSpeed` (0 reads as none), folder by `editorFolder`. None at all: one default group.
5. **Stages**: every `Stage` makes a stage (blank name: `#n`) and turns dynamic stages on; `generateSimLines` default 0. None: one default stage named `#1`, From Start and Until End on, dynamic stages off.
6. **Normalise folders** (§6.3): groups and stages are reordered into tree order (stage folders only with dynamic stages; without them stage folders are dropped).
7. **Events**: each kind is read only along its chains, from `Initialization.firstCamera` and each stage's `first…Change` refs, following `next`; entities not reached are not read. Any chain without dynamic stages is refused. A loop is refused. Defaults for absent optional fields: camera `zoom` 1, `zoomTargetLane` 0, `zoomTargetY` 0, `zoomVerticalAlign` 0, `rotate` 0, `stageTilt` 1; mask `maskNotes` 0; style `editorLane` 0, `judgeLineStyle` 0, `fullWidth` 0, `noteAlpha` 1, `divisionLineAlpha` 1, and a legacy `alpha` (default 1) multiplies `laneAlpha` and `judgeLineAlpha`; transform `elevation` 0. `lane`/`size` convert back as `left = lane - size`, `width = 2 * size`.
8. **Time scales**: each group's chain from `first` along `next` (stopping at a missing or repeated entity), then every other `#TIMESCALE_CHANGE` in entity order. `editorLane` default −6, `transitionStyle` default 0, `hideNotes` default 0.
9. **Notes**: a note entity without a name is a one-note slide (in entity order, these come first). Named notes are joined into slides by `next`; a slide is ordered by `#BEAT` (stable). For each note: `left = lane - size`, `size = 2 * size`, `elevation` default 0, `style` default 0, `effectKind` default 0, `isSeparator`, `segmentLayer`, `segmentThroughJudgeLine`, `segmentPresentation` default 0; connector type, fake and critical flags from `segmentKind`'s base kind; `connectorStyle` from the colour digit (guides 101–108 and coloured kinds), except that a note whose entity index is in `defaultGuideColors` and whose `segmentKind` is 103 has `connectorStyle: default`.
   - **Note archetypes** (`noteArchetypeNames` in `src/chart/parse/levelData/slide.ts`, 68 names), each with or without a leading `Fake`: `Normal` or `Critical`, then `Head`, `Tail` or nothing, then `Tap`, `Flick`, `Trace`, `TraceFlick` or `Release`, then `Note`; `NormalTickNote` and `CriticalTickNote`; `DamageNote` and `AnchorNote`. That is more than the writer uses (§7.3): `NormalReleaseNote`, `NormalHeadReleaseNote` and `NormalTailTapNote` are notes, not unknown archetypes.
   - `Fake` prefix: `isFake`. `AnchorNote`: `noteType: anchor`, no flick, `isCritical = connectorActiveIsCritical`. `DamageNote`: `noteType: damage`, no flick.
   - Otherwise `Critical` sets `isCritical`. After `Head`/`Tail`, a `Trace…` archetype is `noteType: trace` (a flick only for `TraceFlick`).
   - Else, with *prevActiveHead* meaning that an earlier segment head of the slide (its first note or a separator) was active with no non-active separator since: when there is none, or the note is the slide's last, or it is a separator whose connector is not active, a `Tick` archetype is `forceTick` (else `default`); otherwise (the middle of an active run) a non-`Tick` archetype is `forceNonTick` (else `default`). A flick only for a `…Flick` archetype.
   - `stage` ref: required with dynamic stages, refused without them.
10. **Ignored, rebuilt on export:** `Connector`, `SimLine`, `TransientHiddenTickNote`, `TransientHiddenDamageTickNote`; note fields `attachHead`, `attachTail`, `activeHead`; event fields `stage`; group field `editorHidden` (another editor's display flag). **Dropped:** `Skill`, `FeverChance`, `FeverStart`.
11. **Validate**: a BPM change at beat 0 must exist; no negative beat; no negative note size; every BPM positive and finite; every number finite.

**Report and refusal.** Unknown archetypes, unknown or doubled fields, a `ref` where a `value` belongs (or the reverse), and an engine `revision` above 2 are collected in a *level report*; any item makes the open partial ("Made by a newer version"). A choice value the parser does not know (a code outside §7.4's lists, a `forceNoteSpeed` outside 0 and 1–12) is reported and replaced by the field's default; the editor asks before opening such a file as a copy. A required field missing, a value outside the parser's schema (for example camera `size` outside 3–12, `zoom` below 0.01, an alpha outside 0–1, a `segmentAlpha` outside 0–2, `divisionSize` not a whole number `>= 1`, `initialLife` not a whole number `>= 1`, a negative `#BEAT`), a missing ref, a loop, or events without dynamic stages **refuse** the level, and nothing opens. Required fields are those §7.2 lists for each archetype, except these optional ones: every `Initialization` field, `#BPM_CHANGE.meter`, every `editor…` field, `forceNoteSpeed`, `first`, `next`, `generateSimLines`, the `first…Change` refs, `zoom`, `zoomTargetLane`, `zoomTargetY`, `zoomVerticalAlign`, `rotate` (camera), `stageTilt`, `maskNotes`, `editorLane`, `judgeLineStyle`, `fullWidth`, `noteAlpha`, `divisionLineAlpha`, `alpha`, `elevation`, `transitionStyle`, `hideNotes`, and note `stage`, `elevation`, `style`, `isSeparator`, `segmentLayer`, `effectKind`, `segmentThroughJudgeLine`, `segmentPresentation`.

### 7.6 `editor.defaultGuideColors`

Level data cannot say "the default guide colour": a default guide writes `segmentKind` 103 (green). `project.json` `editor.defaultGuideColors` lists the indices in `entities` of the note entities whose connector is a guide with `connectorStyle: default`. On read, a listed entity with `segmentKind` 103 reads as `default`.

### 7.7 Level-data ranges are not the format's

Records accept any finite number (§8). The level-data parser refuses values outside the engine's ranges, so the editor keeps its states within them. A viewer that reads snapshots must not refuse a record for a range.

## 8. Snapshots: records, hashes, chunks, nodes, roots

### 8.1 Records and canonical bytes

A **record** is a JSON array whose positions are fields; it holds only arrays, strings, finite numbers and booleans (no objects, no `null`). Optional fields come only at the end and an unset one is left off; fields the model fills with a default are always written.

**Canonical text** is ECMAScript `JSON.stringify` of the array: no whitespace, numbers by `Number::toString` (`-0` as `0`, `1e+21`, `1e-7`, `0.30000000000000004`, `5e-324`), strings by `QuoteJSONString` (`\"`, `\\`, `\b \f \n \r \t`, other controls as lowercase `\u00xx`, lone surrogates escaped, nothing else escaped, no Unicode normalisation). **Canonical bytes** are that text in UTF-8. A record's **hash** is hash16 of its canonical bytes, never of stored or deflated bytes.

### 8.2 Chunks

A chunk's stored form is one raw DEFLATE stream of its bytes. Reading a chunk is strict. The stream must end exactly at its last byte, with the final block set and no input left over; it must inflate to at most 16 MiB; the inflated bytes must hash to the chunk's name; and they must parse as JSON (depth 64). A chunk that hashes to its name but is not canonical (whitespace, `1.0`) is accepted as it is. A chunk is either the header record (§8.4) or a body chunk: an array of records of one kind, possibly empty (no records).

### 8.3 Kind nodes and the root

**Kind node** `[kind, depth, hashes]`: `kind` one of the eight kind names (§8.5), `depth` 0 or 1, `hashes` a non-empty array of hash16. Depth 0 lists the kind's body chunks in order; depth 1 lists depth-0 nodes of the same kind, in order.

**Root** `[v, header, kinds, noteCount]`: `v` the records version (1); `header` the header chunk's hash16; `kinds` an array of `[kindName, nodeHash]` naming the top node of each kind that has records, in the v1 kind order `slides, bpms, timeScales, cameraEvents, stageMaskEvents, stagePivotEvents, stageStyleEvents, stageTransformEvents`, each at most once; `noteCount` a count, the number of note records in `slides`. A kind with no records is left out. The root's hash16 is the **snapshot id**.

### 8.4 The header record

`[initialLife, isDynamicStages, bgmOffset, groups, stages, groupFolders, stageFolders, levelInfo, bgm?]`

| Record | Positions |
| --- | --- |
| header | `initialLife` number, `isDynamicStages` bool, `bgmOffset` number (seconds), `groups` array of group, `stages` array of stage, `groupFolders` array of folder, `stageFolders` array of folder, `levelInfo` levelInfo, `bgm` bgm (optional) |
| group | `id` id, `name` string, `forceNoteSpeed` number (0 = none), `folderId` id (optional; must be a group folder) |
| stage | `id` id, `name` string, `isFromStart` bool, `isUntilEnd` bool, `generateSimLines` enum, `folderId` id (optional; must be a stage folder) |
| folder | `id` id, `name` string, `index` uint, `folderId` id (optional; must be a folder of the same list; no loops) |
| levelInfo | `title`, `artists`, `author`, `description` strings, `tags` array of tag, `cover` mediaRef or `[]`, `preview` mediaRef or `[]`, `rating` number (optional) |
| tag | `title` string |
| mediaRef | `hash` hash16, `filename` string, `size` uint, `type` string |
| bgm | `hash` hash16, `filename` string, `size` uint, `type` string, `durationMs` uint (optional) |

Header checks: group ids unique, stage ids unique, folder ids unique across both folder lists; every `folderId` names an existing folder of its list; folder parent links never loop. Lists are in tree order (§6.3). The chain name, the binding, the export name, the view (which groups or stages are shown, hidden or dimmed, zoom, selection) and the default guide colour setting are not in a snapshot.

### 8.5 Body records

| Kind | Record | Positions |
| --- | --- | --- |
| `slides` | slide | an array of at least one note record |
| | note | `groupId` id→groups, `stageId` id→stages, `beat` number, `elevation` number, `noteStyle` enum, `connectorStyle` enum(noteStyle), `noteType` enum, `isAttached` bool, `left` number, `size` number, `isCritical` bool, `flickDirection` enum, `isFake` bool, `sfx` enum, `isConnectorSeparator` bool, `connectorType` enum, `connectorEase` enum(ease), `connectorIsFake` bool, `connectorActiveIsCritical` bool, `connectorGuideAlpha` number, `connectorLayer` enum, `connectorIsPassThrough` bool, `connectorPresentation` enum |
| `bpms` | bpm | `beat`, `bpm`, `meter` numbers |
| `timeScales` | timeScale | `groupId` id→groups, `beat`, `editorLane`, `timeScale`, `skip` numbers, `timeScaleEase` enum, `timeScaleTransition` enum, `hideNotes` bool |
| `cameraEvents` | cameraEvent | `beat`, `cameraLeft`, `cameraSize`, `cameraZoom`, `cameraZoomTargetLane`, `cameraZoomTargetY` numbers, `cameraZoomVerticalAlign` enum, `cameraRotation`, `cameraStageTilt` numbers, `eventEase` enum(ease) |
| `stageMaskEvents` | stageMaskEvent | `stageId` id→stages, `beat`, `maskLeft`, `maskSize` numbers, `isMaskNotes` bool, `eventEase` enum |
| `stagePivotEvents` | stagePivotEvent | `stageId`, `beat`, `pivotLane`, `divisionSize` numbers, `divisionParity` enum, `yOffset`, `yOffsetBeat` numbers, `eventEase` enum |
| `stageStyleEvents` | stageStyleEvent | `stageId`, `beat`, `editorLane` number, `judgmentLineColor`, `judgmentLineStyle`, `leftBorderStyle`, `rightBorderStyle` enums, `isFullWidth` bool, `noteAlpha`, `laneAlpha`, `judgmentLineAlpha`, `divisionLineAlpha` numbers, `eventEase` enum |
| `stageTransformEvents` | stageTransformEvent | `stageId`, `beat`, `rotation`, `xTranslation`, `yTranslation`, `elevation` numbers, `anchor` enum, `eventEase` enum |

Enums are the string sets of §6 (the machine-readable list, with every record form, is `tools/fields-v1.json`, generated from `src/local/records/schema.ts`). Each record is checked for arity (all required positions, nothing past the last), types, finiteness and enum membership, and every `id→` field must name an id the header defines. **Ranges are never checked.**

### 8.6 Decoding a snapshot

1. Check the root (§8.3). `v` above 1: newer (§14). `v` not 1 otherwise, a bad form, a kind out of order or repeated: damaged. A kind name not in the eight: newer.
2. Read and check the header chunk (§8.4).
3. For each `[kind, node]`: read the node (depth 0 or 1; a depth-1 node's children must be depth-0 nodes of the same kind), concatenate its chunks in node order, check every record (§8.5) against the header's ids.
4. Check `noteCount` against the number of note records.

The state is the header plus each kind's records **in the order the chunks hold them**; a reader never assumes or re-applies the writer's split or sort. Records map to model fields by name (§6); a group's `forceNoteSpeed` 0 is none; an empty level info is no level info.

**Writer order** (a reader may rely on it only for display, never for meaning): slides sorted by first note beat, then by canonical text (UTF-16 code unit order); every other kind sorted by beat, then track (the stage id, the group id for time scales, 0 for BPMs and camera events), then chain order; a slide's notes are never re-sorted. **Writer split**: a record goes in the chunk of its 16-beat window (`floor(key / 16)`, the key being a slide's first beat or the record's beat); a window of more than 24 records splits into 4-beat parts, a 4-beat part of more than 24 into 1-beat parts, a 1-beat part of more than 24 into runs of 24; a kind other than `slides` with at most 64 records in all is one chunk. A kind of at most 16 chunks has one depth-0 node, else a depth-1 node over depth-0 nodes of 16 consecutive chunks each.

## 9. History parts: manifest, segments, `chunks.bin`

### 9.1 Forms

```
history/manifest.json   { version, entries, roots, nodes, chunks, undoStack, x? }
history/segments/N.json { entries, roots, nodes, chunks, x? }
```

| Member | Form |
| --- | --- |
| `version` | Manifest only. The safe integer 1. Above 1: `newer-history` (checked first; nothing else is checked). Below 1 or not a safe integer: `history-unreadable`. |
| `entries` | Array of entry forms (§10.1), oldest first. |
| `roots` | Object: hash16 (key) → root record. |
| `nodes` | Object: hash16 → kind node. |
| `chunks` | Array of `[hash16, offset, length]` (counts): where each chunk's stored form lies in `chunks.bin`. |
| `undoStack` | Manifest only. `{base, slots, index, x?}`: `base` and `index` counts, `slots` an array of `{snapshot, step, x?}` (`snapshot` a hash16, `step` a step, §11.4). |
| `x` | An ignorable extension (§11.6). |

Every other key is `unknown-key` and the history is not read. A key of `roots` or `nodes` that is not a hash16 is damage.

### 9.2 Putting the parts together

The history is the concatenation of the parts: `entries` are the segments' in `history.segments` order, then the manifest's; `roots`, `nodes` and the chunk index are the union. Then:

- A root or node key in two parts must have equal values (compared as JSON text). A hash may appear in the chunk index once.
- **Tiling.** Taking the parts in order and each part's index in order, the first offset is 0 and each offset is the previous offset plus the previous length; the last end is the size of `chunks.bin`.
- `history.entries` must equal the entry count.
- Every node must hash to its key, pass §8.3 and have each child present (a depth-0 node's chunks in the index, a depth-1 node's children as depth-0 nodes of its kind); an unknown kind is newer. Every root must hash to its key and pass §8.6 step 1, its header chunk in the index and each top node present and of its kind. Nodes and roots nothing references are still checked.
- Every entry without `kept: false` must have its root in `roots`, a `recovered` one also each slot of its `stack.push` (§10.2); so must every `undoStack` slot. A `kept: false` entry may have them or not, its `stack.push` slots included.
- `base <= index < base + slots.length`.

Each failure is `history-unreadable` (newer content: `newer-history`). Reports stop after 20 items with "and N more".

### 9.3 `chunks.bin`

The stored forms of all chunks, concatenated with no framing, located only through the chunk index. Each chunk is verified by its hash when read (§8.2); the entry's whole CRC is never checked when it is STORE (it is read in slices). A DEFLATE `chunks.bin` (an OS re-zip) is inflated whole on first use, within its caps, and its CRC and size checked then; a failure is `history-unreadable`. Caps are checked before any of it is read: at most 2 GiB declared, STORE with `compressedSize == size`, DEFLATE within `2 * size + 1024`.

**What is checked at open, what later.** At open the reader checks every part, every root and node, every root's **header chunk** (strict inflate, hash, §8.4), and every chunk of the **History head's** snapshot, decoded (§8.6). Any failure: the history is unread. Other body chunks are read only when needed (the editor's background import, a peek, a Restore). A chunk that fails then makes the snapshots that need it **damaged**, never the file; the editor marks the rows needing them `kept: false` and, when the file is the chain's own and unchanged, unbinds the chain from it.

### 9.4 The undo stack

`undoStack` is the head session's undo stack at the write, cut to the slots the file holds: `slots[k]` is absolute slot `base + k`, and `index` is absolute. The **History head** is `slots[index - base].snapshot`. Slots after the index are the redo tail. `step` is the step that slot's state was pushed with (`init` for slot 0 of a session that started the chain). The undo stack is not the timeline. It is what Undo and Redo move through after the file opens.

## 10. Entries and the timeline

### 10.1 The entry form

Keys: `kind time operation recoveryContext step snapshot noteCount dirty kept revisionId device appVersion stack x`. Any other key is `unknown-key` (the history is not read), even on an entry of an unknown kind.

| Key | Form and rule |
| --- | --- |
| `kind` | `init continue edit undo redo restore save export recovered`. Another string: `newer-history`, and the entry's other fields are not checked. Not a string: damage. |
| `time` | Count (milliseconds since the epoch). |
| `step` | A step (§11.4). Exactly on `edit restore undo redo`. On `edit` and `restore`, `step.kind` must equal the entry's kind; on `undo` and `redo`, `step.kind` must not be `init`. |
| `operation` | An operation (§11.1), any bounded JSON (§11.3). Exactly on `init continue save export recovered`. |
| `recoveryContext` | A recovery context (§11.5). Exactly on `recovered`. |
| `snapshot` | Hash16, always, even when the file lacks the root. |
| `noteCount` | Optional count. **Absent is an unknown count, never 0.** |
| `dirty` | Only `true`, present only when set: the chart changed since the last file event (save or export). |
| `kept` | Only `false`, present only when set: the file does not hold this row's state whole. |
| `revisionId`, `device {id, label}` | `save` only, required there (strings). `device` takes no other key. |
| `appVersion` | `save` only, optional (string): the app version that made that Save. |
| `stack` | `recovered` only, required: `{keep, push, index, x?}`, `keep` and `index` counts, `push` an array of slots `{snapshot, step, x?}`. |
| `x` | An ignorable extension (§11.6). |

`revisionId`, `device` or `appVersion` on another kind, or `stack` off `recovered`, is `unknown-key`. Any other failure is `history-unreadable`. Not in files: the session ids, the row numbers within a session, day stamps, renames.

### 10.2 Entry kinds

Entries are numbered by position (1-based, across all parts). Sessions are separated by `continue` entries: a session runs from an `init` or a `continue` to the entry before the next `continue`.

| Kind | Description key | Snapshot | Undo-stack effect (replay) |
| --- | --- | --- | --- |
| `init` | `operation` (`nse.origin`) | The first state | Starts the stack with one slot (step `{kind: init, operation}`). Only as a chain's first entry. |
| `continue` | `operation` (`nse.continue`, or `nse.origin` for a `.nxsp` open) | The state the session starts from | Keeps the stack; with none, starts one slot whose step is `init`. |
| `edit` | `step` (kind `edit`) | The state after the step | Drops slots after the index, pushes, index + 1. |
| `restore` | `step` (kind `restore`, `nse.restore`) | The restored entry's state with the current BGM, and the entry's BGM offset only when its BGM is the current one | As `edit`. |
| `undo` | `step`: the step crossed (the slot left) | The state landed on | Index − 1; the snapshot is the slot landed on. |
| `redo` | `step`: the step crossed (the slot entered) | The state landed on | Index + 1. |
| `save` | `operation` (`nse.file.save`), `revisionId`, `device`, `appVersion` | The state saved | None. |
| `export` | `operation` (`nse.file.export`) | The state exported | None. |
| `recovered` | `operation` (`nse.recovery`), `recoveryContext`, `stack` | The recovered state | Keeps slots `0 … keep − 1`, appends `stack.push` (absolute numbering), sets the index to `stack.index`. |

A file's chronology need not replay from its first entry to its `undoStack`. Sessions may come from forks, and the writer cuts the stored stack. A viewer shows entries as they are and takes the undo stack from `undoStack`.

**Saves.** In a file written by the editor, the last entry is the `save` entry of this file's own revision (`revisionId == revision.id`). Earlier `save` entries are earlier Saves (of earlier revisions, from other devices or files). An `export` entry records an Export (level data written elsewhere); no file event changes the chart.

### 10.3 The chart at each step

The chart at entry *k* is entry *k*'s `snapshot`, decoded (§8.6):

- root present and every chunk good: the state;
- root absent (only allowed with `kept: false`): **not held** ("not kept" or "not included" in the editor);
- root present but a chunk failing (§9.3): **damaged**;
- a root of a newer `v` cannot be in a readable file (it makes the history unread).

A `kept: false` row whose root is present may still be decoded; the editor labels such a row "not kept". Equal snapshot ids mean equal states; unequal ids do not prove a difference. A state's media: `project.json` holds at most the head's BGM, cover and preview; a step whose BGM, cover or preview is another file's shows it as not loaded.

### 10.4 Time, `dirty`, `noteCount`

- Times come from the writing devices. In a session made on one device, times never go back; a file's chronology as a whole may (sessions from several devices). The editor shows local dates and times from `time`.
- `dirty` is informational (the Timeline does not show it).
- `noteCount` is the root's note count when known. A writer writes the root's count, and a reader that holds the root takes the root's (readers do not check that the two agree).

### 10.5 What the editor shows

The editor's Timeline lists entries newest first, one row per entry, titled by the operation (§11.2; for `undo` and `redo`, the crossed step's title prefixed "Undo ·" or "Redo ·"), with a divider at each `continue` ("Continued from {time}") and a mark on each save and export. Adjacent rows whose operations share a group key (`operationGroup`, `src/history/operations/grouping.ts`) may collapse into one row, a display choice a viewer may skip. Rows `kept: false` read "not kept" or damaged.

### 10.6 The head, and what an open adds

The file's chart now is `level.json` parsed (§7.5), with level info from `metadata` (§5.4) and the BGM from `bgm` (§5.5), or the History head's BGM reference when `bgm` is absent. When the file has history, the level report is empty and the file **matches** its History head, the editor shows the History head itself (keeping its ids); otherwise it shows the level-data chart (fresh ids).

**Matches** means: the level info read from `metadata` (§5.4) equals the head's level info (compared as canonical level-info records); `bgm`, when present, names the head's BGM hash; and `level.json` matches the head as level data: both the file's entities and the head re-serialised (§16.4) are parsed (§7.5), groups, stages and folders renumbered 1…n in list order (folders in one sequence, group folders first, references following), converted to records in the writer's order (§8.6) with level info and BGM left out (header positions 0–6 only), and compared as canonical text.

When the file does not match, the editor's import adds, after the file's entries, an `edit` entry of `nse.externalChange` with the level-data state, then a `continue` entry of `nse.origin` (`{origin: import, source: <file name>}`); when it matches, only the `continue`. A file without history opens as one `init` slot of that `nse.origin`. These rows are the open's, not the file's.

## 11. Operations: the envelope and shared values

### 11.1 The envelope

`{"id": string, "version": positive integer, "data": object, "fallback": {"text": string, "locale": string}}`, written in the key order `id, data, version, fallback` with `fallback` as `{locale, text}`. Order is not significant.

An operation is **known** when it has exactly these four keys, `id` is a native id (§12), `version` is `1`, `fallback.text` and `fallback.locale` are well-formed strings, its compact JSON is at most 64 KiB (UTF-8), and `data` passes the id's codec (§12). Codecs are strict, and a member they do not list fails. Anything else (an unknown id, another version, data that fails, missing or extra keys, any other JSON value, `null` included) is **unsupported**: kept whole, carried through Saves, never an error, as long as it is within §11.3. Native ids start with `nse.`; tests use `test.future.*` for ids from a newer editor.

### 11.2 Titles

A known operation is titled in the viewer's language from its `data` (§12 gives each id's title inputs and an English example). An unsupported one is titled `fallback.text` when it is a non-empty string, else by its coarse kind: "Initial state" (`init` step), "Edit", "Restore", "Continued", "Save", "Export Level Data…", "Recovered changes". `fallback` is the writer's own title, in `fallback.locale`, cut to 1,024 code points (the last one `…` when cut). Step Details says "This step was recorded by a newer version of the editor." for an unknown `nse.` id or a native id with `version > 1`, and "This editor cannot read the details of this step." otherwise.

### 11.3 Resource bounds

Every operation must be plain JSON: finite numbers, well-formed strings (keys included), no more than 256 KiB of compact UTF-8, nesting depth at most 16 (the operation itself is level 0; a value at level 17 fails). A step (§11.4) is at most 2 × 256 KiB + 128 KiB + 4 KiB and depth 20; a recovery context at most 256 KiB + 128 KiB + 2 KiB and depth 19. An `x` is measured apart (§11.6). Beyond a bound the description is **resource-invalid**: `history-unreadable`, not merely unsupported.

### 11.4 Steps

A step is `{kind, operation, recoveryContext?, x?}`: `kind` `init`, `edit` or `restore` (the kind that pushed it), `operation` an operation, `recoveryContext` written only on a recovery step, and accepted by a reader on any step. Any other key is `unknown-key`.

### 11.5 Recovery contexts

`{head, headIndex, dropped, omitted, x?}`: `head` and each `dropped` item are `{kind, operation, x?}` (`kind` `init`, `edit` or `restore`); `headIndex` a count `<= dropped.length`; `dropped` at most 64 items whose compact JSON, without their `x`, is at most 128 KiB; `omitted` a count of items left out (`omitted + dropped.length` a safe integer). It lists the steps a crash recovery could not keep, oldest first, with the head (the last step before the crash) at `headIndex`; the editor shows them as "Earlier Actions" with "Recovered up to here" at the head.

### 11.6 The `x` extension

Allowed on: an entry, a step, a recovery context, its head and each dropped item, an `undoStack` or `stack` slot, a `stack`, `undoStack`, the manifest and a segment. It must be a JSON object, at most 256 KiB of compact UTF-8 and at most 32 levels deep counted from the `x` itself (the `x` is level 0); otherwise `history-unreadable`. It is never read, never counted in its host's bounds, carried by value where the host is copied whole, and may be dropped where the host is rebuilt. Today's writers write none.

### 11.7 Shared value types

| Name | Form |
| --- | --- |
| NameText | `{text, truncated?: true}`: `text` a well-formed string of at most 256 code points; `truncated` present (and `true`) only when the source name was longer and was cut. Unset names are `{text: ""}`. |
| native kind | `note bpm timeScale cameraEvent stageMaskEvent stagePivotEvent stageStyleEvent stageTransformEvent` |
| subject | a native kind or `objects` (several kinds) |
| counts (NC) | an object from native kinds to positive safe integers, sum safe; may be `{}` |
| counts+ (NC+) | the same, never empty |
| owner kind | `group stage groupFolder stageFolder` |
| owner counts+ (OC+) | an object from owner kinds to positive safe integers, never empty |
| owner reference | `{kind: owner kind, id: count, name: NameText}`: the owner and its name when the step was made |
| folder reference | an owner reference of kind `groupFolder` or `stageFolder` |
| time | a count `<= 8.64e15` (ms) |
| `subjectOfCounts(c)` | the one kind with a count, else `objects` |
| *agrees*(subject, changed) | `changed` is `{}` or `subject == subjectOfCounts(changed)` |

**Property fields.** An assignment names one of 61 field ids; each id is a model field (§6) with its value codec and the kinds it applies to:

| Field ids | Value | Applies to |
| --- | --- | --- |
| `beat` | finite | every native kind |
| `editorLane` | finite | timeScale, stageStyleEvent |
| `left`, `size` | finite | note |
| `cameraLeft`, `cameraSize`, `cameraZoom`, `cameraZoomTargetLane`, `cameraZoomTargetY`, `cameraRotation`, `cameraStageTilt` | finite | cameraEvent |
| `cameraZoomVerticalAlign` | `default center` | cameraEvent |
| `maskLeft`, `maskSize` | finite | stageMaskEvent |
| `isMaskNotes` | boolean | stageMaskEvent |
| `pivotLane`, `divisionSize`, `yOffset`, `yOffsetBeat` | finite | stagePivotEvent |
| `divisionParity` | `even odd` | stagePivotEvent |
| `xTranslation`, `yTranslation`, `rotation` | finite | stageTransformEvent |
| `anchor` | `default center` | stageTransformEvent |
| `bpm`, `meter` | finite | bpm |
| `timeScale`, `skip` | finite | timeScale |
| `timeScaleEase` | a time-scale ease | timeScale |
| `timeScaleTransition` | `timeScale scroll` | timeScale |
| `hideNotes` | boolean | timeScale |
| `judgmentLineColor` | `neutral red green blue yellow purple cyan black` | stageStyleEvent |
| `judgmentLineStyle` | `default singleLine` | stageStyleEvent |
| `leftBorderStyle`, `rightBorderStyle` | `default light medium disabled` | stageStyleEvent |
| `isFullWidth` | boolean | stageStyleEvent |
| `noteAlpha`, `laneAlpha`, `judgmentLineAlpha`, `divisionLineAlpha` | finite | stageStyleEvent |
| `eventEase` | an ease | the five event kinds |
| `noteType`, `flickDirection`, `sfx`, `connectorType`, `connectorLayer`, `connectorPresentation` | their enums (§6.4) | note |
| `noteStyle`, `connectorStyle` | `default` and the eight colours | note |
| `connectorEase` | an ease | note |
| `isCritical`, `isAttached`, `isFake`, `isConnectorSeparator`, `connectorIsFake`, `connectorActiveIsCritical`, `connectorIsPassThrough` | boolean | note |
| `connectorGuideAlpha` | finite | note |
| `groupId` | `{kind: group, id, name}` | note, timeScale |
| `stageId` | `{kind: stage, id, name}` | note, the four stage events |
| `elevation` | finite | note, stageTransformEvent |

An **assignment** is `{field, before, after}`; a side is `{mode: "varying"}` (the objects held different values) or `{mode: "uniform", value}` (all held `value`, and the value must pass the field's codec).

**Property data** (brush and `nse.property.set`): `{subject, changed: NC+, assignments, displaced?: NC+, retainedInitialBpm?: true}` where `assignments` holds 1 to 61 assignments in strictly ascending field-id order (string comparison); `subject == subjectOfCounts(changed)`; `retainedInitialBpm` only with subject `bpm` or `objects`; `displaced` or `retainedInitialBpm` only with a `beat` assignment; every assignment applies to some changed kind and every changed kind has an assignment that applies to it.

**Collateral.** `displaced` counts objects the edit replaced that were not its operands (a BPM or time scale moved onto an occupied beat removes the one there). `retainedInitialBpm: true` says the beat-0 BPM change stayed in place or was added back. `false` is never written and fails.

## 12. Every operation

Each id below has `version` 1. "Kind" is the entry or step kind it is written as. Titles are given in English with the data's inputs in braces; the plural forms follow the count.

### 12.1 Notes

| Id | Kind | `data` | Meaning | English title |
| --- | --- | --- | --- | --- |
| `nse.note.add` | edit | `{created: count}` | Notes added by the Note tool (a new one-note slide), the Slide tool (a note into a slide) or an Elevation Editor create. | "Added {created} note(s)"; 0: "Added notes" |
| `nse.note.generate` | edit | `{created: count}` | Generate Slide Notes: attached notes added on grid lines that held none. | "Generated {created} note(s)" |
| `nse.note.elevation` | edit | `{targets: count}` | An Elevation Editor drag that changed only elevation. | "Changed elevation of {targets} note(s)" |
| `nse.note.combine` | edit | `{targets: count}` | Combine into Slide: every note of the slides involved, re-made as one slide by beat. | "Combined {targets} notes into one slide" |
| `nse.note.split` | edit | `{targets: count}` | Split Slide: the cut points (selected notes that were not their slide's last). | "Split {targets} slide connection(s)" |
| `nse.note.vertical` | edit | `{targets: count}` | Make Vertical: notes moved to the earliest selected beat with elevation = beat − that beat, and detached. | "Made {targets} note(s) vertical" |

### 12.2 Adding, editing, moving

| Id | `data` | Constraints | Meaning | Title |
| --- | --- | --- | --- | --- |
| `nse.object.add` | `{subject, created: count}` | subject a native kind other than `note` | BPM, Time Scale and the five event tools: objects placed. | "Added {created} BPM change(s)", "… time scale(s)", "… {kind} event(s)" |
| `nse.object.edit` | `{subject, changed: NC, displaced?: NC+, retainedInitialBpm?: true}` | *agrees*; retained only with `bpm` or `objects` | A tool edit in place (a tap on an occupied BPM edits it); an Elevation Editor width change. `changed` counts operands whose principal fields changed (`{}` allowed: "Edited notes"). | "Edited {n} note(s)"; `objects`: "Edited objects" |
| `nse.object.move` | as `edit`, plus `resized?: true` | `resized` only with subject `note`, `cameraEvent` or `stageMaskEvent` and without collateral | A tool or Select drag; an Elevation Editor lane change. `resized`: the drag took an edge and changed only widths or ranges (no beat). A beat-0 BPM moved with its tool stays, with a copy at the new beat (`retainedInitialBpm`). | "Moved {n} note(s)"; resized: "Resized {n} note(s)" |
| `nse.object.replace` | `{subject: bpm \| timeScale, changed: NC, displaced: NC+, retainedInitialBpm?: true}` | *agrees*; every `displaced` kind is the subject; retained only for `bpm` | A BPM change or time scale moved onto an occupied beat: it replaced the one there. | "Replaced {n} BPM change(s)" |

### 12.3 Paste, brush, delete, cut

| Id | `data` | Meaning | Title |
| --- | --- | --- | --- |
| `nse.object.paste` | `{placed: NC+, variant: basic \| composed, flipped: boolean, at: pointer \| position, displaced?: NC+}` | The Paste tool (`at: pointer`) or Paste at a position (context menu, Elevation Editor: `position`). `placed` counts pasted objects kept; `composed` is the composed layout with dynamic stages; `flipped` is Shift; a pasted BPM or time scale replaces the one at its beat (`displaced`). | "Pasted {sum} object(s)" |
| `nse.object.brush` | property data | The Brush tool: the brush's fields written on the objects (never BPM changes). | "Brushed {n} note(s)" (one kind) or "Brushed {n} object(s)" |
| `nse.object.delete` | `{removed: NC}` | Eraser, Delete, Elevation Editor delete. Notes, BPM changes above beat 0, time scales and events are removable; connectors are not objects. | "Deleted {n} note(s)" or "Deleted {n} object(s)" |
| `nse.object.cut` | `{removed: NC}` | Cut. The clipboard is outside History. | "Cut {n} note(s)" or "Cut {n} object(s)" |

### 12.4 Flip and scale

| Id | `data` | Constraints | Meaning | Title |
| --- | --- | --- | --- | --- |
| `nse.object.flip` | `{axis: horizontal \| vertical, subject, changed: NC, displaced?: NC+, retainedInitialBpm?: true}` | *agrees*; collateral only for `vertical`; retained only with `bpm` or `objects` | Horizontal: lanes mirrored (a note's `left`, flick directions, event lanes, rotations, border styles). Vertical: beats mirrored between the selection's ends, connector properties and eases reversed. | "Flipped {sum of changed} object(s)", "Flipped {sum} object(s) vertically" |
| `nse.object.scale` | `{axis: beats \| width \| elevation, subject, changed: NC, transform, displaced?, retainedInitialBpm?}` | `transform` `{mode: uniform, factor: finite, pivot: finite}` or `{mode: composed}`; collateral only for `beats` | Scale Beat, Width or Elevation. `uniform` when the result is one scale by `factor` about `pivot` (beats, lanes or elevation); `composed` after several adjustments. | "Scaled beats of {sum} object(s)", "Scaled width of {sum} object(s)", "Scaled elevations of {sum} object(s)" |

### 12.5 Property edits

| Id | `data` | Meaning | Title |
| --- | --- | --- | --- |
| `nse.property.set` | property data (§11.7) | The Properties panel and dialogs, note and slide preset quick edits, Move to Group and Move to Stage. One assignment per field whose value changed on some target; `before` and `after` are uniform when every object held one value. Owner values store the id and the name then. A sidebar edit of a lone BPM's or time scale's beat is a `move` or `replace` instead. | One uniform assignment: "Set Lane to 2 on 1 note", "Set Group to "Fast" on 2 notes", "Set Editor Lane to 1 on 2 objects"; varying: "Changed Lane on 2 notes"; several: "Edited 1 time scale" |

### 12.6 Header, BGM, level info, dynamic stages

| Id | `data` | Meaning | Title |
| --- | --- | --- | --- |
| `nse.header.set` | `{field: initialLife \| bgmOffset, before: finite, after: finite}` | Level Info (Initial Life alone), the Offset tool, the BGM dialog when only the offset changed. `bgmOffset` in seconds. | "Set Initial Life to {after}", "Set BGM Offset to {after × 1000} ms" |
| `nse.bgm.change` | `{file: {before, after: NameText \| null}, offset?: {before, after: finite}}` | The BGM dialog or opening an audio file: a new BGM (file name without extension; `null` for none); `offset` only when it changed. Re-picking the same file is still a change. | "Changed BGM" (with `offset`), else "Changed BGM file" |
| `nse.levelInfo.set` | `{changes: [...]}` | One Apply of the Level Info dialog. 1 to 9 changes in the order `title artists author rating tags description cover preview initialLife`, each field once, each a real change, and not `initialLife` alone. Shapes: `{field: title \| artists \| author \| description, before, after: NameText}`; `{field: rating, before, after: finite \| null}`; `{field: tags, added: count, removed: count, reordered?: true}` (at least one non-zero or `reordered`); `{field: cover \| preview, before, after: NameText \| null}`; `{field: initialLife, before, after: finite}`. A name pair is no change only when the texts are equal and neither is cut. | "Changed level info" |
| `nse.dynamicStages.enable` | `{created: NC}` | Enabling dynamic stages: a mask, a pivot and a style event at beat 0 on the default stage (`{stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1}`). | "Enabled dynamic stages" |

### 12.7 Groups, stages and folders

Indexes are 0-based: for a group or stage, positions among the domain's entries in tree order; for a folder, positions among the top-level items. "Domain" is `group` or `stage`; a folder reference is in the domain of its kind.

| Id | `data` | Constraints | Meaning | Title |
| --- | --- | --- | --- | --- |
| `nse.owner.create` | `{target: owner ref, destination: folder ref \| null, gathered: count}` | `gathered` 0 unless the target is a folder; a destination only for a group or stage, of its domain | Add Group, Add Stage (in a folder: `destination`), New Folder (with held entries: `gathered`). | "Added "#2" group", "Added group folder "Empty"", "Created folder "Folder" with 2 groups" |
| `nse.owner.rename` | `{target, before: NameText, after: NameText}` | | Rename; the Name field of the Properties dialogs. `target.name` is the old name. | "Renamed "#2" group to "Fast"", "Renamed group folder "A" to "B"" |
| `nse.owner.set` | `{target, changes}` | 1 to 3 changes in strictly ascending field-name order; a group only `forceNoteSpeed` `{before, after: finite \| null}`; a stage `isFromStart`, `isUntilEnd` (booleans) or `generateSimLines` (`global \| isolated`) | Group Properties (Force Note Speed; `null` is none); Stage Properties. | "Set Force Note Speed of "Fast" group to 1.5" ("Cleared …" for `null`), "Set Generate Sim Lines of "#2" stage to Isolated", "Set Until End of "#2" stage to Enabled" |
| `nse.owner.move` | `{target, destination: folder ref \| null, category: reorder \| intoFolder \| outOfFolder, fromIndex?: count, toIndex?: count}` | destination of the target's domain; a folder target only `reorder` with `null`; `intoFolder` needs a destination, `outOfFolder` none | Move Up and Down, drag, "Move to Folder…" or "No Folder" on one entry; moving a folder. The writer always writes both indexes. | "Moved "Default" group" (reorder), "Moved group "#4" into folder "F"", "Moved group "#4" out of its folder", "Moved group folder "F"" |
| `nse.owner.moveMany` | `{domain: group \| stage, targets: count, destination: folder ref \| null}` | destination of the domain | Bulk "Move to Folder…" or "No Folder"; `targets` counts entries whose folder changed. | "Moved 2 groups into folder "F"", "Moved 2 groups out of folders" |
| `nse.owner.duplicate` | `{domain, created: OC+, source?: owner ref, objects?: NC+}` | `created` only the domain's kinds; `objects` only what the domain owns (group: `note`, `timeScale`; stage: `note` and the four stage events); `source` in the domain | Duplicate an entry or folder (with members), or Duplicate Selected. `source` only for exactly one entry or folder; `objects` the copied chart objects. | "Duplicated "Fast" group" (with `source`), "Duplicated stage folder "Stages"", "Duplicated 3 groups" |
| `nse.owner.delete` | `{domain, removed: OC+, target?: owner ref, objects?: NC+, replacement?: owner ref}` | as duplicate; `replacement` of kind `domain` | Delete a group, stage or folder (with its members and their objects), or Delete Selected. `replacement`: the default entry made when the last one went. A group's delete removes its notes and time scales; a stage's its notes and stage events. | "Deleted "Fast (2)" group" (with `target`), "Deleted 1 stage" |
| `nse.owner.ungroup` | `{target: folder ref, released: count}` | | Ungroup a folder: it is removed, its `released` members stay, loose, where it was. | "Ungrouped "{name}" folder" |

### 12.8 Session and file events

| Id | Kind | `data` | Meaning | Title |
| --- | --- | --- | --- | --- |
| `nse.origin` | `init` entry or step; the `continue` entry of a `.nxsp` open | `{origin: new \| import \| autoSave \| recovery, source?: NameText}`, `source` only with `import` | How the chain began: a new chart, an import (an opened file's name in `source`), the migration of an old auto save, a recovery from Local Data. A `.nxsp` open writes it as its `continue`. | "Started a new level", "Opened {source}" / "Imported a level", "Opened the old auto save", "Recovered changes" |
| `nse.continue` | `continue` | `{fromTime: time}` | A new visit, Reopen, Restore Session or a fork; `fromTime` the parent session's last time. | "Continued from {fromTime}" |
| `nse.file.save` | `save` | `{file: NameText, delivery: file \| download}` | A Save of the chain to a file (or a download). | "Saved {file}", "Downloaded {file}" |
| `nse.file.export` | `export` | `{file: NameText, delivery: file \| download}` | Export Level Data. | "Exported {file}" |
| `nse.restore` | `restore` step | `{targetTime: time}` | Restore from the Timeline: the restored entry's time (not its position). | "Restored to {targetTime}" |
| `nse.recovery` | an `edit` step (in a `recovered` entry's push, or a plain `edit` entry) and the `recovered` entry | `{droppedSteps: count}` | A crash recovery from the journal: `droppedSteps` undo steps could not be kept; the step's `recoveryContext` lists them. | "Recovered changes" |
| `nse.externalChange` | edit | `{}` | A `.nxsp` open whose `level.json` differed from its History head (§10.6). | "Changed outside the editor" |

## 13. What each tool and action records

| Tool or action | Entry kind | Operation |
| --- | --- | --- |
| New | `init` (a new chain) | `nse.origin` new |
| Import a chart file (USC, SUS, level data), open audio into a new level | `init` | `nse.origin` import, with `source` |
| Open a `.nxsp` | `continue` (after the file's rows; §10.6) | `nse.origin` import; plus `nse.externalChange` when changed |
| New visit, Reopen, Restore Session, a fork | `continue` | `nse.continue` |
| Note tool, Slide tool, Elevation Editor create | edit | `nse.note.add` |
| Generate Slide Notes tool | edit | `nse.note.generate` |
| BPM, Time Scale, Camera, Stage Mask, Stage Pivot, Stage Style, Stage Transform tools (placing) | edit | `nse.object.add` |
| The same tools editing an existing object in place | edit | `nse.object.edit` |
| The same tools or Select dragging | edit | `nse.object.move` (`resized` for an edge drag), `nse.object.replace` (onto an occupied BPM or time scale beat) |
| Elevation Editor drag | edit | `nse.object.edit` (width), else `nse.object.move` (lane), else `nse.note.elevation` |
| Paste tool, paste from the context menu or Elevation Editor | edit | `nse.object.paste` (the Paste command only switches tool) |
| Brush tool | edit | `nse.object.brush` |
| Eraser, Delete | edit | `nse.object.delete` |
| Cut | edit | `nse.object.cut` (Copy records nothing) |
| Flip, Flip Vertical | edit | `nse.object.flip` |
| Scale Beats…, Scale Width…, Scale Elevations… | edit | `nse.object.scale` |
| Combine into Slide, Split Slide, Make Vertical | edit | `nse.note.combine`, `nse.note.split`, `nse.note.vertical` |
| Properties panel, property dialogs, note and slide presets, Move to Group, Move to Stage | edit | `nse.property.set` |
| Level Info (Initial Life alone), Offset tool | edit | `nse.header.set` |
| BGM dialog, opening an audio file | edit | `nse.bgm.change` (`nse.header.set` when only the offset changed) |
| Level Info dialog (one Apply) | edit | `nse.levelInfo.set` |
| Enabling dynamic stages (event and stage commands, the Stages panel, pasting stage events) | edit | `nse.dynamicStages.enable` |
| Add Group, Add Stage, New Folder | edit | `nse.owner.create` |
| Rename, Name field | edit | `nse.owner.rename` |
| Group and Stage Properties | edit | `nse.owner.set` |
| Move Up and Down, drag, Move to Folder, No Folder (one entry, or a folder) | edit | `nse.owner.move` |
| Bulk Move to Folder or No Folder | edit | `nse.owner.moveMany` |
| Duplicate, Duplicate Selected | edit | `nse.owner.duplicate` |
| Delete (group, stage, folder), Delete Selected | edit | `nse.owner.delete` |
| Ungroup | edit | `nse.owner.ungroup` |
| Undo, Redo | `undo`, `redo` | the crossed step's operation |
| Restore (Timeline) | `restore` | `nse.restore` |
| Save, Save As…, Recent Sessions' Save…, Download | `save` | `nse.file.save` |
| Export Level Data | `export` | `nse.file.export` |
| Crash recovery (journal) | `recovered`, or an `edit` | `nse.recovery` |
| Selection, view, zoom, scroll, visibility (shown, dimmed or hidden groups and stages), playback, Copy, settings | nothing | — |

**The no-op rule.** An action that leaves the chart unchanged records no step (a Restore always records one). Counts that come out zero still form valid data (`created: 0`, `changed: {}`), so a reader accepts them.

## 14. Classification and report reasons

### 14.1 Result kinds

| Result | When |
| --- | --- |
| `not-project` | A ZIP without `project.json`, or whose `project.json` is not an object with `format: "nxsp"`. |
| `unreadable` | Not a readable ZIP (no end record and no local header; more than 65,535 entries); `project.json` ambiguous or unreadable (cap, CRC, inflate, UTF-8, JSON, depth); `level.json` missing, ambiguous or unreadable. Nothing opens. |
| `nxsp`, `full` | The report is empty or holds only `newer-patch`. |
| `nxsp`, `partial` | Any other report item. The editor opens it as a separate copy: unbound, a new document id, no revision; it never writes over the original. |

The editor's open is whole only when the result is `full`, the level report (§7.5) is empty, and the level parsed; a refused level opens nothing.

### 14.2 Reasons

| Reason | Cause | Effect |
| --- | --- | --- |
| `damaged` | A directory recovered by scan; duplicate names; overlapping data; a pointer outside its prefix or two pointers on one entry; a manifest, segment or media entry that fails as a ZIP entry or passes its cap; `chunks.bin` past its caps; a manifest or segment that is not UTF-8, not JSON or nested deeper than 64; the parts together over 512 MiB; more than 4,096 segments; a non-object `parts` | History not read. |
| `history-unreadable` | A part missing; a schema failure inside the history (§9, §10, §11); a dangling hash; an index that does not tile; a header or head chunk failing (its hash, its JSON or its schema), or `chunks.bin` failing as a ZIP entry while one is read (§9.3); a root or node not hashing to its key; `index` out of range; a key with two values; an `entries` mismatch; a resource-invalid description; a bad `x` | History not read. |
| `newer-history` | A manifest `version` above 1, a root `v` above 1, an entry `kind` or kind name this build does not know | History not read. |
| `unknown-key` | An unknown key in a closed object: `editor`, `history`, media forms, tags, `parts`, `level.json`'s top level, and anywhere in the history outside `x` | Partial; in the history, history not read. |
| `unknown-entry` | An entry no pointer names | Partial. |
| `invalid-key` | A known `project.json` key of the wrong form (`version` not 1 and not newer, `minor`, `patch`, `levelVersion`, `appVersion`, `id`, `lineageId`, `name`, `exportName`, `level`, `revision`, `editor`, a media form, `metadata` fields, `history`) | Partial. |
| `newer-minor` | `minor > 0` | Partial; history not read. |
| `newer-patch` | `patch > 0` | A notice only: the open stays full. |
| `newer-level` | `levelVersion > 1` | Partial. |
| `newer-version` | `version > 1` | Only `level.json` is read; the editor asks first, then opens the level as a copy. |
| `media-unreadable` | A held media entry missing or not matching its size and SHA-256 | Partial; the rest opens. |

History is read only when the report holds no `damaged` and no `newer-minor`.

### 14.3 The line the editor shows

Most serious first (`partialLine`, `src/local/open/decide.ts`): any `damaged` "This file is damaged. It was opened without its history."; else `history-unreadable` or `newer-history` "This file's history could not be read. Saving makes a separate file."; else `unknown-entry`, `unknown-key`, `invalid-key`, `newer-level`, `newer-minor` or a non-empty level report "Made by a newer version of Next SEKAI Editor. Saving makes a separate file."; else `media-unreadable` (the media line); else `newer-version` adds none; else `newer-patch` alone "Made by a newer version of Next SEKAI Editor. Some content may not be shown." (Exact wording: `src/i18n/en/index.json`, `open.*`.)

## 15. Reject, tolerate, ignore; reader caps

### 15.1 Caps

| What | Cap |
| --- | --- |
| ZIP entries | 65,535 |
| `project.json` (inflated) | 1 MiB |
| `level.json` | 64 MiB |
| manifest, each segment | 256 MiB |
| manifest and all segments together (declared sizes) | 512 MiB |
| segments | 4,096 |
| `chunks.bin` | 2 GiB |
| one chunk (inflated) | 16 MiB |
| one media entry | 1 GiB |
| JSON nesting (arrays and objects, every JSON entry and chunk) | 64 |
| a DEFLATE entry's stored size | `2 * size + 1024` |
| an operation / a step / a context | §11.3 |
| an `x` | 256 KiB, 32 levels |

Caps are judged from declared sizes before reading; inflating past the declared size is damage.

### 15.2 Rejected (damage or unreadable)

The encryption flag; a method other than 0 or 8; a CRC, size or local-header mismatch; overlapping entries; duplicate names; a hash that is not exactly 32 lowercase hex characters; `kept` other than `false`; `dirty` other than `true`; `noteCount: null`; a non-count `time`; a step, context or entry key outside its carrier (`unknown-key`); an `x` that breaks §11.6; an operation or step past §11.3; a chunk that does not hash to its name or does not end exactly; a record that breaks §8.

### 15.3 Tolerated

Unknown top-level and `metadata` keys (kept as extra); unknown keys inside `revision` and `summary` (ignored); a `savedAt` that is not RFC 3339 (absent); a non-string `completeFrom` (absent) or one that cannot be placed (the file's own id); a stale `summary` (ignored); `x` on any carrier; unsupported operations (kept whole); any entry order; STORE or DEFLATE for any entry; data descriptors, extra fields, ZIP64; ignored entries (§3.2); chunks that hash to their name but are not canonical; one leading BOM in a JSON entry; JSON duplicate keys (the last wins); roots and nodes nothing references; an entry without `noteCount`.

### 15.4 What a viewer may ignore

Entry names other than through pointers; the DOS times; `summary` (derive it); `dirty`; `appVersion`; `device` labels; `revision.ancestors`, `replaces`, `completeFrom` (unless comparing files); `extra`; every `x`; the writer's split, sort and chunk order; `undoStack` when only listing the timeline; level data's `Connector`, `SimLine` and hidden-tick entities. A viewer that never writes may also skip the level report and show the head from the History head whenever it matches (§10.6).

## 16. Writer rules (for round-tripping)

A reader needs none of this. A writer that wants its files to open as the editor's do and survive a round trip unchanged follows it. `tools/nxsp_check.py` in strict mode checks it.

### 16.1 Container and `project.json`

- The pinned headers of §3.1; entry order of §4; one DOS time from `savedAt`; never ZIP64 (a plan of 65,535 entries or more, or any size or offset of 4 GB or more, is refused).
- JSON is `JSON.stringify` output: compact, no BOM, no trailing newline. JSON entries are DEFLATE (raw, pako's default level); `chunks.bin` and media are STORE.
- `project.json` keys in the order `format version minor patch levelVersion appVersion id lineageId revision name exportName level editor bgm history summary metadata`, then the extra keys, then extra `metadata` keys merged into `metadata`; `parts` never. `revision` keys in the order of §5.3; `savedAt` UTC to the second; at most 1,024 ancestors; `completeFrom` only with history, written as given when it is the new id or an ancestor, else the oldest ancestor, else the new id.
- `minor` and `patch` are the lowest that hold the content (both 0 in v1). `editor` is `{}` when there are no default guide colours. `metadata` per §5.4. `summary` is always written: `noteCount` of the head, `durationMs` = the time of the latest note beat (summing `(min(last, end) - start) * 60000 / bpm` over BPM segments in list order, the first applying from beat 0), `Math.round`, 0 when not a positive safe integer; `revisionId` the new revision.
- `history.entries` the total entry count; `segments` only when there are any.

### 16.2 History

- A **new or rebuilt** chronology (Save As, Recent Sessions' Save…, a copy, a write that cannot append) is cut into segments of 500 entries while more than 500 remain; the manifest holds the last 1 to 500 and always the write's own `save` entry, last.
- An **append** (a write-back to the chain's own file at its base): the source's segments are copied whole in order (same bytes and method); its `chunks.bin` is the new one's prefix, unchanged; its manifest becomes a new segment when it holds 500 or more entries, else its entries, roots, nodes and chunks carry into the new manifest; the new rows follow in the manifest, never split. A write-back to a file without history has nothing to copy. When that Save includes History, it writes the chain's chronology as a new one is written, keeping the file's `id` and taking its revision as `parent`, so the file gains history.
- Each part holds the roots, nodes and chunks its entries first reference, in first-reference order: entries in order (the snapshot, then a `recovered` entry's pushes), then the undo slots, then any other roots; for each root its header chunk, then its kinds in order, each node's chunks in order. New chunks are appended to `chunks.bin` in that order.
- Entry keys in the order `kind`, `step` or `operation`, `recoveryContext`, `time`, `snapshot`, `noteCount`, `dirty`, `kept`, `revisionId`, `device`, `appVersion`, `stack`, `x`. A row whose state the writer does not hold whole is written `kept: false`, never left out; a row's `noteCount` is written only when known.
- The chronology ends with this write's `save` entry. The undo stack is the saved session's, at most 1,000 slots, renumbered so that every slot's root is in the file.
- Snapshots: records, canonical text, hashes, split and node grouping exactly as §8; chunks deflated raw at pako's default level (any valid DEFLATE gives the same hashes).

### 16.3 Media entry names

A cover or preview is `assets/cover.<ext>` or `assets/preview.<ext>`. The BGM is `bgm/<stem>.<ext>`: `<ext>` the original name's extension when it is 1–10 ASCII letters and digits, else from the type (`audio/mpeg` mp3, `audio/ogg` ogg, `audio/wav` and `audio/x-wav` wav, `audio/flac` flac, `audio/mp4` m4a, `audio/aac` aac, `audio/webm` webm, `image/png` png, `image/jpeg` jpg, `image/webp` webp, `image/gif` gif, `image/avif` avif), else `bin`; `<stem>` the name before that extension with only `A-Za-z0-9._ -` kept, dots and spaces at either end removed, runs of spaces as one `-`, cut at 120 characters (trailing dots removed again), a first dot-segment that is a Windows device name (`con prn aux nul com1-9 lpt1-9`) given a `-`, and `bgm` when nothing is left. `Coconut (Master).mp3` becomes `bgm/Coconut-Master.mp3`; `曲 名.mp3` becomes `bgm/bgm.mp3`.

### 16.4 `level.json`

Serialise from the state with the entity order, data order and codes of §7.2–§7.4, entity names as lowercase hex in the order first needed. Per slide: the notes, then for each connector run the hidden ticks the engine needs (`TransientHiddenTickNote` along active connectors, `TransientHiddenDamageTickNote` along damage ones, on half-beat ticks as `scheduleHiddenTicks` in `src/state/entities/slides/hiddenTicks.ts` places them) and a `Connector` with `head`, `tail`, `segmentHead`, `segmentTail` and, for active and damage connectors, `activeHead` and `activeTail`; after all slides, `SimLine` entities between neighbouring notes (by lane centre) that share a tick, per stage when its sim lines are isolated, else across stages, for every note but anchors, damage notes and ticks. `editor.defaultGuideColors` lists the default-coloured guide notes' entity indices. The code is `src/levelData/entities/serialize/`.

## 17. Worked examples, fixtures and tools

### 17.1 The minimal file, byte by byte

A Save with History off of the editor's new chart (829 bytes; `01-minimal-no-history.nxsp` of the clean-room corpus, §17.4): two entries, both DEFLATE, saved 2026-10-20 08:00:00 UTC.

```
000: 50 4b 03 04              local header signature
004: 14 00                    version needed 2.0
006: 00 08                    flags 0x0800
008: 08 00                    method 8
00a: 00 40                    DOS time 0x4000 = 08:00:00
00c: 54 5d                    DOS date 0x5d54 = (46 << 9) | (10 << 5) | 20 = 2026-10-20
00e: 38 be 63 f0              CRC-32 0xf063be38
012: 0f 01 00 00              compressed size 271
016: dc 01 00 00              uncompressed size 476
01a: 0c 00 00 00              name length 12, extra 0
01e: "project.json"           then 271 bytes of raw DEFLATE
139: 50 4b 03 04 …            level.json's local header (offset 313); 340 bytes of DEFLATE for 1,414 bytes of JSON
2b5: 50 4b 01 02 14 00 14 00 00 08 08 00 00 40 54 5d 38 be 63 f0 0f 01 00 00 dc 01 00 00
     0c 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 "project.json"
     central record: made by 2.0, needed 2.0, flags, method, time, date, CRC, sizes,
     name length 12, extra/comment/disk/internal 0, external 0, local offset 0
2ef: 50 4b 01 02 … 39 01 00 00 "level.json"       central record, local offset 313
327: 50 4b 05 06 00 00 00 00 02 00 02 00 72 00 00 00 b5 02 00 00 00 00
     end record: 2 entries, directory 114 bytes at offset 693, no comment
```

Its `project.json` is §5.2. Its `level.json` (the editor's new chart with two one-note slides; dynamic stages off, so no `Stage` and no `stage` refs; the group entity named `"0"` when the first note refers to it):

```json
{"bgmOffset":0,"entities":[{"archetype":"Initialization","data":[{"name":"initialLife","value":1000},{"name":"revision","value":2}]},{"archetype":"#BPM_CHANGE","data":[{"name":"#BEAT","value":0},{"name":"#BPM","value":60},{"name":"meter","value":4}]},{"archetype":"#TIMESCALE_GROUP","data":[{"name":"editorName","ref":"Default"}],"name":"0"},{"archetype":"NormalTapNote","data":[{"name":"#TIMESCALE_GROUP","ref":"0"},{"name":"#BEAT","value":1},{"name":"lane","value":1},{"name":"size","value":1},{"name":"style","value":0},{"name":"direction","value":0},{"name":"isAttached","value":0},{"name":"isSeparator","value":0},{"name":"connectorEase","value":1},{"name":"segmentKind","value":1},{"name":"segmentAlpha","value":1},{"name":"segmentLayer","value":0},{"name":"effectKind","value":0},{"name":"segmentThroughJudgeLine","value":0},{"name":"segmentPresentation","value":0}]},…]}
```

The first note is `left 0, size 2` (lane centre 1, half-width 1); the second `left -3, size 3` (centre −1.5, half-width 1.5).

### 17.2 A small history

A first Save of a chain of three states (`05a-sessions-first-save.nxsp` of the corpus): `project.json` adds `"completeFrom":"e001-…"` to `revision`, `"name":"Small"` (the builder was given a name, as the apps write one; the web writes none, §5.1) and `"history":{"manifest":"history/manifest.json","chunks":"history/chunks.bin","entries":5}`. The manifest (hashes shortened to 8 characters, fallbacks elided):

```json
{"version":1,
 "entries":[
  {"kind":"init","operation":{"id":"nse.origin","data":{"origin":"autoSave"},"version":1,"fallback":{"locale":"en","text":"Opened the old auto save"}},"time":1792746001000,"snapshot":"6caa811a…","noteCount":1},
  {"kind":"edit","step":{"kind":"edit","operation":{"id":"nse.note.add","data":{"created":1},"version":1,"fallback":{…}}},"time":1792746002000,"snapshot":"7e372c19…","noteCount":2,"dirty":true},
  {"kind":"edit","step":{…"nse.note.add"…},"time":1792746003000,"snapshot":"2e159c27…","noteCount":3,"dirty":true},
  {"kind":"export","operation":{"id":"nse.file.export","data":{"file":{"text":"Small.nsld.gz"},"delivery":"download"},…},"time":1792746004000,"snapshot":"2e159c27…","noteCount":3,"dirty":true},
  {"kind":"save","operation":{"id":"nse.file.save","data":{"file":{"text":"small.nxsp"},"delivery":"download"},…},"time":1792746005000,"snapshot":"2e159c27…","noteCount":3,
   "revisionId":"e001-0000-4000-8000-000000000000","device":{"id":"d3v1ce00-…","label":"Web (Chrome)"},"appVersion":"0.6.0"}],
 "roots":{
  "6caa811a…":[1,"96a6b961…",[["slides","984ac069…"],["bpms","70557252…"]],1],
  "7e372c19…":[1,"96a6b961…",[["slides","fa181666…"],["bpms","70557252…"]],2],
  "2e159c27…":[1,"96a6b961…",[["slides","f600b77e…"],["bpms","70557252…"]],3]},
 "nodes":{"984ac069…":["slides",0,["4314b22c…"]],"70557252…":["bpms",0,["051d3d5b…"]],"fa181666…":["slides",0,["367b8d1c…"]],"f600b77e…":["slides",0,["4303a2d7…"]]},
 "chunks":[["96a6b961…",0,65],["4314b22c…",65,75],["051d3d5b…",140,12],["367b8d1c…",152,86],["4303a2d7…",238,93]],
 "undoStack":{"base":0,"slots":[{"snapshot":"6caa811a…","step":{"kind":"init","operation":{…"nse.origin"…}}},{"snapshot":"7e372c19…","step":{…}},{"snapshot":"2e159c27…","step":{…}}],"index":2}}
```

The three states share one header chunk and one `bpms` node: equal records give equal hashes. The chunk index tiles `chunks.bin` (331 bytes): 0+65, 65+75, 140+12, 152+86, 238+93 = 331.

The `bpms` chunk, worked through: canonical text `[[0,60,4]]` (10 bytes); SHA-256 begins `051d3d5b72e451f94ad6a8535d65fa79`, its name; stored at offset 140 as the 12 bytes `8b 8e 36 d0 31 33 d0 31 89 8d 05 00` (raw DEFLATE). The header chunk at offset 0 inflates to `[1000,false,0,[[1,"Default",0]],[[1,"#1",true,true,"global"]],[],[],["","","","",[],[],[]]]`: Initial Life 1000, dynamic stages off, offset 0, group 1 "Default" (no Force Note Speed), stage 1 "#1" (From Start, Until End, global sim lines), no folders, empty level info, no BGM. The first slides chunk inflates to `[[[1,1,0,0,"default","default","default",false,-6,2,false,"none",false,"default",false,"active","linear",false,false,1,"top",false,"default"]]]`: one slide of one note at beat 0, lanes −6 to −4.

### 17.3 An append

The second Save of that chain (`05b-sessions-append.nxsp`) was written back over the first. Its `chunks.bin` begins with 05a's 331 bytes unchanged (the first five index items are 05a's), the manifest begins with 05a's five entries, `revision` is `{"id":"f001-…","parent":"e001-…","n":2,"ancestors":["e001-…"],"completeFrom":"e001-…",…}`, and the entries continue with a `continue` of `nse.origin` (`{"origin":"import","source":{"text":"small.nxsp"}}`), an `nse.externalChange` edit, edits, undos, a redo, a restore, an export, a `continue` of `nse.continue`, a `recovered` entry, two unsupported operations, an entry with `x`, and the new `save`.

### 17.4 Fixtures and tools

- `tests/local/nxsp/golden-v1/` (`write-1.nxsp`, `write-2.nxsp`, an append): the builder golden. `tests/zip/plan-conformance-v1/`: plan-to-bytes cases, with failures, that any writer implementation must reproduce. `tests/local/records/golden-v1/`: record and snapshot vectors (the golden and edge charts). `tests/local/records/schema-v1/`: record values the v1 schema must accept and must reject. `tools/fields-v1.json`: every record form, the kind order and the enum sets, machine-readable.
- The examples in §17.1–§17.3 are files of a clean-room test corpus, written by the editor's own builder (`planNxsp` and `executePlan`). The corpus is not kept, so the bytes and numbers here are its record.
- `uv run python -I tools/nxsp_check.py --read FILE...`: an independent reader that prints one JSON line per file (kind, open, report) and agrees with the editor on every probe of `tests/local/nxsp/agreement.test.ts`. `uv run python -I tools/nxsp_check.py FILE...`: the strict writer check. `--show FILE HASH`: a record, chunk, root or node with field names.
