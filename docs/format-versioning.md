# Format versioning

How the editor's stored and exchanged formats change, and what each version number does. Read this before changing anything a file, a database row, a journal or an operation holds.

The authority is the plan (Part 1 §1.6.11.8, with §1.6.11.1–§1.6.11.6 for the forms); this page is the working summary with the checklist. `docs/` in the repository holds no other format description. The full byte-level description of `.nxsp` is in the owner's `work/nxsp-format.md`.

## 1. The ruling

- **Until Stage 1 ships (v0.6.0), formats change in place at their current version**, with no version bump and no compatibility code, because nothing has shipped (owner, 2026-10-19). Keep the goldens, the codec tests and `tools/fields-v1.json` in step with every such change. Regenerate a golden with `NSE_WRITE_GOLDEN=1` and say so in the commit.
- **From the ship, every rule below applies.** A format byte, a reader rule or a version value that is out in people's browsers and apps cannot be taken back: stale tabs, store builds and the APK keep reading with the rule they shipped.
- **Readers before writers.** A reader that understands a thing ships (and reaches users) before any writer writes it. Auto-updating web builds soften this; stores, the APK and stale tabs do not (Part 4 4.9.4).
- **The lowest-version rule.** A writer writes the lowest version number that holds what it writes, so a file that uses no newer feature stays readable, with unchanged hashes, by older builds.

## 2. Every version number

| Number | Value | Where it is written | What it guards | What an older reader does |
| --- | --- | --- | --- | --- |
| `project.json` `version` (major) | 1 | every `.nxsp` | The container and `project.json`'s layout. | Reads only `level.json` (`newer-version`); asks first, then opens the level as a separate copy. |
| `project.json` `minor` | 1 | every `.nxsp` | The reader generation. Rises for a change an older reader would **misread**, or could not read the history of: a merge revision (more than one parent), the manifest `version`, a new entry `kind`. | Opens partial and **leaves the history unread** (`newer-minor`); the open says "Made by a newer version…". |
| `project.json` `patch` | 0 | every `.nxsp` | The additive generation. Rises for content an older reader can leave out without misreading what remains: a new ZIP entry kind, a `parts` key, an `x` carrier a build starts to write. Absent reads as 0. | Opens **normally** (bound, if nothing else is unknown) and **keeps the history**; shows one line, "Made by a newer version of {0}. Some content may not be shown." (`newer-patch`). |
| `project.json` `levelVersion` | 1 | every `.nxsp` | The level-data model: an archetype, field or choice value an older parser would drop or replace. | Partial open (`newer-level`); the level parser reports the rest. A parser refusal reads as the newer-version refusal. |
| engine `revision` (`LATEST_REVISION`) | 2 | level data | What an engine field means. | A warning (`getRevisionWarning`), or a partial open when it is above `LATEST_REVISION`. |
| manifest `version` | 2 | `history/manifest.json` | The manifest's and a segment's layout. | `newer-history`: history not read, the level opens. |
| `RECORDS_V` (root `v`; journals' `recordsV`) | 1 | every root; every journal | The snapshot records: positions, the root and node form, the canonical rule. Rises when a record's positions or values change, and with `LATEST_REVISION`; also with `levelVersion` when level data gains something the records must hold too (a new field or choice value). `levelVersion` can rise alone for a change the records already express (nested folders). | A file: `newer-history`. A stored root: the session or entry is "Needs a newer version", never damaged. A journal: left in place. |
| `SESSION_V` | 2 | session rows | How a session's stack and entries are read. | Newer: "Needs a newer version" for the session and its whole chain. Older or malformed: not read, and not called newer. |
| `JOURNAL_VERSION` | 2 | journals | A journal field an older build must not drop or misread. | Newer: left in place for a later build. Older or malformed: its bytes go to the `recovered` store, nothing is lost. |
| `DB_VERSION` | 2 | IndexedDB | A store or index added; the "stop old tabs" lever. | A newer database opens read-only (Part 1 §1.6.1). |
| `meta.formatVersion` (`FORMAT_VERSION`) | 1 | the `meta` store | The rules GC and cleanup use (§1.6.8.6). | An unknown value stops GC and cleanup. |
| Dump `version` (`DUMP_VERSION`) | 1 | the dump format | The raw-data dump. | Refused. |
| operation `version`, per id | 1 | the operation envelope | One operation's `data` shape. | An unknown id or version renders its `fallback`; a known id whose `data` fails its codec reads "cannot read the details", never damage. |

The constants are `src/local/nxsp/version.ts`, `src/local/records/version.ts`, `src/levelData/levelVersion.ts`, `src/levelData/revision.ts`, `src/local/journal/format.ts`, `src/local/db.ts` and `src/local/dump.ts` (`DUMP_VERSION`); `tests/local/formatVersions.test.ts` asserts each. The shipped values are not all 1 (manifest 2, minor 1, session 2, journal 2, DB 2 are generation 2 of the History redesign); they stay, because resetting them to 1 would only strand development data.

### Why `minor` and `patch` are two numbers

An older reader meeting additive content has two good options, and they are different: a file that **only adds something ignorable** should open as it always did, with its history; a file that **changes what existing content means** must not be trusted. `patch` is the first, `minor` the second. Before this rule every new ZIP entry or `parts` key would have raised `minor` and cost every older reader the whole history.

- New content that an older reader reports as unknown (a ZIP entry it does not name, a `parts` key) still makes **that** open partial and unbound (`unknown-entry`, `unknown-key`), whatever `patch` says. `patch` makes the line shorter and the open whole only when nothing else is unknown, which is the case for content a reader ignores by rule (`x`, `cache/`, `extra` keys).
- A partial open never says "newer version" twice: a newer `patch` adds its line only when no other reason already gives one.

## 3. The extension points

What a later build may add without changing an older reader's behaviour, and what the older reader does with it. Anything not in this list needs a version.

| Point | Where | Older reader | Writer rule |
| --- | --- | --- | --- |
| `x` | an entry; a step; a recovery-context item, head and context; an undo or `recovered` slot; a `stack`; `undoStack`; the manifest and a segment | Accepts a JSON object within the operation byte limit, **never reads it**, carries it by value wherever it copies the object whole, and may drop it where it rebuilds the object (slots and `undoStack` are re-serialized from the session; a rebuilt manifest drops its own). Not an object: damage. | Today's writers write none. Never put anything a reader must understand in `x`: that takes a version. |
| `extra` | top-level `project.json` keys and `metadata` keys | Kept and written back unchanged by every Save. | A carried key must stay valid when stale: it must not index `level.json` positions, or it must carry the `revision.id` it was written for, since an older build can edit the chart and write the key back. |
| `parts` | `project.json` | Any key is unknown (partial open); `parts` is never kept. | Reserved for keys that name a new ZIP entry, so an older build's separate copy never carries a pointer without its entry. Raises `patch`. |
| `cache/` | ZIP entries | Ignored, never copied. | Derived data only, each item tied to a `revision.id` or a SHA-256; it must work without it. |
| New operation ids | operation envelope | Renders `fallback`; no partial open, no version. | See §5. |
| Trailing record fields, new enum values, new archetypes | records, level data | Positional records with hashes cannot carry ignorable extras. Raises `RECORDS_V` and `levelVersion`; an older reader meets such a chain as "Needs a newer version". | Readers before writers. `npm run format:bump` is planned release tooling (Part 4 4.9.4); until it exists, raise `levelVersion`, the root `v` and `RECORDS_V` together and freeze the old table by hand. |
| `revision`, `summary` | `project.json` | Unknown keys inside are ignored; every write replaces both. | A derived value carries the `revisionId` it was computed for. |
| `patch` | `project.json` | See §2. | Raise it for additive content (§4). |

Not extension points, on purpose: an unknown ZIP entry or `parts` key (partial open), an unknown `editor` key (level-adjacent content: partial open), an unknown entry kind (`newer-history`, the whole history unread), a key in an entry, step or manifest outside `x` (`unknown-key`: history unread, "Made by a newer version…"), and strict operation codecs.

## 4. Checklist: changing a format

Work down the list in order. The first row that fits decides the number.

1. **Decide what the change is.**

   | The change | Number | Older reader |
   | --- | --- | --- |
   | Cannot even open the level from the file; a different container or `project.json` layout | `version` (major) | level only |
   | Changes what existing content means, or adds something an older reader would misread or could not read the history of (a merge revision, a new entry kind, a changed meaning of an existing field) | `minor` | partial, history unread |
   | Adds content an older reader can leave out without misreading what remains (a new ZIP entry kind, a `parts` key, a newly written `x`) | `patch` | opens normally, one line |
   | A new archetype, field or choice value in level data | `levelVersion`, and `RECORDS_V` when the records hold it too | partial |
   | A record position, the root or node form, the canonical rule; a new `LATEST_REVISION` | `RECORDS_V` | "Needs a newer version" |
   | The manifest's or a segment's layout | manifest `version` (and `minor`) | `newer-history` |
   | How a session's stack or entries are read | `SESSION_V` | "Needs a newer version" |
   | A journal field an older build must not drop | `JOURNAL_VERSION` | left in place |
   | A store or index | `DB_VERSION` | read-only |
   | An operation's `data` | that id's `version` (§5) | "cannot read the details" |
   | A new operation | a new id | fallback text |

2. **Readers before writers.** Ship the reader that understands the new thing first. The writer's new output is gated on that reader being out.
3. **Update, in the same commit** (or the same package):
   - the constant and its table (`MINOR_TABLE` and `PATCH_TABLE` in `src/local/nxsp/version.ts`: a new ZIP entry kind or `parts` key goes in both, `0` in the `minor` table and the `patch` it ships in in the other);
   - `tests/local/formatVersions.test.ts`;
   - the reader (`read.ts`, `project.ts`, `manifest.ts`) and the writer (`build.ts`);
   - **the four places that hard-code what an older reader does**, which no constant reaches: `partialLine` in `src/local/open/decide.ts` (which reasons give which line, and in what order); `newerFile` and `newerPatch` in `src/editor/commands/open/project.ts` (what reads as a newer file's refusal); `replaceUnavailable` in `src/editor/save/flow.ts` (it reads `NXSP_VERSION` and `NXSP_MINOR`, and rightly not `patch`: Replace is offered for a newer patch); and the checker's literals in `tools/nxsp_check.py` (`minor <= 1`, `patch` present and `<= 0`, `project["patch"] > 0`, `minor > 1`, `levelVersion > 1`, manifest `version == 2`) and its `PROJECT_KEYS`/`ENTRY_KEYS`;
   - for an `x` a build starts to write: its row in `PATCH_TABLE.carrier`, which is what makes `patchOf` write the new `patch` (the writer scans what it emits and what it carries, with `carriersIn`);
   - the independent checker `tools/nxsp_check.py` (strict mode and `--read`), and `tools/fields-v1.json` through `npm run format:gen` for any record change;
   - the goldens, **in this order**: `NSE_WRITE_GOLDEN=1 npx tsx --test tests/local/nxsp/golden.test.ts` (the builder golden, `tests/local/nxsp/golden-v1/`), then `NSE_WRITE_GOLDEN=1 npx tsx --test tests/zip/planConformance.test.ts` (the conformance cases are built from it), then `uv run python -I tools/nxsp_check.py` over `golden-v1/write-*.nxsp` and every `plan-conformance-v1/*/expected.nxsp`; for a record change `npm run format:gen` and the records goldens (`tests/local/records/golden-v1/`, `schema-v1/`). The long-history sample (`npm run samples:long-history`) lives in the owner's `samples/` folder, outside the repository: regenerate it and run `tests/samples/sampleFormat.test.ts`. After the ship a golden is never edited: a new generation adds a new golden;
   - `tests/local/nxsp/agreement.test.ts` (a plan-derived expectation for the new case, beside the readers' agreement);
   - the plan (Part 1 §1.6.11.4–§1.6.11.8, then rebuild `plan/plan.md` with the README's cat command), the byte-level description `work/nxsp-format.md`, this page, and `CHANGELOG.md` under Unreleased when users see it;
   - the user-facing line, if the open should say something, in all seven locales.
4. **Run** the reader agreement test (both readers must open every probe alike), the checker over the regenerated goldens, `npm test`, and the open, save and history browser specs.
5. **Say it in the commit:** which number moved and why, and that readers ship first.

The lowest-version rule applies to the writer: compute each number from the content with the pinned tables, never from feature flags, so a bug cannot over-report.

## 5. Operations: any change to an operation's data raises that id's `version`

Operation codecs are strict: a member the codec does not list makes the data fail it. So a new field, **even an additive one**, must raise that id's `version`, or an older build shows "cannot read the details of this step" instead of "recorded by a newer version of the editor". After the ship:

- a changed shape of an existing id raises its `version` (2, 3, …); the old codec stays for reading old data;
- a new operation takes a new id; an older build renders its `fallback` and treats it as opaque;
- a descriptive field is never state: an operation is a description and must not carry what a replay needs;
- before the ship, a change to an id's data is made in place, with its codec table row (`tests/editor/historyCodecTable.test.ts`), its presentation and its receipt test, and the goldens regenerated if a golden holds that id.

## 6. Field units

- Times in files and rows are **milliseconds since the epoch**: an entry's `time`, `fromTime`, `targetTime`. `revision.savedAt` is the one string time, **RFC 3339 `date-time`** (`YYYY-MM-DDThh:mm:ss`, an optional fraction, `Z` or `±hh:mm`, uppercase `T` and `Z`, a date that exists, seconds 00–59). A reader takes anything else, a non-string included, as **absent**, never as a reason to open partial, and never guesses as `Date.parse` does.
- `bgmOffset` is in **seconds** everywhere (level data, the header record, `nse.header.set` and `nse.bgm.change` data); the editor shows milliseconds.
- `durationMs` and `activeMs` carry `Ms`. `summary.durationMs` is derived from the head and used only for its `revisionId`.
- Beats are beats; lanes are lane units; `initialLife` is the plain number the header holds.
- Operation owner moves (`fromIndex`, `toIndex`) are **0-based**: positions among a domain's entries in tree order, or among top-level items for a folder. Step Details shows them 1-based, for a reorder only.
- Counts in operations (`created`, `removed`, `changed`, `added`) are positive safe integers; a map of counts never holds a zero.
- Text in an operation is a `NameText` (`{ text, truncated? }`) of at most 256 code points; `fallback.text` is at most 1,024.
- Hashes are 32 lowercase hex characters for 16 bytes in files and journals (64 for a full SHA-256), raw 16 bytes in IndexedDB.
- `rating` in level info is a plain finite number; no range is enforced.

## 7. What the readers do not do

- They do not read the history of a file whose `minor` is newer, or of one that is damaged.
- They do not carry through a Save any content they do not read, except `extra` and the contents of `x` and an operation.
- They do not recover a missing or unreadable `level.json` from the history. A later build may; it changes how a build treats damaged files, not what files contain.
- Nested folders: the record schema keeps `folder.folderId` on purpose. This build never sets it, shows nested folders flat, keeps the link through edits and records, and writes `level.json` flat (`tests/local/records/nestedFolders.test.ts`). A later nesting feature keeps v1 roots (the lowest-version rule) and raises only `levelVersion`; an older build opens such a file partial, with its history read and the folders shown flat.
