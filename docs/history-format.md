# History format

How the editor records, stores and writes History: the undo stack, the stored sessions and chains, the `.nxsp` file and every History operation. Read it before you change the undo stack, a stored row, a journal, the `.nxsp` history parts or an operation. Version numbers, the `patch` and `x` carrier rules and the bump checklist are in [format-versioning.md](format-versioning.md); this page does not repeat them, and says "see format-versioning" where a number decides.

- **Formats are v1 and change in place until Stage 1 ships.** There are no version bumps and no compatibility code before the ship (owner, 2026-10-19). Keep the goldens, the codec tests and `tools/fields-v1.json` in step with every change.
- **The code is the record.** Paths are relative to `editor/`. Where an older note disagrees with the code, the code wins; a fact that could not be settled from the code is in "Open questions" at the end.
- **Data loss is the top concern.** Section 5 lists what must never happen and the test that guards each rule.

## 1. Overview

History is the editor's account of what happened to a chart. It has four parts:

- **The undo stack** (in memory): a list of states, one per step, and an index. Undo and Redo move the index. An edit pushes a new state after the index and drops the redo tail.
- **Stored sessions and chains** (IndexedDB): every change to the stack becomes an **entry** in the open **session**. Sessions that belong together form a **chain**. Entries point at **snapshots**, the stored form of a chart state. The Timeline, Go To, Restore and peek read these.
- **Saved entries** (`save` and `export` entries): a record that a file event happened, with the revision, the device and the app version of a Save.
- **The `.nxsp` file**: a Save can carry the chain's history as a manifest, optional segments and one `chunks.bin`. Opening a file imports it back into IndexedDB.

A step is **described** by an operation (`nse.*`), a small JSON envelope. The operation says what the user did; the snapshots say what the chart was. Undo and Redo never replay an operation. They move to the state the slot holds (section 4.1).

**Peek and Go To.** Peek shows an entry's state read-only in place of the live one; nothing peeked reaches storage or a file. Go To is the Timeline's jump list (Now, then days and sessions, newest first). Restore pushes an entry's chart as a new `restore` step (section 4.6).

### 1.1 Map

| Layer | Key types and functions | Files |
| --- | --- | --- |
| In-memory stack | `Slot`, `pushState`, `undoState`, `redoState`, `restoreStates`, `resetStates`, `markFileEvent` | `src/history/stack.ts` |
| Stack events | `HistoryAction`, `emitHistoryAction`, `onHistoryAction` (early actions replayed to the first listener) | `src/history/actions.ts` |
| Session descriptor | `SessionDescriptor`, `session` | `src/history/session.ts` |
| Starting a chart | `resetState`, `openStoredState`, `openState`, `resetImportedState` (`nse.origin`) | `src/history/index.ts` |
| No-op test | `sameChart` | `src/history/sameChart.ts` |
| Peek and Restore | `peekEntry`, `restoreEntry`, `PeekSource` | `src/history/peek.ts`, `src/local/peekSource.ts`, `src/editor/peek.ts` |
| Operations | `operationCodecs`, `decodeOperation`, `createOperation`, `captureStep`, `UndoableStep`, `RecoveryContext` | `src/history/operations/` (`registry.ts`, `fields.ts`, `steps.ts`, `entries.ts`, `json.ts`, `codec.ts`, `grouping.ts`), `src/history/createHistoryOperation.ts` |
| Presentation | `describeOperation`, Step Details model, Timeline grouping | `src/history/operationPresentation/` (`format.ts`, `details.ts`, `aggregate.ts`, `values.ts`, `members.ts`, `types.ts`), `src/editor/history/` |
| Records and hashes | `schema.ts` (single schema source), `canonical.ts`, `snapshot.ts`, `split.ts`, `records.ts`, `encode.ts`, `extract.ts`; `hash.ts`, `chunkVerify.ts` | `src/local/records/`, `src/local/hash.ts`, `src/local/chunkVerify.ts` |
| Flush (page side) | `Flusher`: `begin`, `continueSession`, `resumeSession`, `append`, `reserveSave`/`endSave` | `src/local/flush.ts`, `src/local/chunks.ts`, `src/local/storing.ts` |
| Flush (worker side) | `prepareFlush`, `writeFlush` | `src/local/flushWrite.ts`, `src/local/worker/` |
| Stored stack | `SessionStack`, `replay`, `storedWindow`, `blockRow` | `src/local/timeline.ts` |
| Database | `STORES_V1`, `meta` rows, `hashKey` | `src/local/db.ts`, `src/local/records/rows.ts` |
| Journal | `buildJournal`, `readJournal`, `JournalWriter`, `writeJournalApply` | `src/local/journal/` |
| Save to file | `planSave`, cut, model, bodies, marks | `src/local/save/` (`build.ts`, `cut.ts`, `model.ts`, `bodies.ts`, `mark.ts`, `commit.ts`, `bind.ts`) |
| `.nxsp` write and read | `planNxsp`, `readNxsp`, manifest and project forms, versions | `src/local/nxsp/` (`build.ts`, `read.ts`, `manifest.ts`, `project.ts`, `version.ts`, `execute.ts`) |
| Open (import) | `writeOpenHead`, `writeBatch`, `writeUnlink`, `writeAbandon`, the import loop | `src/local/open/` (`importWrite.ts`, `importLoop.ts`, `decide.ts`, `kept.ts`) |
| Independent checker | `nxsp_check.py`, `fields-v1.json` | `tools/` |

### 1.2 One edit, end to end

1. A tool or command builds a new `State` and a `NativeOperationInput` and calls `createHistoryOperation` then `pushState` (`src/history/stack.ts`).
2. `pushState` captures the step, compares the chart with `sameChart`, and returns `false` without a step when nothing changed (section 4.2).
3. A pushed step emits a `HistoryAction`. `src/local/storing.ts` listens and calls `Flusher.append` with the entry description and the state.
4. About 1 s later (`FLUSH_DELAY_MS`), or at once and strictly on hide, freeze and a media pick, the flusher extracts the new snapshot (records, chunks), and the storage worker writes chunks, nodes, root, the entry, the stack block and the session and chain rows in one transaction (`src/local/flushWrite.ts`).
5. Until the worker acknowledges, entries stay pending, and a last-chance journal in `localStorage` covers them (section 2.9).
6. Save plans the chain's rows into a `.nxsp` file (`src/local/save/build.ts`, `src/local/nxsp/build.ts`). Open reads a file and writes its rows back (`src/local/open/importWrite.ts`).

## 2. The data model

### 2.1 Snapshots: records, nodes, chunks, roots

A **snapshot** is the stored form of one chart state: the chart, the header (Initial Life, dynamic stages, BGM offset, groups, stages, folders, level info, BGM metadata) and nothing else. The chain name, the file binding, the export name, the view and the default guide colours are not in a snapshot. Equal root hashes mean equal states; unequal roots do not prove a difference.

- **Records.** Everything is a **record**: a JSON array whose positions are its fields, holding only arrays, strings, finite numbers and booleans. The schema is `src/local/records/schema.ts`; `tools/fields-v1.json` is generated from it (`npm run format:gen`, `scripts/format-gen.mjs`) and is what the Python checker reads. A format check covers types, finiteness, enum membership and id rules, never ranges.
- **Canonical bytes.** The canonical text of a record is `JSON.stringify` of the array (`src/local/records/canonical.ts`): compact, no whitespace, UTF-8. Holes, `undefined`, `null`, objects and non-finite numbers throw.
- **Hash.** SHA-256 of the canonical bytes, first 16 bytes (`hash16`, `src/local/hash.ts`; the synchronous SHA-256 below 1 KiB, `crypto.subtle` above). It is never taken over the deflated bytes, so a DEFLATE level never changes a hash. In IndexedDB a hash is 16 raw bytes (an `ArrayBuffer` key, `hashKey`); in files and journals it is 32 lowercase hex characters.
- **Chunks.** A chunk is a JSON array of records of one kind, stored as raw DEFLATE (no zlib or gzip wrapper). Reading is strict: the stream must end exactly at its last byte with the final block set (`inflateStrict`, `src/local/chunkVerify.ts`), may not inflate past 16 MiB (`CHUNK_CAP`), and must hash to its name. Every `chunks` put takes a `VerifiedChunk`, which only `verifyChunk` makes.
- **Splitting** (`src/local/records/split.ts`): a record goes in the chunk of its 16-beat window; a window of more than 24 records (`PART_LIMIT`) splits at 4-beat parts, then 1-beat parts, then consecutive runs of 24. A kind other than `slides` with at most 64 records (`SMALL_KIND_LIMIT`) is one chunk. Readers do not assume a split.
- **Kind nodes.** `[kind, depth, [hash16...]]`. Depth 0 lists a kind's chunks in order (at most 16, `NODE_FANOUT`); depth 1 lists depth-0 nodes of 16 consecutive chunks each.
- **Root.** `[v, headerHash, [[kindName, nodeHash], ...], noteCount]` with `v = RECORDS_V = 1` (`src/local/records/version.ts`). Kinds appear only when they have records, in the order `slides, bpms, timeScales, cameraEvents, stageMaskEvents, stagePivotEvents, stageStyleEvents, stageTransformEvents`. The root hash is the snapshot id.
- **Header chunk.** `[initialLife, isDynamicStages, bgmOffset, groups, stages, groupFolders, stageFolders, levelInfo, bgm?]`; it is a chunk like any other, and the root names its hash. Media (BGM, cover, preview) are named by hash inside the header and stored in the `media` store; a state whose media are not held restores with them "not loaded".

Row forms in IndexedDB (`src/local/records/rows.ts`): a root row `{t: 'root', v, kinds, noteCount, refs, size, day}`, a node row `{t: 'node', kind, depth, refs, size, day}` (`refs` are the direct children packed as 16-byte runs: for a root, the header, the kind nodes in `kinds` order, then the media), and a chunk row `{bytes, size, crc32, day}` where `crc32` covers the 16 key bytes then the stored bytes, so a value moved under another key fails (`isChunkRowIntact`).

### 2.2 The in-memory stack

`src/history/stack.ts` holds `states`, a list of `Slot {isDirty, step, state?, snapshot?}`, and `index`.

- A slot always has its `step`, the complete `UndoableStep` that made it (section 4.1). A slot restored from storage has a `snapshot` (the stored root) and builds its `state` when Undo or Redo reaches it. The slot at the index is always loaded. Restored slots other than the head and its neighbours are kept to `RESTORED_LRU = 8`.
- `pushState(operation, state, kind = 'edit' | 'restore')` splices the new slot after the index (dropping the redo tail), sets the index, and emits an `edit` or `restore` action. It refuses to run while peeking (throws outside release builds).
- `undoState` and `redoState` move the index and emit `undo` or `redo` with the crossed step. A slot that is not loaded queues the move; presses coalesce, an edit or a peek cancels them, a failed load cancels and leaves the stack alone (`MoveOutcome`).
- `markFileEvent('save' | 'export', operation)` emits an entry without touching the stack.
- `resetStates` replaces the whole stack with one `init` slot (`nse.origin`); `restoreStates` installs a stored stack with its slots lazy and the head given loaded. `resetStates` emits a `reset` action, which the storing side turns into a new session whose first entry is `init` (`Flusher.begin`); `restoreStates` emits nothing, and the storing side starts the session itself (a continuation, section 2.6).
- A published state is frozen outside release builds (`src/history/freeze.ts`), because the flush finds an unchanged kind or entity by identity: a change in place would store a stale record under a valid hash.

`isDirty` on a slot means "changed since the last file event". A pushed step is dirty; a `save` entry is clean.

### 2.3 IndexedDB stores

Database `nse-local-data`, `DB_VERSION` 2 (`src/local/db.ts`). Upgrades only add stores, indexes and fields; nothing deletes a store or the database. A row keeps fields a newer build added (updates are field-level).

| Store | Key | Holds |
| --- | --- | --- |
| `chains` | `chainId`; indexes `updatedAt`, `docId` | One record per chain: identity, binding, flags (section 2.6) |
| `handles` | `[chainId, role]` | A chain's file handles (`file`, `exportTarget`), kept off its record |
| `sessions` | `id`; indexes `updatedAt`, `chainId` | One row per session (section 2.6) |
| `entries` | `[sessionId, seq]` | The timeline, one row per event (section 2.4) |
| `stackBlocks` | `[sessionId, block]` | The stored undo stack in blocks (section 2.5) |
| `nodes` | 16-byte hash | Root and kind-node rows |
| `chunks` | 16-byte hash | Chunk rows |
| `media` | 16-byte hash | `{blob, sha256, size, type, filename?, kind, day}` |
| `tombstones` | `id` | Marks of removed sessions |
| `recovered` | `id` | Bytes of journals that could not be read (section 2.9) |
| `userAssets` | `key`; index `type` | Not History |
| `meta` | `key` | `formatVersion`, `epoch`, `maxSeenTime`, `dbInstanceId`, `deviceId`, `daysOfUse`, `lastUseDate`, `lastGcAt`, `deletionsPending`, `migratedHashes`, `usage`, `lastPersistFailure`, `createdBy` |

No code in this tree writes `tombstones` or reduces sessions yet; the Timeline only reads them (the "removed to save space" label). `meta.epoch` bumps only in a transaction that deleted something; every flush reads it and re-checks that the hashes it reuses still exist (`missingHashes`).

### 2.4 Entries

An entry is one row of a session. Its key is `[sessionId, seq]`; `seq` starts at 1 per session. Fields (`EntryRow`, `src/local/save/cut.ts`; written by `src/local/flushWrite.ts`):

| Field | Meaning |
| --- | --- |
| `kind` | One of the nine kinds below. An unknown kind makes the session "Needs a newer version". |
| `step` | For `edit`, `restore`, `undo`, `redo`: the complete `UndoableStep` that was pushed, or crossed. |
| `operation` | For `init`, `continue`, `save`, `export`, `recovered`: the operation envelope. |
| `recoveryContext` | Only on `recovered`. |
| `time` | Milliseconds since the epoch; stored strictly increasing (section 2.10). Imported rows keep their time. |
| `snapshot` | Root hash of the state the entry produced or landed on. |
| `noteCount` | Notes in that state. |
| `dirty` | Changed since the last file event. |
| `kept` | `false` when the state is not held whole (section 2.8). Absent or `true` otherwise. |
| `revisionId`, `device {id, label}`, `appVersion` | `save` entries only (section 2.7). |
| `stack {keep, push[], index}` | `recovered` entries only (section 2.9). |
| `day` | Day-of-use stamp for cleanup. Not in files. |
| `x` | Ignorable carrier; see format-versioning. |

| Kind | Produced by | Effect on the stack (as `replay` applies it) |
| --- | --- | --- |
| `init` | A new chart, an import, a recovered auto save (`resetStates`) | Starts the stack with one slot. Allowed only as a session's first entry. |
| `continue` | A new visit, Reopen, Restore Session, a file open | Keeps the inherited stack; a continuation of nothing starts with its own slot. |
| `edit` | `pushState` | Truncates after the index, pushes a slot, index + 1. |
| `restore` | Restore of a History entry | Same as `edit`. |
| `undo` | `undoState` | Index - 1; the entry's snapshot must be the slot it lands on. |
| `redo` | `redoState` | Index + 1; same check. |
| `save` | A Save, a download | None; its snapshot must be the current slot. |
| `export` | An Export to a level file | None; same check. |
| `recovered` | A journal applied after a crash | Replaces slots from `keep` with `push`, sets the index. |

`replay` (`src/local/timeline.ts`) is the oracle: it is strict, and it throws `ReplayError` on an undo that does not land on its snapshot, a first entry of the wrong kind (only `init`, `continue` and `recovered` may begin a session), or an unknown kind. Entries that edit (`edit`, `undo`, `redo`, `restore`, `recovered`; `EDITING_KINDS`) set the chain's `edited` flag.

### 2.5 The stored stack

The page replays its pending entries over the stack last acknowledged (`SessionStack`) and stores the result as blocks, rewriting only the blocks whose slots changed.

- `stackBlocks` rows: `{sessionId, block, first, hashes, steps}`. `hashes` are the slots' roots packed as 16-byte runs; `steps` are the slots' complete steps. `BLOCK_SLOTS = 256`. Slot numbers are absolute.
- The session row's `stack {base, length, index}` is the stored window: at most `STACK_CAP = 5000` slots, always including the index. Normally the newest 5000; if the index sits below them the redo end is cut first.
- Blocks outside the window are deleted in the same transaction. A stack the page cannot follow is removed rather than left behind `lastSeq`, and the next flush writes it whole; replay rebuilds a stack where none is stored (`stackRemoved`).
- A restored undo stack older than its window is marked by `earlierSteps` (Undo past it says so).

### 2.6 Sessions and chains

A **session** is one visit's run of entries; a **chain** is the sessions that belong to one document, in order of `startedAt`.

Session row (`sessions`; written by `flushWrite.ts`, `importWrite.ts`, `journal/apply.ts`):

| Field | Meaning |
| --- | --- |
| `id`, `chainId` | Identity. |
| `v` | `SESSION_V = 2`. Newer: the session and its whole chain read "Needs a newer version". Older or malformed: not read, and not called newer (`sessionReadability`, `src/local/records/unknownValues.ts`). |
| `origin` | `new`, `import`, `nxsp`, `continued`, `migrated`, `journal`, `replaced`. An unknown value reads as an ordinary session. |
| `startedAt`, `updatedAt` | Milliseconds. Chain order is by `startedAt`; sessions sharing a start are ordered by `parent` links, else a write refuses (`orderSessions`). |
| `parent {id, uptoSeq}` | A continuation names the session and the entry it continues. |
| `stack`, `lastSeq`, `entryCount`, `activeMs`, `ownBytes`, `view`, `day`, `appVersion` | Window, newest `seq`, counts, active time, bytes, the Timeline's view (scroll, zoom, group, stage), writer's app version. |
| `importPending` | An open's background import has not finished; Save refuses (`importing`) until it has. |

Chain record (`chains`), by what it holds:

- Identity: `chainId`, `head` (the session that is the chain's head), `docId` (the `project.json` id), `lineageId` (provenance, copied on forks and Save As), `sourceName`, `name`, `renames`, `exportName`, `exportTarget` (handle in `handles`).
- Binding: `file {name, event, at, hash, entry, completeFrom, disk, options, confirmed}` (handle in `handles`), `revision {id, n, ancestors}`, `replaced {by, at, name}` after a takeover, `extra` (unknown `project.json` keys, written back by Save).
- Flags and display: `hasContent`, `edited`, `partialImport`, `summary {title, artists, author, rating, tags, noteCount}`, `badChunks`, `deleting`, `updatedAt`, `day`, `appVersion`.

**Continuing and forking.** A continuation's first write moves the chain's `head` from the parent to it, only if the parent is still the head (a compare-and-set in one transaction). Until then a continuation stores nothing and holds a shared lock on its parent. A stored session opens as a **fork** instead of a continuation when it is opened as a copy (Restore as a Copy), when another tab holds its lock, when it is no longer the chain's head, or when the chain's file is bound by another chain (`openSession`, `src/local/startup/api.ts`); a continuation that loses the head race forks too (`Flusher.fork`). A fork is a new chain with a new `chainId` and `docId`, copied from the old record by exclusion (`forkRecord`, `src/local/chainFields.ts`), so fields a newer build added carry, without the binding, the export target and name, `edited` and `replaced`. The tab holds an exclusive Web Lock per open session (`src/local/sessions.ts`); a tab never writes a session it does not hold.

### 2.7 Save entries and revisions

A `save` entry records one Save: `operation` `nse.file.save`, `revisionId` (the `project.json` revision it wrote), `device {id, label}` and `appVersion` (the app version that wrote that Save, which an append would otherwise lose since `project.json` holds only the last writer's). Its snapshot is the head at the time.

`savedAt` is not on the entry. It is `revision.savedAt` in `project.json`: a string, `YYYY-MM-DDThh:mm:ss` with an optional fraction and `Z` or `±hh:mm` (RFC 3339 `date-time`; uppercase `T` and `Z`, a real date, seconds 00 to 59). The writer writes UTC to the second (`savedAtOf`). A reader takes anything else, a non-string included, as absent (`parseSavedAt`, `src/local/nxsp/project.ts`) and never guesses as `Date.parse` does. The entry's own `time` is milliseconds since the epoch.

A Save reserves its `save` entry's `seq` before it builds the file (`Flusher.reserveSave`), so edits made while the file is built take later numbers and wait for it. Its **identity unit** (`docId`, `revision`, `file` with `entry`, `completeFrom` and `disk`, plus the marks the write made) is committed in one transaction after the entry, so a binding is never stored without its marks (`commitIdentity`, `src/local/save/commit.ts`).

### 2.8 Cuts, `completeFrom`, kept rows and `badChunks`

- **The cut of a read.** A write reads the chain, its sessions, their entries and the saved session's stack blocks in one read-only transaction (`readCut`, `src/local/save/cut.ts`). Bodies (roots, nodes, chunks) are immutable and follow in later transactions. An entry row that does not read is left out and counted in `unreadable`, and the write refuses (`needsNewer`).
- **The binding's cut.** `file.entry` is `{sessionId, seq, startedAt, count, notKept}`: the last chain row the file holds, its session's start, the file's row count and how many of those rows' states it lacks. "Later than the cut" (`isLater`) needs only the binding, so it holds after the cut's session is deleted.
- **The stack's cut.** The file's undo stack is cut at slots whose snapshot the file does not hold: the longest run of held slots around the index (`cutStack`). The stack is renumbered by replay of the written chronology (`renumbering`); if replay cannot follow it the stack is the head only.
- **`completeFrom`.** `revision.completeFrom` names the oldest revision whose history the file holds whole. It is placed against `{revision.id} ∪ ancestors`; an unplaceable value reads as "only itself". A history write carries it forward only when the base is still whole (the carry test, below); an append copies the source's.
- **The carry test** (`carries`, `src/local/save/model.ts`). A write that is not an append carries its base's `completeFrom` only when the chain's rows up to the binding's cut still number `entry.count`, and the flagged rows among them whose state no unflagged row shares still number `entry.notKept`. Both sets only grow, so equal counts mean equal sets. When it fails the Save says "Some earlier steps were not kept" (`someStepsNotKept`).
- **`kept: false`.** An entry whose state is not held whole. Causes: the state was removed to save space; a Save found a missing or failing part in storage and marked the row (`markDamaged`, `src/local/save/mark.ts`); an open's import could not bring the state (`writeAbandon`, `writeUnlink`); or the file itself lacked it. The mark is one-way. The row stays in the Timeline, and peek says "removed" or "damaged". A flagged row's state is still written to a file when storage holds it whole.
- **`badChunks`.** The chain's packed hashes of parts found bad, for History's "damaged" label. Display only; it never shrinks.
- **Kept bytes** are a different thing: the bytes of a file a partial or unlinked open kept so a save picker can restore it (`src/local/open/kept.ts`, OPFS folder `nse-kept`).

### 2.9 The journal and recovery

The journal is the last-chance copy of an open session whose entries are not yet committed strictly (`src/local/journal/`).

- **Where.** One `localStorage` key per session, `<prefix>journal.<sessionId>`, overwritten on each write and verified by reading it back. A key is at most 1 MiB (`JOURNAL_KEY_LIMIT`); all `journal.*` keys, the legacy recovery slot and the old auto save together at most 4 MiB. A write that would pass a limit is not made. A page never replaces a key whose text it neither wrote nor loaded.
- **When.** Synchronously on hide, pagehide, beforeunload and freeze, whenever the open session has entries not committed strictly; every 10 s while storage is unavailable (`IDLE_JOURNAL_MS`). A second trigger for the same `seq` writes nothing. A key is cleared only once a strict flush covering its `seq` commits.
- **Contents** (`Journal`, `src/local/journal/format.ts`, `JOURNAL_VERSION` 2): `journalVersion`, `kind: 'journal'`, `recordsV`, `appVersion`, `writtenAt`, `sessionId`, `seq`; a `descriptor` (the session's `v`, `origin`, `parent`, `startedAt`, the flags and the chain record as last written, without handles, hashes as hex); the whole state as `levelDataGz` (level data gzipped at level 1, base64) plus `editorMetadata` and `header {levelInfo, bgm?, ids}` for what level data cannot carry; and `stack {keep, lastKept?, head, context, index}`: how the state sits in the committed stack (slots `0 … keep-1` stay), with a `RecoveryContext` of the dropped steps' descriptions.
- **Reading.** A newer journal (`journalVersion` or `recordsV` above this build's, a newer descriptor `v`, an unknown `kind`) is left in place for a later build. An older or malformed one is not read: its bytes go to the `recovered` store, so nothing is lost.
- **Replay** (every load, before any session opens, in the order canary, journals, legacy migration; `src/local/startup/recovery.ts`). One strict transaction under the session lock checks the session and either **applies** the journal to it or makes a **recovery session**. Apply writes one `recovered` entry whose `stack {keep, push, index}` keeps the committed slots below `keep` and pushes the journalled state; the step it pushes is an `edit` of `nse.recovery` carrying the `recoveryContext`. A journal a flush already covered (`lastSeq >= seq`) is deleted without an entry.
- **Recovery session.** The journal cannot be applied when its session was removed or continued, its chain is missing or marked for Delete, its stored stack does not match, a kept block is missing, or the session is of an older generation. Then it is kept as a separate session in a **new chain** (copied from the descriptor as a fork is, no binding), origin `journal`, with one `recovered` entry whose stack is that one slot. It is never dropped before it is stored. A chain or session of a newer generation is left in place instead.
- **Journal-only reload.** When storage is unavailable the page rebuilds a session from the journal with a `recovered` baseline entry whose stack is `{keep: 0, push: [the current state], index: 0}` (`Flusher`, `flushWrite.ts` `prepareFlush` checks the shape).
- **`RecoveryContext`** (`src/history/operations/steps.ts`): `{head, headIndex, dropped[], omitted, x?}`: descriptions of steps that could not be kept, so the Timeline can still say what was lost. At most 64 items (`RECOVERY_CONTEXT_ITEMS`) and 128 KiB (`RECOVERY_CONTEXT_BYTES`) of `dropped`; the oldest go first and `omitted` counts them.

### 2.10 Time

`now = max(Date.now(), meta.maxSeenTime + 1)`, and every write moves `maxSeenTime`, so two writes never share a time across tabs or with the clock held back (`src/local/time.ts`). A time from outside the write (a journal, a file, a parent row) more than a day ahead is clamped to now. Imported rows keep their times. `meta.daysOfUse` goes up once per calendar day of use; rows carry `day`, and "within N days" means `daysOfUse - day < N`, so a clock that jumps expires nothing early (`src/local/days.ts`).

## 3. The `.nxsp` file

A `.nxsp` is a plain ZIP. `level.json` is the chart as it is now; the history is optional extra. The byte-level container rules (headers, CRC, timestamps, ZIP64, names) are in `src/zip/writer.ts`, `src/zip/reader.ts`, `src/zip/directory.ts` and `src/local/nxsp/execute.ts`; this section covers what a History reader or writer needs. Which number guards what, and what an older reader does with a newer file, is in format-versioning sections 2 to 4.

### 3.1 Entries, order and methods

The writer's order (the checker enforces it; readers do not depend on it):

| Entry | Method | Named by | Holds |
| --- | --- | --- | --- |
| `project.json` | 8 (DEFLATE) | fixed | Identity, `revision`, level info, pointers, `summary`. |
| `level.json` | 8 | `level` (must be `"level.json"`) | The chart as Sonolus level data `{bgmOffset, entities}`. |
| `history/segments/<n>.json` | 8 when new; the source entry's method when copied whole | `history.segments[n-1]` | Older parts of the chronology. |
| `history/manifest.json` | 8 | `history.manifest` | The newest part, plus the undo stack. |
| `history/chunks.bin` | 0 (STORE) | `history.chunks` | Every chunk's raw-DEFLATE stored form, concatenated. |
| `assets/cover.<ext>`, `assets/preview.<ext>`, `bgm/<name>` | 0 | `metadata.cover.file`, `metadata.preview.file`, `bgm.file` | The head's media, when held. |

Every entry other than `project.json` must be named by exactly one pointer in `project.json`, and each pointer must live in its own prefix; otherwise the entry is `unknown-entry` or the file is damaged. JSON text is compact `JSON.stringify`, UTF-8, no BOM. A reader strips one leading BOM.

### 3.2 `project.json` fields that History uses

Keys, in the writer's order (`PROJECT_KEYS`, `src/local/nxsp/project.ts`): `format version minor patch levelVersion appVersion id lineageId revision name exportName level editor bgm history summary metadata parts`. Unknown top-level keys follow as `extra`.

| Key | Rule |
| --- | --- |
| `format`, `version`, `minor`, `patch`, `levelVersion` | See format-versioning. `minor` is 1 when a manifest is written, else 0; `patch` is 0. |
| `appVersion` | The app version of the last writer. Per-Save versions are on the `save` entries. |
| `id` | The document id (`docId`). `lineageId`: provenance; copied on forks and Save As. |
| `revision` | `{id, parent, n, savedAt, device {id, label}, ancestors, replaces?, fileName?, completeFrom?}`. `id` is new per write; `parent` the revision this descends from or `null`; `n` is display only; `ancestors` newest first, at most 1,024 (`ANCESTOR_LIMIT`), read as a set; `replaces` only by Replace. `savedAt`: section 2.7. Unknown keys inside are ignored. |
| `revision.completeFrom` | History writes only; a non-string reads as absent. The writer keeps the carried value if it is the new id or in `ancestors`; otherwise it writes the oldest ancestor, or the new id when there are none (`build.ts`). The reader places it against `{id} ∪ ancestors`; an unplaceable value reads as the file's own id (`placedCompleteFrom`). |
| `history` | `{manifest, chunks, entries, segments?}`, present exactly when the file has history. `entries` is the total over all parts; a mismatch is damage of the history. At most 4,096 segments (`SEGMENT_CAP`). An extra key (the retired `media` included) is `unknown-key`. |
| `summary` | `{noteCount, durationMs, revisionId}` derived from the head; used only when `revisionId == revision.id`, otherwise silently ignored. |
| `parts` | Never written. Any key inside is `unknown-key`. |

### 3.3 `manifest.json` and segments

```
manifest: { version: 2, entries, roots, nodes, chunks, undoStack }
segment:  { entries, roots, nodes, chunks }
```

(Writer order. An optional `x` is allowed on both.) The file's history is the concatenation of the parts: `entries` = segments in `history.segments` order, then the manifest; `roots`, `nodes` and `chunks` are the union. A key in two parts must have equal values; a hash may be listed in `chunks` once.

| Member | Form |
| --- | --- |
| `entries` | `EntryForm[]`, oldest first (below). |
| `roots` | `{hash32: root record}` first referenced by this part, in first-reference order; the manifest also holds the undo stack's roots and any other kept roots, sorted ascending by hex. |
| `nodes` | `{hash32: node record}`. |
| `chunks` | `[[hash32, offset, length], ...]`: where each chunk's stored form is in `chunks.bin`. All parts' indexes must tile `chunks.bin` exactly: first offset 0, each offset the previous end, last end the file size. |
| `undoStack` | `{base, slots: [{snapshot, step}], index}`: the head session's stack at write time. `base` is the absolute number of `slots[0]`; `index` is absolute with `base <= index < base + slots.length`; the head state is `slots[index - base].snapshot`. |

**Entry form.** Allowed keys (`ENTRY_KEYS`): `kind time operation recoveryContext step snapshot noteCount dirty kept revisionId device appVersion stack x`. The writer emits the description first (`kind` then `step`, or `kind` then `operation`, and `recoveryContext` for `recovered`), then `time snapshot noteCount dirty? kept? revisionId? device? appVersion? stack? x?`.

| Field | Rule |
| --- | --- |
| `kind` | One of `init continue edit undo redo restore save export recovered`. An unknown kind is newer content (`newer-history`); the entry's later fields are not checked, but unknown keys are still reported. |
| `step` | Exactly on `edit restore undo redo`; `edit` and `restore` must match `step.kind`; `undo` and `redo` may not cross an `init` step. |
| `operation` | Exactly on `init continue save export recovered`. |
| `recoveryContext` | Exactly on `recovered`; `{head, headIndex, dropped[], omitted}`. |
| `time` | A safe integer at least 0 (ms since the epoch); anything else is damage. |
| `snapshot` | 32 hex characters, always, even when the file lacks the root. |
| `noteCount` | A non-negative integer; replaced by the root's count on import when the root is held. |
| `dirty` | `true`, only when set. |
| `kept` | `false`, only for a row whose state is not held whole. Every other row's root must be in `roots`. A `kept: false` row may still have its root in the file. |
| `revisionId`, `device {id, label}` | `save` entries: required. |
| `appVersion` | `save` entries: always written, optional on read (a non-string is damage). |
| `stack {keep, push: [{snapshot, step}], index}` | `recovered` entries: required. Same absolute numbering as `undoStack`. |
| `x` | Ignorable object within 256 KiB; see format-versioning section 3. |

A field that belongs to another kind (`revisionId`, `device` or `appVersion` on a non-`save` entry, `stack` on a non-`recovered` one) is reported as `unknown-key` (partial open, history not read), not as damage. The Python checker's strict mode refuses the file; its `--read` mode agrees with the TypeScript reader.

Not in a file: `seq` (rows are numbered by position), `day`, renames, session ids. Session boundaries are `continue` entries.

### 3.4 `chunks.bin`, roots and nodes

`chunks.bin` is the stored form of every chunk, concatenated with no framing. The writer puts the source's `chunks.bin` first unchanged on an append (one whole-entry copy, checked by CRC), then new chunks in first-reference order: entries in order (the `snapshot`, then a `recovered` entry's pushes), then the undo slots, then remaining roots; for each root its header chunk, then its kinds in order. The order affects only offsets, never a hash.

Root, node and record forms are section 2.1; the record field lists are `tools/fields-v1.json`. A file's roots and nodes are checked at open: each hashes to its key from its canonical bytes, has a valid form and a known `v`, and every reference resolves. The header chunk of every root and the head state's chunks are checked at open; every other chunk is inflated and hashed lazily during the background import, and a chunk failing then makes that snapshot damaged (and, from the chain's own file with an unchanged fingerprint, unlinks the session).

### 3.5 What a save appends and what it rewrites

Plan: `planSave` (`src/local/save/build.ts`) decides the content; `planNxsp` (`src/local/nxsp/build.ts`) lays it out.

| Write | Source | History in the file |
| --- | --- | --- |
| `append` | A write-back to the chain's own file at its base | The old file's segments are copied whole in order; `chunks.bin` begins with the old one unchanged; the old manifest is promoted to a new segment when it already holds 500 or more entries, otherwise its entries, roots, nodes and chunks are carried into the new manifest; the new rows (after the binding's cut) and the new `save` entry are appended to the manifest, never split; `revision.completeFrom` is the source's. `assertAppend` checks independently that the plan is an append. |
| `copy`, `replace`, `new` | Anything else | The chain's chronology is rebuilt from storage: sessions in chain order, each by `seq`, plus the tab's unflushed rows. No source parts are reused. With no append source the chronology is cut into segments of 500 entries (`SEGMENT_ENTRIES`) while more than 500 remain, and the manifest holds the remaining 1 to 500 entries, always including this write's own `save` entry. |

In every write: the file ends with this revision's `save` entry (same `revisionId` and `device`); the undo stack is the saved session's, cut and renumbered (section 2.8); rows whose state is not held whole are written `kept: false` (never filtered out), and states storage still holds whole are written even for flagged rows; `project.json`, `level.json` and the media are rewritten. A writer never thins history inside a file. Writer limits that are not reader checks: 5,000 undo slots, 1,024 ancestors, 500-entry segments, the record split sizes. Readers accept any count within the caps.

A `new` write (Save As, Save to File of a session) starts a new `docId` with no parent; `copy` keeps the `docId` and takes the chain's revision as parent.

### 3.6 Reading: what a reader rejects and what it tolerates

Result kinds (`readNxsp`, `src/local/nxsp/read.ts`; the line shown is chosen by `partialLine`, `src/local/open/decide.ts`):

| Result | When |
| --- | --- |
| `not-project` | A ZIP with no `project.json`, or `format != "nxsp"`. |
| `unreadable` (nothing opens) | Not a readable ZIP; more than 65,535 entries; `project.json` unreadable (over 1 MiB, CRC or inflate failure, invalid UTF-8, bad JSON, nesting over 64); `level.json` missing or unreadable (over 64 MiB, and so on). |
| `nxsp`, `open: 'full'` | The report is empty, or holds only `newer-patch`. |
| `nxsp`, `open: 'partial'` | The report is non-empty. Reasons below. |

| Reason | Meaning | Effect |
| --- | --- | --- |
| `damaged` | Duplicate names, overlapping data, a directory recovered by scan, a pointer outside its prefix or two on one entry, a cap passed (manifest, segment, `chunks.bin`, media, history total), a bad ZIP read of a history part | History not read; level opens. |
| `history-unreadable` | A history rule broken: a missing part, a dangling hash, an index that does not tile, a chunk not hashing to its name (a chunk over 16 MiB included), a root or node not hashing to its key, an invalid root or node, `index` out of range, a key with two values, an `entries` count mismatch, a bad entry schema, a resource-invalid description | History not read. |
| `newer-history` | A manifest `version` other than 2, a root `v` above `RECORDS_V`, an entry `kind` or kind name this build does not know | History not read. |
| `unknown-entry`, `unknown-key`, `invalid-key`, `newer-level`, `newer-minor` | Newer content, or a known key of the wrong form | Partial, unbound. `newer-minor` skips history. |
| `newer-patch` | Additive content | Alone, the open stays whole (bound, history read). |
| `media-unreadable` | A media entry missing, or its size or SHA-256 differs from `project.json` | The rest opens. |
| `newer-version` | A higher major | Only `level.json` is read. |

A partial open is unbound, gets a new `docId` and no `revision`, and never writes over the original file.

**Tolerates.** Unknown top-level `project.json` keys and unknown `metadata` keys (kept as `extra` and written back); unknown keys inside `revision` and `summary` (ignored); an `x` on any carrier (carried, never read); a `savedAt` that is not RFC 3339 (read as absent); any ZIP entry order; STORE or DEFLATE for any entry; data descriptors, extra fields and ZIP64 (the reader is more tolerant than the writer so that an OS re-zip opens); ignored entries (`__MACOSX/`, `cache/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`); chunks that hash to their name but are not canonical (the reader does not check canonical form or order); one leading BOM in JSON.

**Rejects.** An entry name with a BOM (`﻿` is kept in names, so `﻿bgm/a.mp3` is not `bgm/a.mp3`); the encryption flag or a method other than 0 or 8; a CRC, size or local-header mismatch; overlapping entries; a hash that is not exactly 32 lowercase hex characters; an `x` that is not an object; an `x` over 256 KiB; a step, recovery context or entry key outside the carrier (`unknown-key`); a `kept` other than `false` or a `dirty` other than `true`; an operation with a lone surrogate, a non-finite number, depth over 16 or over 256 KiB.

**Caps** (`NXSP_CAPS`, `read.ts`): `project.json` 1 MiB inflated; `level.json` 64 MiB; manifest and each segment 256 MiB; manifest plus all segments 512 MiB; `chunks.bin` 2 GiB; one chunk 16 MiB inflated; one media entry 1 GiB; JSON depth 64; entries 65,535; segments 4,096. A STORE entry needs `compressedSize == size`; a DEFLATE entry needs `compressedSize <= 2*size + 1024`.

**Open-time checks for history:** parts' schema; every root and node; every header chunk; the head state's chunks decoded and schema-checked, including `noteCount`. History is read only when the report holds no `damaged` and no `newer-minor`.

### 3.7 The Python checker and `fields-v1.json`

`tools/nxsp_check.py` shares no code with the editor and reads `tools/fields-v1.json`, which is byte-identical to `src/local/records/fields-v1.json` and is generated from `src/local/records/schema.ts` by `npm run format:gen` (`scripts/format-gen.mjs`, `src/local/records/fieldsTable.ts`). `tests/local/records/formatGen.test.ts` fails when the files differ from the schema. The checker uses, from the JSON, each record's positional fields (`name`, `type`, `optional`, `minItems`, `ref`), `kinds`, `kindOrder` and the `enums` for membership only.

```
uv run python -I tools/nxsp_check.py FILE...          # strict: what a v1 writer must have written
uv run python -I tools/nxsp_check.py --read FILE...   # second reader: one JSON line per file
uv run python -I tools/nxsp_check.py --show FILE HASH # a record, root or node with field names
```

Strict mode checks the container byte for byte, the project and revision blocks, the pointers and the entry order, then the history: every part's keys (a segment's four, the manifest's six, each with an optional `x`), every entry's schema including the carrier rules and a `save` entry's required `appVersion`, index tiling, `history.entries`, every chunk strict-inflated and re-hashed, every node and root re-hashed and arity-checked against `fields-v1.json`, kinds in order, `noteCount` against the slides, header references, closure of every root, all row snapshots, pushes and undo slots held, the undo `index` in range, and the chronology ending with this revision's `save` entry. Across files given together, `revision.completeFrom` is checked against each other file's rows. Operation payloads are opaque to it (section 6.2).

Hard-coded in the checker and to change by hand: the caps, `ENTRY_KINDS`, `ENTRY_KEYS`, `PROJECT_KEYS`, the carrier key sets, the version gates (`minor`, `patch`, `levelVersion`, manifest `version`, root `v`, node depth), the entry order and methods, the operation byte and depth limits, and the positional indices in `check_header_refs`, `duration_ms` and the root and node readers. Run it over the goldens and the plan-conformance `expected.nxsp` files after any format change.

Tests: `tests/local/nxsp/` (`read.test.ts` the reader, `build.test.ts` the builder, `roundTrip.test.ts`, `golden.test.ts` with `golden-v1/`, `checker.test.ts`, `agreement.test.ts` which runs every probe through both readers and requires them to agree, `graph.test.ts`, `project.test.ts`, `execute.test.ts`), `tests/zip/` (`zip.test.ts`, `planConformance.test.ts` with `plan-conformance-v1/`), `tests/local/records/` (`fields.test.ts`, `golden.test.ts`, `schema.test.ts`, `split.test.ts`, `canonical.test.ts`, `chunkVerify.test.ts`, `hash.test.ts`, `formatGen.test.ts`) and `tests/local/formatVersions.test.ts`. The checker and agreement tests are skipped without `uv`.

## 4. Operations

### 4.1 What an operation is

An operation is a typed description of one step, stored inside the step. It is not a command to replay.

- **Undo and Redo move along stored states.** `undoState` and `redoState` change the index; the slot already holds the state. The operation only labels the step, so nothing in `data` may be needed to rebuild a state. A cascade (an owner deleted with its objects, a displaced BPM, a default stage that appears) is applied by the action that pushed the state, and the operation records the result in counts.
- **Envelope.** Exactly four keys: `{id, version, data, fallback: {text, locale}}`. `version` is a positive integer; only `1` exists. Native ids are the keys of `operationCodecs` (`src/history/operations/registry.ts`). `createOperation` (through `createHistoryOperation`) captures `{id, data}` first, checks `data` against the id's codec (it throws before `pushState` on a mismatch), renders the title text in the current locale, and stores it, cut to 1,024 code points, as `fallback`.
- **Known** means: the four exact keys, `id` in `operationCodecs`, `version === 1`, a valid `fallback`, at most 64 KiB (`OPERATION_NATIVE_BYTES`), and `data` passing the codec. Anything else is **unsupported**, but its complete original JSON is preserved (`decodeOperation`).
- **Resource bounds** (`src/history/operations/json.ts`, `steps.ts`): plain JSON, finite numbers, no lone surrogates, no cycles, at most 256 KiB UTF-8 (`OPERATION_WIRE_BYTES`) and depth 16; a step with a recovery context at most 2 × 256 KiB + 128 KiB + 4 KiB, depth 20. Exceeding them is a resource-invalid description: damaged history in a file, never merely unsupported.
- **Rendering.** A known operation renders in the current locale. An unknown or malformed one shows `fallback.text` when valid, otherwise the coarse kind ("Initial state", "Edit", "Restore", "Continued", "Save", "Export", "Recovered changes"; `describeCapturedOperation`, `format.ts`). Step Details reads "This step was recorded by a newer version of the editor." for an unknown `nse.` id or a known id with a version above 1, and "This editor cannot read the details of this step." for anything else, including a known id whose `data` fails its codec (`unreadable`, `details.ts`).
- **Text.** Names in `data` are `NameText = {text, truncated?: true}` of at most 256 code points. Lone surrogates are replaced at every text entry point.
- **Units.** Beats are beats; lanes are lane units; `bgmOffset` is seconds (shown as milliseconds); times in `data` (`fromTime`, `targetTime`) are milliseconds since the epoch, at most 8.64e15; owner `fromIndex` and `toIndex` are 0-based (Step Details shows them 1-based, for a reorder only); counts are non-negative safe integers (a field that names a change holds a positive count, and a map of counts never holds a zero).

A **step** (`UndoableStep`) is `{kind: 'init' | 'edit' | 'restore', operation, recoveryContext?, x?}`. Its `kind` is the kind that pushed it. A step only holds these keys; any other key is newer content (`unknown-key` in a file).

### 4.2 No-op rule

An action that leaves the chart as it was pushes no step (owner, 2026-10-19). `pushState` compares the new state with the current one by `sameChart` (`src/history/sameChart.ts`): the header (Initial Life, dynamic stages, BGM file and offset and metadata, level info, groups, stages, folders) as its record text, the slides as a set of records (slide ids are not stored, and the file orders them by their records), and each event kind in the order the file lists it (same-beat order is state). The chart is compared as its stored records, so it holds however the entities were rebuilt. The selection is not part of the chart.

- Equal charts, for an `edit`: `pushState` returns `false`, the stack, the state and the dirty flag stay; a changed selection still takes effect without a step.
- Anything `sameChart` cannot decide counts as different, so a step is never dropped on a doubt.
- `restore` always pushes, even when the chart equals the current one. (`restoreEntry` itself checks `sameSnapshot` first and says "Already matches the current chart" instead of pushing; `pushState` does not compare for a restore.)
- A producer builds counts from the result, never from the request. The receipt of an edit that changed nothing has an empty `changed` map (`{subject: 'bpm', changed: {}}`): valid data that the Timeline would not group, and that never reaches the stack because the chart is equal (`tests/editor/historyProducerReceipts.test.ts`, "a step that changed nothing carries no count, never zero"). A producer may return before `createHistoryOperation` when it already knows nothing changed.
- The rule also covers the events: a file event (`save`, `export`) is not a step; `init`, `continue` and `recovered` are made by the storage side.

Guarded by `tests/editor/noOpSteps.test.ts`.

### 4.3 All operations

Thirty-six ids. "Pushed as" is the kind of entry that carries it: `edit` or `restore` (a step pushed by `pushState`), or an event kind written by the storage side. The detail sections use the family names below.

| Id | Family | Pushed as | Produced by | `data` |
| --- | --- | --- | --- | --- |
| `nse.note.add` | Notes | `edit` | Note tool, Slide tool, Elevation Editor create | `{created}` |
| `nse.note.generate` | Notes | `edit` | Generate Slide Notes tool | `{created}` |
| `nse.note.elevation` | Notes | `edit` | Elevation Editor drag that changes only elevation | `{targets}` |
| `nse.note.combine` | Notes | `edit` | Combine into Slide | `{targets}` |
| `nse.note.split` | Notes | `edit` | Split Slide | `{targets}` |
| `nse.note.vertical` | Notes | `edit` | Make Vertical | `{targets}` |
| `nse.object.add` | Objects | `edit` | BPM, Time Scale and the five event tools | `{subject, created}` |
| `nse.object.edit` | Objects | `edit` | A tool edit in place; Elevation Editor width change | `{subject, changed, displaced?, retainedInitialBpm?}` |
| `nse.object.move` | Objects | `edit` | A tool or Select drag move | same as edit |
| `nse.object.replace` | Objects | `edit` | A BPM or time scale moved onto an occupied beat | `{subject, changed, displaced, retainedInitialBpm?}` |
| `nse.object.paste` | Objects | `edit` | Paste tool, context menu paste, Elevation Editor paste | `{placed, variant, flipped, at, displaced?}` |
| `nse.object.brush` | Objects | `edit` | Brush tool | `{subject, changed, assignments, displaced?, retainedInitialBpm?}` |
| `nse.object.delete` | Objects | `edit` | Eraser, Delete command | `{removed}` |
| `nse.object.cut` | Objects | `edit` | Cut command | `{removed}` |
| `nse.object.flip` | Objects | `edit` | Flip, Flip Vertical | `{axis, subject, changed, displaced?, retainedInitialBpm?}` |
| `nse.object.scale` | Objects | `edit` | Scale Beat, Width, Elevation | `{axis, subject, changed, transform, displaced?, retainedInitialBpm?}` |
| `nse.property.set` | Objects | `edit` | Properties panel, quick edits, move to group or stage | as brush |
| `nse.header.set` | Header | `edit` | Level Properties, Offset tool, BGM dialog | `{field, before, after}` |
| `nse.bgm.change` | Header | `edit` | BGM dialog | `{file, offset?}` |
| `nse.levelInfo.set` | Header | `edit` | Nothing yet (planned Level Info Apply) | `{changes[]}` |
| `nse.dynamicStages.enable` | Header | `edit` | Enabling dynamic stages | `{created}` |
| `nse.owner.create` | Owners | `edit` | Add Group, Add Stage, New Folder | `{target, destination, gathered}` |
| `nse.owner.rename` | Owners | `edit` | Rename; Properties dialog Name | `{target, before, after}` |
| `nse.owner.set` | Owners | `edit` | Group and Stage Properties | `{target, changes[]}` |
| `nse.owner.move` | Owners | `edit` | Move, drag, Move to Folder (one) | `{target, destination, category, fromIndex?, toIndex?}` |
| `nse.owner.moveMany` | Owners | `edit` | Bulk Move to Folder | `{domain, targets, destination}` |
| `nse.owner.duplicate` | Owners | `edit` | Duplicate | `{domain, created, source?, objects?}` |
| `nse.owner.delete` | Owners | `edit` | Delete | `{domain, removed, target?, objects?, replacement?}` |
| `nse.owner.ungroup` | Owners | `edit` | Ungroup | `{target, released}` |
| `nse.origin` | Events | `init` step; `init` or `continue` entry | New, import, open, recovery | `{origin, source?}` |
| `nse.continue` | Events | `continue` entry | A continuation | `{fromTime}` |
| `nse.file.save` | Events | `save` entry | Save | `{file, delivery}` |
| `nse.file.export` | Events | `export` entry | Export | `{file, delivery}` |
| `nse.restore` | Events | `restore` step | Restore | `{targetTime}` |
| `nse.recovery` | Events | `edit` step in a `recovered` entry | Journal recovery | `{droppedSteps}` |
| `nse.externalChange` | Events | `edit` step | Opening a file changed outside | `{}` |

An id the table does not name is not native. Tests use `test.future.*` ids for unknown operations.

### 4.4 Operation details

#### Common to the chart-object ids

- **Producers** build `data` from the result of the edit (a receipt), call `createHistoryOperation`, then `pushState`, and notify the user (with the operation's title) only when `pushState` returned `true`. The codecs accept "nothing" shapes (`created: 0`, `targets: 0`, `changed: {}`, `removed: {}`) because the producer builds the operation before the stack decides it is a no-op; such a step never groups. A count inside a map is always positive, and an optional map is never stored empty.
- **Counts.** `nativeCounts` is a map over `note, bpm, timeScale, cameraEvent, stageMaskEvent, stagePivotEvent, stageStyleEvent, stageTransformEvent` (positive values, a safe sum, may be empty). `nativeCountsPlus` must be non-empty and is used for every optional map. `subject` is one native kind or `'objects'`; `subjectOfCounts` gives the one kind when `changed` has exactly one key, otherwise `'objects'`, and a codec rejects a subject that disagrees with its counts.
- **Collateral.** `displaced` (optional) counts chart objects the edit replaced or removed that were not its operands. `retainedInitialBpm: true` (optional; `false` is rejected; subject `bpm` or `objects`) says the initial BPM at beat 0 was kept or added back. Where each is allowed: `edit`, `move`, `property.set` and `brush` accept both (they need a `beat` assignment for `property.set` and `brush`); `replace` requires `displaced`; `flip` only for `axis: 'vertical'`; `scale` only for `axis: 'beats'`; `paste` has `displaced` only.
- **Step Details** shows, from stored `data` only: a "Changed" counts row when `changed` has two or more kinds (always for `flip` and `scale`), a "Replaced" counts row from `displaced`, and the fact "Kept the initial BPM change". Titles are the plural-aware strings under `tools.*`, `commands.*` and `history.operation.*`; with a zero count they use the quantity-free `history.summary.*` form.
- **Not covered by Step Details:** the "View Property Changes" modal (`src/editor/history/propertyChanges.ts`) diffs the headers of two snapshots (Initial Life, dynamic stages, BGM, cover, preview, level info, groups, stages, folders) and never shows chart-object fields. The object-level snapshot diff is the peek "change view" (`src/editor/history/changes.ts`).

#### Notes

| Id | Produced by | `data` and what it counts | Title (en) | No-op |
| --- | --- | --- | --- | --- |
| `nse.note.add` | Note tool (a new one-note slide), Slide tool (into a slide), Elevation Editor drag-create | `{created}`: notes in the entities `addNote` returned | "Added {0} note(s)"; zero "Added notes" | Stack rule only |
| `nse.note.generate` | Generate Slide Notes tool (tap, box select; also from the Elevation Editor) | `{created}`: attached notes added on grid lines not already holding one | "Generated {0} note(s)" | `if (entities.length)` gates the push; more than 100,000 lines refuses before building |
| `nse.note.elevation` | Elevation Editor drag that changes neither width nor lane | `{targets}`: notes whose fields changed | "Changed elevation of {0} note(s)" | A drop that changes no note pushes nothing |
| `nse.note.combine` | Combine into Slide | `{targets}`: every note of all slides involved, not only the selected ones | "Combined {0} notes into one slide" | Fewer than two distinct slides: "same slide" notice, no step |
| `nse.note.split` | Split Slide | `{targets}`: selected notes that are not the last of their slide (the cut points) | "Split {0} slide connection(s)" | No cut point: notice, no operation built |
| `nse.note.vertical` | Make Vertical | `{targets}`: notes whose principal fields changed (an unchanged earliest note is excluded) | "Made {0} note(s) vertical" | No selection, or unchanged: notice, no step |

- **Apply.** The action rebuilds the chart; the operation is a description. `combine` removes all notes of the selected slides and re-adds them as one slide ordered by beat (an elevation tie-break at equal beats; connector properties and separators rewritten). `split` starts a new slide after each cut note (the new endpoints detach and connector properties are redistributed). `vertical` moves every selected note to the earliest selected beat, sets elevation to beat minus the earliest beat and detaches it. None records its structural effect in `data`. `vertical` computes `displaced` and `retainedInitialBpm` but discards them.
- **Step Details:** no rows and no facts for any of the six (only the title).
- **Timeline groups:** `add` and `generate` (subject `note`, sum `created`; zero gives none), `elevation`, `combine`, `split`, `vertical` (subject `note`, no sum; a zero count gives none). Group titles are quantity-free ("Changed note elevations", "Combined notes into slides", "Split slide connections", "Made notes vertical").
- **One drag, three ids.** The Elevation Editor chooses by what changed: a width change gives `nse.object.edit`, else a lane change gives `nse.object.move`, else `nse.note.elevation`.

#### Objects: add, edit, move, replace

| Id | Produced by | `data` | Title |
| --- | --- | --- | --- |
| `nse.object.add` | BPM tool, Time Scale tool, the camera, mask, pivot, style and transform event tools | `{subject: bpm \| timeScale \| *Event, created}`; `note` and `objects` are rejected | "Added {0} BPM change(s)", "… time scale(s)", "Added {0} {kind} event(s)" |
| `nse.object.edit` | Any tool edit in place (resize drag, ease cycle, BPM or time scale with the same beat), Elevation Editor width change | `changedTargets`: `{subject, changed}` plus optional collateral; `changed` counts operands whose principal fields changed | "Edited {0} note(s)" and so on; "Edited objects" for `objects` |
| `nse.object.move` | Drag moves; Select drag; BPM or time scale whose beat changed onto an empty beat; Elevation Editor lane change | same as edit | "Moved {0} note(s)" and so on; "Moved objects" |
| `nse.object.replace` | The same producers when the destination was occupied by a BPM or time scale | `{subject: bpm \| timeScale, changed, displaced, retainedInitialBpm?}`; every displaced kind equals `subject` | "Replaced {0} BPM change(s)" |

- **Edit, move and replace share one builder** (`editInput`, `src/state/operations/historyReceipts.ts`): the intent `move` becomes `nse.object.replace` when `displaced` is present, the subject is `bpm` or `timeScale` and all displaced objects are of that kind. One gesture can give `add` or `edit` (a tap on an occupied BPM edits it), and `move` or `replace` (by destination). The sidebar's property edit of a lone BPM or time scale with a changed beat is delegated to the BPM or time scale tool and gives `move` or `replace`, not `property.set`.
- **Cascades.** *Displaced* for a time scale: every time scale of the destination group at the destination beat; for a BPM: the BPM at the destination beat; a Select move of a mixed selection records the displaced kinds per kind. *Retained initial BPM*: a single-tool move of the beat-0 BPM keeps it in place and adds a copy at the new beat; Select derives the flag from the selection (an unpinned BPM at beat 0 moved to another beat). No producer sets collateral on `edit`.
- **Step Details:** the common rows. `replace` omits "Replaced" when the displaced total equals the changed total in one kind (the title already says it).
- **No-op.** `commitDrop` commits only when `editChanges` is true for an operand; Select returns when nothing moved (`isUnmoved`); then the stack rule. An edit that changed the chart without changing a principal field is pushed with `changed: {}` and reads quantity-free ("Edited notes"); it never groups.
- **Timeline groups:** `add` (sum of `created`), `edit`, `move`, `replace` by subject, no sum. A multi-assignment `nse.property.set` has the same group key as `nse.object.edit` of the same subject, so one group can hold both ids.

#### Paste, brush, delete, cut

| Id | Produced by | `data` | Title |
| --- | --- | --- | --- |
| `nse.object.paste` | Paste tool (drag end, tap), `pasteAtPosition` for the context menu and the Elevation Editor | `{placed: nativeCountsPlus, variant: basic \| composed, flipped, at: pointer \| position, displaced?}` | "Pasted {0} object(s)" |
| `nse.object.brush` | Brush tool (tap, box select; Elevation Editor) | `propertyData` | "Brushed {0} note(s)" (single kind) or "Brushed {0} object(s)" |
| `nse.object.delete` | Eraser, Delete command, Elevation Editor | `{removed: nativeCounts}`: what left the grid | "Deleted {0} note(s)" (single kind) or "Deleted {0} object(s)" |
| `nse.object.cut` | Cut command | `{removed: nativeCounts}` | "Cut {0} note(s)" or "Cut {0} object(s)" |

- **Paste.** `placed` is the pasted objects that survive in the committed selection. `variant` is `composed` only with the composed layout and dynamic stages (never from the Elevation Editor). `flipped` is the Shift modifier. A pasted BPM or time scale first removes the occupant at the destination (`displaced`); stage events are skipped when dynamic stages are off, and the prompt before the paste may push a separate `nse.dynamicStages.enable` step. Step Details rows: "Pasted" (counts), "Replaced", "Editor Layout" (Basic or Composed), "Paste Location" (Pointer or Chosen Position), and the fact "Pasted flipped". `pasteOperation` returns `undefined` when `placed` would be empty, so nothing is pushed. The Paste command only switches tool.
- **Brush and `property.set` share `propertyData`:** `{subject, changed: nativeCountsPlus, assignments}` plus optional collateral. `assignments` is non-empty, at most one per field, strictly ascending by field id (61 fields, `fieldCodecs`); each is `{field, before, after}` where a side is `{mode: 'varying'}` or `{mode: 'uniform', value}` and the value passes the field's codec (a finite number, boolean, enum, ease, or for `groupId` and `stageId` an owner reference with a captured name). Every assigned field must apply to some changed kind and every changed kind must have an applicable assignment; collateral needs a `beat` assignment. Brush writes every key the brush holds and never touches BPM changes, so it records no collateral in practice. Step Details rows: the common ones, then one change row per assignment in stored order (the field's qualified label, `before` then `after`; a row whose two texts are equal, such as Varies to Varies, is dropped). The brush title ignores the assignments.
- **Delete and cut.** Removable kinds are notes, BPM changes (beat above 0 only), time scales and the five joint kinds; connections and connectors are not removed. Step Details: a "Removed" counts row when two or more kinds. Cut writes the clipboard first, outside History, so undo restores the chart and leaves the clipboard. Both return before building an operation when nothing is removable (the Eraser, Delete and Cut clear the selection and show a notice; Cut still copies).
- **Timeline groups:** `paste` (subject `objects`, quantity-free "Pasted objects"), `brush` by subject, `delete` and `cut` by `subjectOfCounts(removed)` with the removed counts summed (a mixed group shows a "Removed" row).

#### Flip, scale

| Id | Produced by | `data` | Title |
| --- | --- | --- | --- |
| `nse.object.flip` | Flip (`axis: 'horizontal'`), Flip Vertical (`'vertical'`) | `{axis, subject, changed, displaced?, retainedInitialBpm?}`; collateral only when vertical | "Flipped {0} object(s)" or "… vertically" |
| `nse.object.scale` | Scale Beat (`'beats'`), Scale Width, Scale Elevation, applied from the scaling session | `{axis, subject, changed, transform, displaced?, retainedInitialBpm?}`; collateral only for `beats`; `transform` is `{mode: 'uniform', factor, pivot}` or `{mode: 'composed'}` | "Scaled beats of {0} object(s)" and so on |

- **Apply.** Horizontal flip changes per-kind fields (a note's `left` and flick direction; event lanes and rotations; a style's border styles; `editorLane` negated only when the whole selection is that type). Vertical flip mirrors beats between the selection's first and last beat, reverses connector properties and eases, and re-adds the initial BPM if it moved. Scale applies the preview draft; `uniform` only when the draft came straight from the unmodified source with a scale (a typed factor or one endpoint drag), otherwise `composed`.
- **Cascades:** `displaced` and `retainedInitialBpm` are observed from the grid after the transform (a scale filters `displaced` to objects the chart held before the session).
- **Step Details:** the common rows (the "Changed" row always); scale adds "Scale Factor" and "Scale Origin" for `uniform`, or "Scale Factor: Multiple Adjustments" for `composed`.
- **No-op:** a horizontal flip with no changed operand and a vertical flip that returns the source show "no change" and push nothing; the scaling session returns before `pushState` when the result equals its source; the stack rule catches net-zero results.
- **Timeline groups:** family `flip` or `scale` with the axis, no subject, no sum.

#### Property edits

**`nse.property.set`** is produced by every edit of a field on selected objects: the Properties panel and modals (including a "mixed" value), note and slide preset quick edits, and moving the selection to a group or stage. They run through `editSelectedEditableEntities` (`src/editor/sidebars/default/index.ts`), which builds the state and the receipt with `planEdit` (`src/state/operations/properties/plan.ts`).

- *Data:* `propertyData`. `changed` counts targets with at least one applied field change, deduplicated by pre-edit entity. An assignment is recorded only for a requested field that applies to the kind and for which some target's value changed; a coupled effect (Fake also sets the connector's fake flag; Critical also sets the connector's critical flag) counts as a change but is not its own assignment. A side is `uniform` when every holder (targets already at the requested value included) shares one value, otherwise `varying`. Group and stage values store the owner's id with a name captured at up to 256 code points. Ease edits store effective results.
- *Apply:* edits in stored order; re-adds the initial BPM at beat 0 if a beat edit removed it (`retainedInitialBpm`); keeps an attached tick's gameplay place when a beat edit takes it past its slide's end.
- *Step Details:* title "Set {field} to {value} on {0} note(s)" for one assignment with a uniform after side; "Changed {field} on {0} note(s)" when it varies; "Edited {0} note(s)" for several assignments. Rows as for brush.
- *No-op:* an out-of-range beat is refused; an empty `changed` shows "no change" and pushes nothing; the stack rule covers the rest. A missing receipt throws ("Unexpected missing property receipt").
- *Timeline groups:* one assignment: family `property` by subject and field ("Set Lane to 2 on notes"; the group keeps the first `before` and the shared `after`, or reads "Changed Lane on notes" when the values differ); several: family `edit` with the subject, shared with `nse.object.edit`.

Tests for this section: `tests/editor/historyProducerReceipts.test.ts`, `historyReceiptProperties.test.ts`, `historySelectionReceipts.test.ts`, `historyCodecTable.test.ts`, `historyOperationDetails.test.ts`, `historyOperationPresentation.test.ts`, `historyOperations.test.ts`, `noOpSteps.test.ts`; browser `historyNativeProducers.spec.ts`, `historySelectionProducers.spec.ts`, `historyDetails.spec.ts`, `historyChanges.spec.ts`, `historyRecords.spec.ts`, `elevationNotices.spec.ts`, `scaleSelection.spec.ts`.

#### Header, BGM, level info and dynamic stages

Step Details for all of these is built from the stored `data` only. The separate "View Property Changes" modal (`src/editor/history/propertyChanges.ts`, `historyChanges.*` strings) diffs the header records of two snapshots; it is not part of Step Details.

**`nse.header.set`** (grouping family `header`, key by `field`)

- *Produced by:* the Level Properties dialog (`properties` command, `src/editor/commands/properties/index.ts`) for Initial Life; the Offset tool drop (`src/editor/tools/offset/index.ts`); the BGM dialog (`src/editor/commands/bgm/index.ts`) when only the offset changed, because the buffer and file name are the same (`bgmInput`, `src/editor/headerLabelText.ts`); and Level Info Apply when only Initial Life changed (no caller yet).
- *Data:* `{field: 'initialLife' | 'bgmOffset', before: finite, after: finite}`. `bgmOffset` is seconds. The codec does not require `before !== after`; no producer emits an equal pair.
- *Apply:* sets `state.initialLife` or `state.bgm.offset`. No cascade.
- *Step Details:* title "Set Initial Life to {0}" or "Set BGM Offset to {0} ms" (offsets shown in ms by an exact decimal shift). One change row: key `life` ("Initial Life") or `offset` ("Offset (ms)"); dropped when the two texts are equal.
- *No-op:* the command returns before `pushState` when the value is unchanged or the dialog was cancelled (`properties/index.ts`, `bgm/index.ts`, `offset/index.ts`); `sameChart` is the backstop.
- *Timeline:* consecutive steps on the same field collapse ("Changed Initial Life", "Changed BGM Offset"); group Details show one net row.

**`nse.bgm.change`** (no group)

- *Produced by:* the BGM dialog and `changeBgm` (also reached by Open of an audio file and the "Choose Audio…" notice actions). One action gives `nse.bgm.change` when the buffer or file name changed, else `nse.header.set`.
- *Data:* `{file: {before: NameText | null, after: NameText | null}, offset?: {before, after}}`. `offset` (seconds) only when it changed. The name is the file name without its extension.
- *Apply:* replaces `state.bgm` (file name, decoded buffer, waveform, source bytes, metadata, offset).
- *Step Details:* title "Changed BGM" (with `offset`) or "Changed BGM file". Rows: `file` ("File") as a change row, or a value row with the one name when both are equal; `offset` ("Offset (ms)") when stored. A missing name reads "Not set".
- *No-op:* the command returns when buffer, offset and file name are all identical. Re-picking the same bytes is not a no-op: `sameChart` compares the buffer by identity first and every pick decodes a new buffer, so the step has equal before and after names.

**`nse.levelInfo.set`** (no group)

- *Produced by:* nothing yet. `levelInfoInput` (`src/editor/headerLabelText.ts`) builds it for the planned Level Info Apply (one Apply is one step); only tests call it. The status label opens the Level Properties dialog, which edits Initial Life only, so today the reachable result is `nse.header.set`.
- *Data:* `{changes: LevelInfoChange[]}`: 1 to 9 changes, each field at most once, in the dialog's field order `title artists author rating tags description cover preview initialLife`, each a real change. Shapes: `title`/`artists`/`author`/`description` `{before, after: NameText}` (unset is the empty name); `rating` `{before, after: finite | null}`; `tags` `{added, removed: count, changed?: positive, reordered?: true}` (counts by title; the tags themselves are in the snapshots); `cover`/`preview` `{before, after: NameText | null}` (the same content under another file name is a change); `initialLife` `{before, after}`. A name pair is unchanged only when the texts are equal and neither is cut. A lone `initialLife` change is rejected: it is `nse.header.set`.
- *Step Details:* title "Changed level info". Change rows per field (labels from `historyChanges.fields.*`, "Preview Audio" for preview; "Not set" for empty); tags as value rows "Tags Added", "Tags Removed", "Tags Changed" and "Tags: Changed" for a reorder; Initial Life key `initialLife` (note `life` under `nse.header.set`).
- *No-op:* `levelInfoInput` returns `undefined` when no field changed.

**`nse.dynamicStages.enable`** (no group)

- *Produced by:* `requestDynamicStages` (`src/history/dynamicStages.ts`), reached through `checkDynamicStages` from the event tools' commands, the Stage commands, the "Enable Dynamic Stages" button of the Stages panel and paste of event joints. A confirm dialog comes first; declining pushes nothing.
- *Data:* `{created: nativeCounts}` (each count positive). In practice `{stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1}`.
- *Apply:* adds one default joint at beat 0 for mask, pivot and style on the default stage, and sets `isDynamicStages`. Undo returns to the stored static state.
- *Step Details:* title "Enabled dynamic stages"; one counts row "Added" with the three events; dropped when `created` is `{}`.
- *No-op:* already enabled returns without a step. The events always change the chart.

#### Groups, stages and folders ("owners")

A group, stage or folder is an owner (`OwnerReference {kind: group | stage | groupFolder | stageFolder, id, name: NameText}`). The producers are in `src/editor/workspace/manager/` (`groups.ts`, `stages.ts`, `folders.ts`) and the Group and Stage Properties dialogs. Step Details is built from stored `data`. Indexes in `data` are 0-based; a reorder shows them 1-based.

| Id | Produced by | Data |
| --- | --- | --- |
| `nse.owner.create` | Add Group, Add Stage, an entry's add action in a folder, New Folder, "New Folder…" with held entries | `{target, destination: folder \| null, gathered: count}`; `gathered` only for a folder target, `destination` only for a group or stage in a folder of its domain |
| `nse.owner.rename` | Inline rename of a group, stage or folder; the Name field of the Group and Stage Properties dialogs | `{target, before, after: NameText}` (`target.name` is the old name) |
| `nse.owner.set` | Group Properties (Force Note Speed); Stage Properties (From Start, Until End, Generate Sim Lines) | `{target, changes[1..3]}`, strictly increasing by field name; a group may carry only `forceNoteSpeed`, a stage anything else; each change `{field, before, after}` (`forceNoteSpeed` finite or `null`; booleans; `generateSimLines` `global` or `isolated`) |
| `nse.owner.move` | Move Up and Down, drag, "Move to Folder…" and "No Folder" on one entry; Move and drag of a folder | `{target, destination: folder \| null, category: reorder \| intoFolder \| outOfFolder, fromIndex?, toIndex?}`; producers always write both indexes (positions in tree order; for a folder, among top-level items) |
| `nse.owner.moveMany` | Bulk "Move to Folder…" or "No Folder" | `{domain, targets: count, destination: folder \| null}`; `targets` counts selected entries whose folder changed |
| `nse.owner.duplicate` | Duplicate on an entry or a folder; bulk Duplicate Selected | `{domain, created: ownerCountsPlus, source?: owner, objects?: nativeCountsPlus}`; `source` only for exactly one copied entry or folder |
| `nse.owner.delete` | Delete Group, Delete Stage, Delete Folder and Groups (with a confirm when it has members), bulk Delete Selected | `{domain, removed: ownerCountsPlus, target?, objects?, replacement?: owner}`; `target` when exactly one entry, or one folder with all and only its members; `replacement` is the default entry created when the last one went |
| `nse.owner.ungroup` | Ungroup on a folder row | `{target: folder, released: count}`; `released` is the member count (0 allowed) |

- **Codec rules** (`registry.ts`): a destination is a folder of the target's domain; a folder target moves only as `reorder` with no destination; `intoFolder` needs a destination and `outOfFolder` none; `created` and `removed` hold only the domain's entry and folder kinds; `objects` are limited to what the domain owns (a group: `note`, `timeScale`; a stage: `note` and the four stage events, never camera events); `replacement` is a group or stage of the domain.
- **Apply and cascades.** The owner action applies the change; undo and redo move along stored states. Creating a group, stage or folder adds it (a numbered name when needed). Renaming sets the name. Setting changes the group or stage object. A move changes tree order or folder membership and rebuilds the maps in tree order with folder `index` recomputed; no chart object changes. Duplicate copies the entries and the objects they own (a group's time scales and notes with that `groupId`, a stage's event chains and notes with that `stageId`); copies of single entries are named by `copyName`. Delete removes every note and time scale of a deleted group (whatever the note's stage), and a deleted stage's event joints and notes (camera events are never touched); if the last group or stage goes, a default one is created and recorded in `replacement`. Ungroup removes the folder and leaves its members loose.
- **Step Details.** `create`: title per domain ("Added "X" group", "Added group folder "X"", or "Created folder "X" with 3 groups"), one value row "Folder" when `destination` is set. `rename`: title only ("Renamed "A" group to "B""). `set`: title ("Set Force Note Speed of "A" group to 1.5", "Cleared …" when `after` is `null`) and one change row per field; rows whose two texts are equal are dropped. `move`: title ("Moved "A" group", "Moved group "A" into folder "F"", "Moved group "A" out of its folder") and an "Order" change row (1-based) only for a `reorder` with both indexes that differ. `moveMany`: title ("Moved 5 groups into folder "F"") and no rows. `duplicate`: title ("Duplicated "A" group", or counts) and an "Added" counts row of `created` then `objects`, shown when `objects` exists or the title does not name what was created. `delete`: title and a "Removed" counts row likewise, plus a fact "Added …" for a replacement. `ungroup`: title ("Ungrouped "F" folder") and a "Moved out of Folder" counts row when above zero.
- **No-op.** The manager producers return before `commit` when the owner is missing, the normalised name is empty or equal, the tree helper returns `undefined` (`sameTree`, `moveEntriesInTree` for nothing to move), or nothing was copied or removed; `pushState`'s `sameChart` is the backstop. Create, ungroup and folder deletes always change the chart.
- **Timeline groups** (`operationGroup`): `create` by target kind (a `gathered` step never groups); `rename` by owner; `set` by owner and field list; `move` by target, category and destination; `duplicate` and `delete` by domain and kinds (counts sum into "Duplicated 3 groups"). `moveMany` and `ungroup` never group. Group Details show net rows: rename none; set the first `before` to the last `after`; move a net "Order" row for a reorder; duplicate and delete a summed cascade row (delete also an "Added" row for replacements).

Tests: `tests/editor/headerLabels.test.ts`, `historyLevelInfo.test.ts`, `folders.test.ts`, `folderCopies.test.ts`, `historyProducerReceipts.test.ts`, `historyCodecTable.test.ts`, `historyOperationDetails.test.ts`, `historyOperationPresentation.test.ts`, `noOpSteps.test.ts`; browser `history.spec.ts`, `historyManagerProducers.spec.ts`, `historyDetails.spec.ts`, `historyRecords.spec.ts`, `toolsAudit.spec.ts`.

#### Session and file events

These ids are not made by an edit. The storage side and the file flows make them, and none of them joins a Timeline group (`operationGroup` returns `undefined`). Step Details shows the title and, where noted, one fact.

| Id | Entry or step | Data | Title (en) |
| --- | --- | --- | --- |
| `nse.origin` | The `init` entry and slot of a session (`step.kind` `init`); also the `continue` entry written when a `.nxsp` is opened | `{origin: 'new' \| 'import' \| 'autoSave' \| 'recovery', source?: NameText}`; `source` only with `import` | "Started a new level" (`history.operation.newLevel`); `import` with a source "Opened {file}" (`history.openedFile`), without one "Imported a level"; `autoSave` "Recovered from auto save" (`entry.migrated`); `recovery` "Recovered changes" (`entry.recoveredChanges`) |
| `nse.continue` | The first entry of a continuation (`continue`) | `{fromTime}` ms: the parent session's `updatedAt` (or the stored head's last entry time after a lost head race) | "Continued from {time}" |
| `nse.file.save` | A `save` entry | `{file: NameText, delivery: 'file' \| 'download'}` | "Saved {file}"; a download "Downloaded {file}" |
| `nse.file.export` | An `export` entry | `{file: NameText, delivery: 'file' \| 'download'}` | "Exported {file}". Step Details adds the fact "Downloaded {file}" for a download. |
| `nse.restore` | A `restore` step | `{targetTime}` ms: the restored entry's time | "Restored to {time}" |
| `nse.recovery` | The `edit` step of a `recovered` slot, and the `recovered` entry | `{droppedSteps: count}` | "Recovered changes". Step Details adds "Undo steps dropped: {n}" when above zero, and lists the recovery context ("Earlier Actions", "Source Action"). |
| `nse.externalChange` | An `edit` step | `{}` | "Changed outside the editor" |

- **`nse.origin`** is made by `resetState` (a blank start gives `new`; a chart brought in gives `import`), `resetImportedState` (an import with `source`), `openState` (default `recovery`; Local Data's journal opens) and the startup migration (`autoSave`, `src/local/start.ts`). A `.nxsp` open writes `nse.origin` `import` with the file's name as the `continue` entry, and as the `init` step of a file without history (`writeOpenHead`, `src/local/open/importWrite.ts`).
- **`nse.continue`** is made by `Flusher.continueSession` for a reload, a new visit, Reopen and Restore Session, and by a fork whose parent was continued elsewhere (`src/local/flush.ts`, `src/local/startup/open.ts`).
- **`nse.file.save`** is made by the Save flow (`saveOperation`, `src/editor/save/flow.ts`), reserved with `Flusher.reserveSave` and written by `endSave`, so it sits at the `seq` the Save reserved. `markSaved` (`src/history/markers.ts`) is the same entry from the stack side and has no caller in `src/`; browser specs use it. `nse.file.export` is made by `markExported` after an Export (`src/editor/commands/exportLevel/`).
- **`nse.restore`** is made by `restoreEntry` through `PeekEffects.restoredOperation` (`src/editor/peek.ts`), pushed as a `restore` step. It carries the time of the entry restored, not its key.
- **`nse.recovery`** is made by journal replay (`writeJournalApply`, `src/local/journal/apply.ts`) and the journal-only reload (`src/local/start.ts`). `droppedSteps` counts the undo steps the recovery could not keep.
- **`nse.externalChange`** is the `edit` step an open adds when a file's `level.json` differs from its history head: the chart now is not the chart the history ended on, so the difference is recorded as one edit (`writeOpenHead`; the operation is passed in by `src/editor/commands/open/project.ts`). It has no user action.

No-op rule: events are not steps, so there is nothing to skip. A `save` entry is written for every completed Save, including one that changed nothing in the chart.

### 4.5 Step Details and Timeline grouping

**Step Details** (`StepDetailsModal.vue`, model `OperationDetails` in `src/history/operationPresentation/types.ts`, built by `operationDetails` in `details.ts`):

- `description`: the title line, the same text as the Timeline row. For an unknown step it is the `fallback.text` (with its language noted when it is not the current one).
- `rows`: `counts` (one phrase per kind: notes, BPM changes, time scales, events, then owners), `change` (label, before, after) or `value` (label, value). A change row is dropped when its two texts are equal. A placeholder ("Not set", "Varies") is drawn quieter.
- `facts`: plain sentences after the rows ("Kept the initial BPM change", "Downloaded {file}", "Undo steps dropped: {n}"); the shortened-name fact ("Name shortened for display") comes last whenever any name in `data` was cut.
- `note`: why nothing more is shown for a newer or unreadable step.
- `steps`: for a group, undo or redo parent, its member steps newest first; `recovery`: the recovery context.
- Rows show only what the title does not already say (counts appear only when the title lacks them).

**Grouping.** `operationGroup` (`src/history/operations/grouping.ts`) gives each operation a `GroupDescriptor {key, family, subject?, axis?, field?, ..., metric?}`. Adjacent steps with equal keys collapse into one Timeline row "×N" (chronology, availability and pins are separate gates). A `metric` (native or owner counts) lets the group title sum ("Duplicated 3 groups"); a total that overflows safe integers falls back to the quantity-free summary strings (`history.summary.*`). Group Details show net rows: the first step's `before` to the last step's `after`. Operations with no descriptor never group.

An `undo` or `redo` entry shows the crossed step's line with an "Undo ·" or "Redo ·" prefix, and a run of them is one parent listing its steps without the repeated prefix.

### 4.6 Peek, Go To and Restore

- **Peek** (`peekEntry`, `src/history/peek.ts`) shows an entry's state in place of the live one, read-only. It starts at once over what is shown, then loads: from memory when this tab holds the state (a pending entry, or a loaded slot), otherwise from the stored snapshot, read and verified in the worker (`createPeekSource`, `src/local/peekSource.ts`). Requests closer than 100 ms wait for the last; a spinner shows after 150 ms; the cache is an 8-entry LRU. A failure leaves the peek with a `PeekError` reason: `missing`, `removed` (a `kept: false` row whose root is gone), `damaged` (a part is missing or fails its hash, or a `kept` row whose root is gone) or `newer` (a root written by a newer version, never damage). While peeking, `liveState` stays the live chart, so writers never see the peeked one; every command that edits is refused ("Read-only while viewing history").
- **Go To** (`GoToList.vue`, `GoToPopover.vue`) is the Timeline's jump list: Now, then the days, newest first, with the sessions in each; a day of one session is one row. While filtering it lists and counts saves and exports. The Timeline reads the chain's entries a page (100) at a time from storage, newest first, with the open session's entries not yet stored on top (`src/editor/history/source.ts`, `src/local/worker/timelineHandlers.ts`).
- **Restore** (`restoreEntry`) loads the entry, leaves any peek, and pushes the entry's chart, offset and level info with the current audio as a `restore` step (`nse.restore`). If the restored state already equals the current one by snapshot (`sameSnapshot`), nothing is pushed and the notice reads "Already matches the current chart". The restore is cancelled, with nothing pushed, if the stack, the source, the live state or a peek changed while it loaded.

## 5. Invariants and safety rules

Data loss is the top concern. Each rule below says what must never happen, where the code enforces it, and the tests that guard it. A change that breaks a rule needs the owner's decision first.

### 5.1 The stack and the chart

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A published state is never changed in place (a stale record under a valid hash would be stored). | `src/history/freeze.ts`; the stack freezes every state it publishes outside release builds. | `tests/local/flush/freeze.test.ts` |
| An action that leaves the chart as it was pushes no step; a doubt counts as different; Restore always pushes; a selection change never makes a step. | `pushState`, `sameChart` | `tests/editor/noOpSteps.test.ts` |
| Nothing edits while peeking: every edit path is gated, and `pushState` fails in development and tests. Writers read `liveState`, never the peeked state. | `src/history/stack.ts`, `src/history/peek.ts`, `refuseWhilePeeking` | `tests/editor/peekGate.test.ts`, `peek.test.ts`, `peekCallSites.ts`, browser `peek.spec.ts` |
| An edit or a peek cancels queued Undo and Redo moves, so a move never lands after an edit; a failed slot load cancels and a later press retries. | `cancelPendingMoves`, `settle` | `tests/local/timeline/queuedMoves.test.ts`, `tests/local/timeline/history.test.ts` |
| A restored slot is loaded verified; a missing or damaged snapshot fails the load and cancels the move. | `slotLoader`, `readStoredState` | `tests/local/timeline/history.test.ts`, `tests/local/timeline/stack.test.ts` |
| Restore is itself an undoable step and is cancelled, pushing nothing, when the stack, source, live chart or a peek changed while it loaded. | `restoreEntry` | `tests/editor/peek.test.ts`, browser `historyRestoreFailure.spec.ts`, `historyRowRestoreOwnership.spec.ts` |

### 5.2 Operations

| Rule | Enforced by | Tests |
| --- | --- | --- |
| An operation is a description: no replay, no authentication of content, no authorization of a write, never a GC root. | Undo and Redo only move the index (`step`, `stack.ts`) | `tests/local/timeline/history.test.ts`, `tests/editor/historyOperations.test.ts` |
| Operation data is captured as plain JSON within bounds (256 KiB, depth 16, finite numbers, no lone surrogates, no getters); a producer's data must pass its codec or `createOperation` throws before `pushState`. | `captureJson`, `createOperation` | `tests/editor/historyOperations.test.ts`, `tests/editor/historyCodecTable.test.ts`, `tests/local/flush/structuredGuards.test.ts` |
| An unknown id, version or field is kept whole and rendered by its `fallback`; it is never stripped by a Save, an import or retention. | `decodeOperation`, strict codecs | `tests/editor/historyOperations.test.ts`, `tests/editor/historyOperationPresentation.test.ts`, `tests/local/nxsp/read.test.ts` |
| Every id has a codec row, a receipt test and a Step Details case. | Type-level `Record<OperationId, …>` and coverage asserts | `tests/editor/historyCodecTable.test.ts`, `historyProducerReceipts.test.ts`, `historyOperationDetails.test.ts` |

### 5.3 Storing

| Rule | Enforced by | Tests |
| --- | --- | --- |
| Entries stay pending until the worker acknowledges the transaction that stored them; a failed or killed flush loses nothing; a re-sent batch stores nothing twice. | `Flusher`, `writeFlush` | `tests/local/flush/flush.test.ts`, `tests/local/flush/worker.test.ts`, `tests/local/flush/early.test.ts`, `earlyChurn.test.ts` |
| Every read comes before the first write in a flush transaction; a flush that finds something missing or its session no longer the head writes nothing. | `writeFlush`, `missingHashes` after an epoch change | `tests/local/flush/flush.test.ts` ("epoch change"), `tests/local/kv/` |
| A chunk is verified on write (deflate, strict inflate, rehash); a corrupted deflate fails the flush, puts nothing and pauses storing. A chunk row's CRC covers its key, so a value moved under another key fails. | `verifyChunk`, `putChunk`, `isChunkRowIntact` | `tests/local/records/chunkVerify.test.ts`, `putChunk.test.ts`, `rows.test.ts`, `tests/local/flush/flush.test.ts` |
| A hash is over canonical bytes, never the deflated bytes; the record schema is the single source. | `canonical.ts`, `hash.ts`, `schema.ts` | `tests/local/records/canonical.test.ts`, `hash.test.ts`, `schema.test.ts`, `fields.test.ts`, `golden.test.ts` |
| The stored stack equals the replay of its session's entries; a stack the page cannot follow is removed and rewritten whole, never left behind `lastSeq`; only the blocks touched are rewritten. | `SessionStack`, `stackViolations` | `tests/local/timeline/stack.test.ts`, `tests/local/timeline/timeline.test.ts`, `tests/local/journal/stackRemoved.test.ts`, `tests/local/fuzz/fuzz.test.ts` |
| Entry times are strictly increasing across flushes and tabs; a time from outside is clamped. | `nextTime`, `clampTime` | `tests/local/time.test.ts`, `tests/local/flush/flush.test.ts` |
| Row updates are field-level, so a field a newer build added stays. | `updated` in `flushWrite.ts` | `tests/local/flush/flush.test.ts` ("row updates are field-level") |
| One writer per session: the tab holds the session lock; a continuation moves the head by compare-and-set; the loser forks and never inherits the binding. | `src/local/sessions.ts`, `Flusher.fork` | `tests/local/flush/sessions.test.ts`, `tests/local/startup/chains.test.ts` |
| Text stored in rows and operations has no lone surrogate. | `toWellFormed` | `tests/local/flush/wellFormed.test.ts` |
| The crash sweep: after a kill at any await, no dangling `refs`, no half-deleted chain, every row reachable, stored stack equal to replay. | `src/local/testing/invariants.ts` (`storedViolations`) | `tests/local/testing/testCore.test.ts`, `tests/local/fuzz/fuzz.test.ts` |

### 5.4 Newer data

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A session of a newer `v`, an unknown entry kind or a root `v` above `RECORDS_V` is "Needs a newer version", never damage: it is never continued, restored, reduced, saved or rewritten, and a chain holding one is refused whole. An older or malformed `v` is not newer and is not read either. | `sessionReadability`, `checkReadable`, `ModelError` | `tests/local/records/unknownValues.test.ts`, `tests/local/save/versionGuards.test.ts`, `tests/local/journal/replay.test.ts` |
| Version constants and tables are pinned. | `tests/local/formatVersions.test.ts` | itself |

### 5.5 Journal and recovery

| Rule | Enforced by | Tests |
| --- | --- | --- |
| The journal is written synchronously on hide, pagehide, beforeunload and freeze; verified by reading it back; a second trigger for the same `seq` writes nothing; a key is cleared only after a strict commit covering its `seq`. | `JournalWriter` | `tests/local/journal/writer.test.ts`, `durable.test.ts`, browser `journalTiming.spec.ts`, `journalKill.spec.ts` |
| A page never replaces a key whose text it neither wrote nor loaded; a write that would pass a size limit is not made. | `storageJournalStore` | `tests/local/journal/store.test.ts`, `writer.test.ts` |
| A journal is applied once, whole or not at all (killed at every await); a covered journal is deleted without an entry; a journal that cannot be applied becomes a recovery session in a new chain before its key goes. | `writeJournalApply` | `tests/local/journal/replay.test.ts`, `tests/local/startup/guards.test.ts`, `tests/local/startup/recovery.test.ts` |
| A newer journal is left in place; an unreadable one keeps its bytes in the `recovered` store. | `readJournal`, `keepRecovered` | `tests/local/journal/replay.test.ts`, `tests/local/fuzz/fuzz.test.ts` |
| The journal's level data round-trips so the recovered state hashes as the stack around it. | `journalContent`, `withJournalIds` | `tests/local/journal/content.test.ts`, `structuredMetadata.test.ts` |

### 5.6 Save and open

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A write-back never drops a version: an append copies the source's segments and `chunks.bin` prefix unchanged and the plan is asserted to be one; a row whose state is not held is written `kept: false`, never filtered. | `planSave`, `assertAppend` | `tests/local/save/assert.test.ts`, `model.test.ts`, `history.test.ts`, `tests/local/nxsp/build.test.ts` |
| `completeFrom` is carried only when the base is still whole (counts equal); the line "Some earlier steps were not kept" shows exactly when it is not. | `carries`, `someStepsNotKept` | `tests/local/save/carry.test.ts`, `model.test.ts` |
| A binding is stored with its write's marks in one transaction, so a later reduction never carries an over-claimed base; a binding taken over meanwhile is dropped, never stored. | `commitIdentity`, `unitApplies` | `tests/local/save/carry.test.ts`, `versionGuards.test.ts`, `tests/local/flush/saveEntry.test.ts` ("an identity unit whose binding was taken over meanwhile is dropped") |
| Damage found in storage is marked one-way (`kept: false`, `badChunks` never shrinks) and the Save goes on with the line; a damaged head refuses. | `markDamaged` | `tests/local/save/model.test.ts` |
| A built file is verified against its plan before it is handed over; a flipped byte fails the post-build check. | `src/local/save/verify.ts` | `tests/local/save/model.test.ts` |
| An open stores its head at once, then imports in batches; a chunk failing its hash unlinks the chain and marks the rows; an import that cannot go on marks the rows whose states never arrived; an abandoned import never lets a later Save carry the file. | `src/local/open/` | `tests/local/open/import.test.ts`, `tests/local/open/decide.test.ts` |
| Open reads a file strictly and never writes over it when partial; two independent readers agree on every probe. | `readNxsp`, `nxsp_check.py` | `tests/local/nxsp/read.test.ts`, `agreement.test.ts`, `checker.test.ts`, `tests/local/fuzz/fuzz.test.ts` |
| The builder's bytes are stable: a plan builds the same bytes in any implementation. | `planNxsp`, `execute.ts` | `tests/local/nxsp/golden.test.ts`, `tests/zip/planConformance.test.ts` |
| Peek of a kept row says "removed" or "damaged", of a newer root "newer". | `PeekError` | `tests/editor/peek.test.ts`, `tests/local/flush/verifiedRead.test.ts`, browser `historyRestoreFailure.spec.ts`, `historyPresentation.spec.ts` |

### 5.7 What must never happen

- Silently dropping a step, a session or a chunk: a missing part is marked and shown, not filtered.
- Calling newer data damaged, or rewriting it.
- Writing a binding without its marks, or storing a file event ahead of its reserved `seq`.
- Replacing a journal key this page did not write, or clearing one before a strict commit covers it.
- Showing a notice that is not true: a queued Undo reports only when it lands; a step notice appears only when `pushState` returned `true`.
- Writing from a peeked state, or editing while peeking.
- Changing a published state in place.
- Dropping `extra` keys on a Save (`tests/local/nxsp/roundTrip.test.ts`), or trusting what they or an `x` hold.

## 6. Adding or changing an operation

Before the ship an operation changes in place at version 1. After the ship, any change to an id's `data`, even an additive field, raises that id's `version`, and a new operation takes a new id (see format-versioning section 5). Operations are descriptions: they never carry what a replay needs, never authenticate content and never authorize a write.

### 6.1 Files to touch

| What | File | Notes |
| --- | --- | --- |
| The codec | `src/history/operations/registry.ts` (`operationCodecs`) | The id, its `data` codec and any refinements. Shared pieces (`nativeCounts`, `ownerReference`, `nameText`, field ids) are in `src/history/operations/fields.ts`; combinators in `codec.ts`. The `NativeOperationInput` type follows from the table. Codecs are strict: a member the codec does not list fails it. Counts are positive safe integers and a count map never holds a zero. |
| Timeline grouping | `src/history/operations/grouping.ts` (`operationGroup`) | A case for the id: its family, its subject, and whether it sums (`metric`). An id with no case returns `undefined`: it never joins a group. |
| The title | `src/history/operationPresentation/format.ts` (`describeOperation`) | The step's one-line text in the current locale. The switch is exhaustive (`never` check). `createOperation` stores this text, in the locale it was made in and cut to 1,024 code points, as the operation's `fallback`. |
| Step Details | `src/history/operationPresentation/details.ts` (`nativeRecord`) | The rows, facts and note. Exhaustive. Rows show only what the title does not already say. |
| Summing and group titles | `src/history/operationPresentation/aggregate.ts` | Only when the id has a group family with a metric. |
| Strings | `src/i18n/{en,fr,ja,ko,tr,zhs,zht}/index.json` | Titles under `history.operation.*` (or `entry.*` for events), Details labels under `history.details.*` and `historyChanges.*`. All seven locales in the same commit; user-facing text follows `src/i18n/en/index.json` (terse, no contractions, `’` for apostrophes, Title Case buttons). |
| The producer | The tool or command that makes the edit (`src/editor/tools/**`, `src/editor/commands/**`, `src/editor/workspace/manager/*.ts`, `src/history/*.ts`), and the receipt builders (`src/state/operations/historyReceipts.ts`, `src/editor/headerLabelText.ts`) | Build `data` from what actually changed, not from what was requested. Call `createHistoryOperation(input)` then `pushState(operation, state)`. Use the return of `pushState` to tell the user only when a step was made. A new command must also be on one of the peek lists (`tests/editor/peekGate.test.ts`). |
| A file-event or session operation | `src/history/markers.ts`, `src/local/storing.ts`, `src/local/start.ts`, `src/local/flush.ts`, `src/local/open/importWrite.ts` | Event kinds (`init`, `continue`, `save`, `export`, `recovered`) are made by the storage side, not by `pushState`. |
| The entry kind (rare) | `src/history/operations/entries.ts`, `src/local/records/unknownValues.ts`, `src/local/nxsp/manifest.ts` (`ENTRY_KINDS`), `src/local/timeline.ts` (`replay`, `applyKind`), `MINOR_TABLE.entryKind` | A new entry kind is not an operation: it raises `minor` (see format-versioning section 4). |

### 6.2 Tests and fixtures

| Where | What to add |
| --- | --- |
| `tests/editor/historyCodecTable.test.ts` | A row in the table (typed `Record<OperationId, Row>`, so a missing id fails to compile): valid and invalid `data`. |
| `tests/editor/historyOperationDetails.cases.json` and `.snap.txt` | Inventory cases for the id (counts of one, many, zero, huge; a locales flag for the three-locale snapshot). Regenerate the snapshot with `UPDATE_SNAPSHOTS=1` and say so in the commit. The test renders every case in all seven locales. |
| `tests/editor/historyOperationPresentation.test.ts` | Title and Details expectations, when the id has special rules. |
| `tests/editor/historyProducerReceipts.test.ts` | A receipt test for the producer: the data it captures. The last test requires every id to have one, here or in the browser spec it names. |
| `tests/editor/noOpSteps.test.ts` | Only when the no-op rule changes. |
| `tests/browser/historyNativeProducers.spec.ts`, `historyManagerProducers.spec.ts`, `historySelectionProducers.spec.ts` | The real producer end to end. |
| `tests/editor/localizations.test.ts`, `localizationUsage.test.ts` | Run as is: every locale has every English key with the same placeholders, and every key is read. |
| Goldens | `tests/local/nxsp/golden-v1/` and the plan-conformance cases only when the id or a field of an id the golden chain holds (`nse.file.save`, `nse.continue`, `nse.origin`) changes shape: regenerate in the order in format-versioning section 4, step 3. |
| `tools/fields-v1.json` | Not for operations. It is generated from the record schema (`npm run format:gen`) and an operation is not a record. |
| `tools/nxsp_check.py` | Not for an operation. The checker treats `operation` payloads as opaque JSON bounded by `OP_BYTES`, depth 16, finite numbers and well-formed Unicode (`finite_wire_json`). It changes only with a carrier, an entry key or an entry kind. |

### 6.3 Checklist

1. Decide the id and the fields. Put only the description in `data`: counts, subjects, before and after values in the editor's units, captured names (`NameText`, at most 256 code points). Do not put anything a replay needs.
2. Add the codec; add the row to the codec table test.
3. Add the `operationGroup` case, the title in `describeOperation` and the record in `nativeRecord` (both are exhaustive, so the compiler lists what is missing).
4. Add the strings to all seven locales.
5. Write the producer so that an action that changes nothing pushes no step (section 4.2): build `data` from the result, and let `pushState` compare the chart. Return early before `createHistoryOperation` only when the producer can tell more cheaply.
6. Add the receipt test, the inventory cases and the snapshot.
7. If a golden holds the id, regenerate the goldens and run the checker over them.
8. Update this page's table (section 4.3) and `CHANGELOG.md` under Unreleased when users see the change.
9. Run `npm test`, then the History browser specs for the producer.

## 7. Open questions

Things the code does not settle, or where two sources disagree. None changes a format byte.

1. **No writer of `tombstones` or space reduction.** `tombstones` is read (startup, journal apply, the Timeline's "removed to save space" label), but no code in this tree writes a tombstone or reduces a session. The doc describes the readers only. Is cleanup planned for Stage 1?
2. **`nse.levelInfo.set` has no producer.** `levelInfoInput` is called only from tests; the Level Info dialog is a stub (`src/editor/levelInfo.ts`). The codec, presentation and strings exist. Until a dialog calls it, a Level Info change that only changes Initial Life is `nse.header.set`, and nothing else records a level-info edit in the operation.
3. **`markSaved` has no caller in `src/`.** Saves go through `saveOperation` and `Flusher.endSave` (`src/editor/save/flow.ts`); `markSaved` (`src/history/markers.ts`) is used by browser specs only. Dead export or an intended seam?
4. **Zero counts.** `docs/format-versioning.md` section 6 says counts in operations are positive safe integers. The codecs accept zero for `created`, `targets` and `droppedSteps`, and an empty `changed` or `removed` map (valid rows in `tests/editor/historyCodecTable.test.ts`); only the entries inside a map must be positive. The format-versioning wording is ahead of, or looser than, the code.
5. **Per-id `version`.** format-versioning describes a `version` per id; the code has one literal `1` on the envelope and no per-id table (`decodeOperation` requires `version === 1`). Consistent with "no bumps before Stage 1", but the first bump will need a table.
6. **Unused codec capacity.** Accepted by a codec but emitted by no producer: `displaced` and `retainedInitialBpm` on `nse.object.edit`; `displaced` on `nse.property.set`; collateral on `nse.object.brush`; 2 or 3 changes in one `nse.owner.set`; `created: {}` for `nse.dynamicStages.enable`; `targets: 0` for `nse.owner.moveMany`; `file.after: null` for `nse.bgm.change`; `nse.owner.move` without indexes; `nse.header.set` with `before === after`. They are harmless but widen what a reader must accept.
7. **`retainedInitialBpm` means two things.** Single-tool and Select moves keep the beat-0 BPM in place and add a copy at the new beat (the flag is derived from the selection or from `!entity.beat`); flip, scale and `property.set` remove it and add it back and observe the grid. The type comment in `registry.ts` describes only the second.
8. **Fixtures that do not match producers.** The details fixture for `nse.dynamicStages.enable` lists a stage transform event; the producer creates mask, pivot and style only. Some case ids in `historyOperationDetails.cases.json` still say `displaced` for data since changed.
9. **Mixed Timeline groups.** A multi-assignment `nse.property.set` and `nse.object.edit` of one subject share a group key, so one group can hold two ids. Intended?
10. **The Python checker does not check the envelope.** Strict mode bounds `operation` payloads (bytes, depth 16, finite numbers, Unicode) but does not check that they are `{id, version, data, fallback}`. Only the editor's reader decodes envelopes.
11. **`checkPart` comment.** The doc comment above `checkPart` in `src/local/nxsp/manifest.ts` says a manifest `version` "above 1" is newer; the code treats any value other than 2 as newer. The code is as documented here.
12. **No test names two no-ops:** a same-name rename pushing nothing, and an owner-property edit with an unchanged value. Both rely on the `sameChart` backstop.
13. **Fork conditions.** Section 2.6 lists the cases from `openSession` and `Flusher.fork`. The plan lists "Duplicate Tab" as a fork case; no code for it was found separately from "another tab holds the lock".
14. **Rust reader and writer.** The apps' Rust implementation is not in this repository (Step 7 is paused). Statements that "Rust agrees" could not be checked.
