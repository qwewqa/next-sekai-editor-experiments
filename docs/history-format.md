# History format

How the editor records, stores and writes History: the undo stack, the stored sessions and chains, the `.nxsp` history parts and every History operation. Read it before you change the undo stack, a stored row, a journal, a `.nxsp` history part or an operation.

- **Versions are in [format-versioning.md](format-versioning.md):** every version number, the `x`, `extra` and `patch` rules, the ruling that formats change in place at v1 until Stage 1 ships, and the bump checklist. This page does not repeat them.
- **The code is the record.** Paths are relative to the repository root (`editor/`). Where an older note disagrees with the code, the code wins.
- **Data loss is the top concern.** Section 5 lists what must never happen and the tests that guard each rule.

## 1. Overview

History has four parts:

- **The undo stack** (memory): a list of slots, one per step, and an index. Undo and Redo move the index. An edit pushes a slot after the index and drops the redo tail.
- **Sessions and chains** (IndexedDB): every change to the stack becomes an **entry** in the open **session**; the sessions of one document form a **chain**. Entries point at **snapshots**, the stored form of a chart state. The Timeline, Go To, Restore and peek read these.
- **File events**: `save` and `export` entries record that a file was written, with a Save's revision, device and app version.
- **The `.nxsp` file**: a Save can carry the chain's history as a manifest, optional segments and one `chunks.bin`. Opening the file imports it back into IndexedDB.

An **operation** (`nse.*`) is a small JSON envelope that describes a step: it says what the user did, while the snapshots say what the chart was. Undo and Redo never replay an operation; they move to the state the slot holds.

### 1.1 Map

| Layer | Key types and functions | Files |
| --- | --- | --- |
| Undo stack | `Slot`, `pushState`, `undoState`, `redoState`, `restoreStates`, `resetStates`, `markFileEvent` | `src/history/stack.ts` |
| Stack events | `HistoryAction`, `emitHistoryAction`, `onHistoryAction` (early actions replayed to the first listener) | `src/history/actions.ts` |
| Starting a chart | `resetState`, `openStoredState`, `openState`, `resetImportedState` | `src/history/index.ts`, `src/history/session.ts` |
| No-op test | `sameChart` | `src/history/sameChart.ts` |
| Peek and Restore | `peekEntry`, `restoreEntry`, `PeekSource` | `src/history/peek.ts`, `src/local/peekSource.ts`, `src/editor/peek.ts` |
| Operations | `operationCodecs`, `decodeOperation`, `createOperation`, `captureStep`, `UndoableStep`, `RecoveryContext`, `operationGroup` | `src/history/operations/` (`registry.ts`, `fields.ts`, `steps.ts`, `entries.ts`, `json.ts`, `codec.ts`, `grouping.ts`), `src/history/createHistoryOperation.ts` |
| Presentation | `describeOperation`, `operationDetails` (Step Details), group titles | `src/history/operationPresentation/`, `src/editor/history/` |
| Records and hashes | schema (single source), canonical text, snapshot extraction, split | `src/local/records/`, `src/local/hash.ts`, `src/local/chunkVerify.ts` |
| Flush | `Flusher` (page), `acknowledge`, `prepareFlush` and `writeFlush` (worker), `notifyFlusherStart` | `src/local/flush.ts`, `src/local/storing.ts`, `src/local/flushWrite.ts`, `src/local/flusherStart.ts`, `src/local/worker/` |
| Stored stack | `SessionStack`, `replay`, `storedWindow` | `src/local/timeline.ts` |
| Database | `STORES_V1`, `meta` rows, `hashKey`; row forms | `src/local/db.ts`, `src/local/records/rows.ts` |
| Storage reads | `storedRead`, `StoredRead`, `COVERED_READS` | `src/local/storedRead.ts` |
| Startup and sessions | `openSession`, `openStored`, session locks, tab record | `src/local/startup/`, `src/local/sessions.ts` |
| Journal | `buildJournal`, `readJournal`, `JournalWriter`, `writeJournalApply` | `src/local/journal/` |
| Save (storage side) | `planSave`, cuts, carry model, marks, identity commit (`commitIdentity`, `recordOwnSave`), repair at save (`repairFromSource`) | `src/local/save/` |
| Save (page side) | `pickAndWrite`, `preRead`, `keepingOwn`, `ownCompletedSave`, Export's own-file read; `waitForChainImports` (`imports.ts`) | `src/editor/save/flow.ts`, `src/editor/save/imports.ts`, `src/editor/commands/exportLevel/` |
| `.nxsp` | `planNxsp`, `readNxsp`, manifest and project forms, version tables | `src/local/nxsp/` |
| Open (import) | `writeOpenHead`, `writeBatch`, `writeUnlink`, `writeAbandon`, the import loop | `src/local/open/` |
| Independent checker | `nxsp_check.py`, `fields-v1.json` | `tools/` |

### 1.2 One edit, end to end

1. A tool or command builds the new `State` and calls `pushState(createHistoryOperation(input), state)`.
2. `pushState` compares the chart with `sameChart` and returns `false`, with no step, when nothing changed (section 4.2).
3. A pushed step emits a `HistoryAction`; `src/local/storing.ts` passes it to `Flusher.append` with the state. `startStoring` ends by calling the `onFlusherStart` listeners (`notifyFlusherStart`), each alone: one that throws is recorded and stops neither the others nor the setup.
4. About 1 s after the last change (`FLUSH_DELAY_MS`), or at once and strictly on hide or freeze, before a session switch and after a media pick, the flusher extracts the snapshot and the storage worker writes chunks, nodes, the root, the entry, the stack blocks and the session and chain rows in one transaction (`writeFlush`).
5. Until the worker acknowledges, entries stay pending and the journal in `localStorage` covers them (section 2.9). An acknowledgement removes exactly the entries its batch sent, by identity (`acknowledge`), never by count: an entry may join `pending` between others while a batch is in flight (a worker restart’s re-sends).
6. Save plans the chain's rows into a `.nxsp` (`src/local/save/build.ts`, `src/local/nxsp/build.ts`); Open writes a file's rows back (`src/local/open/importWrite.ts`).

## 2. The data model

### 2.1 Snapshots

A **snapshot** is one chart state: the chart and the header (Initial Life, dynamic stages, BGM offset, groups, stages, folders, level info, BGM metadata). The chain name, the file binding, the export name, the view and the guide colours are not in it. Equal root hashes mean equal states; unequal roots do not prove a difference.

- **Records.** JSON arrays whose positions are fields, holding only arrays, strings, finite numbers and booleans. The schema is `src/local/records/schema.ts`; `tools/fields-v1.json` is generated from it (`npm run format:gen`). A format check covers types, finiteness, enum membership and id rules, never ranges.
- **Canonical bytes.** Compact `JSON.stringify` of the array, UTF-8 (`canonical.ts`). Holes, `undefined`, `null`, objects and non-finite numbers throw.
- **Hash.** The first 16 bytes of SHA-256 over the canonical bytes (`hash16`; synchronous below 1 KiB, `crypto.subtle` above), never over deflated bytes, so a DEFLATE level never changes a hash. IndexedDB keys are 16 raw bytes (`hashKey`); files and journals use 32 lowercase hex characters.
- **Chunks.** A JSON array of records of one kind, stored as raw DEFLATE (no zlib or gzip wrapper). Reading is strict: the stream must end exactly at its last byte with the final block set (`inflateStrict`), inflate to at most 16 MiB (`CHUNK_CAP`) and hash to its name. Every `chunks` put takes a `VerifiedChunk`, which only `verifyChunk` makes.
- **Split** (`split.ts`): a record goes in the chunk of its 16-beat window; a window of more than 24 records (`PART_LIMIT`) splits at 4-beat parts, then 1-beat parts, then runs of 24. A kind other than `slides` with at most 64 records (`SMALL_KIND_LIMIT`) is one chunk. Readers do not assume a split.
- **Kind node.** `[kind, depth, [hash16...]]`. Depth 0 lists at most 16 chunks in order (`NODE_FANOUT`); depth 1 lists depth-0 nodes.
- **Root.** `[v, headerHash, [[kindName, nodeHash], ...], noteCount]`, `v = RECORDS_V`. Kinds appear only when they have records, in the order `slides, bpms, timeScales, cameraEvents, stageMaskEvents, stagePivotEvents, stageStyleEvents, stageTransformEvents`. The root hash is the snapshot id.
- **Header chunk.** `[initialLife, isDynamicStages, bgmOffset, groups, stages, groupFolders, stageFolders, levelInfo, bgm?]`. Media (BGM, cover, preview) are named by hash inside it and stored in `media`; a state whose media are not held restores with them "not loaded".

Row forms (`src/local/records/rows.ts`):

| Row | Form |
| --- | --- |
| Root (`nodes`) | `{t: 'root', v, kinds, noteCount, refs, size, day}`; `refs` are the direct children as packed 16-byte runs: header, kind nodes in `kinds` order, then media |
| Node (`nodes`) | `{t: 'node', kind, depth, refs, size, day}` |
| Chunk (`chunks`) | `{bytes, size, crc32, day}`; `crc32` covers the 16 key bytes then the stored bytes, so a value moved under another key fails (`isChunkRowIntact`) |

### 2.2 The undo stack

`src/history/stack.ts` holds `states`, a list of `Slot {isDirty, step, state?, snapshot?}`, and `index`.

- Every slot has its complete `step` (section 4.1). A slot restored from storage has a `snapshot` (root hash) and builds its `state` when Undo or Redo reaches it. The slot at the index is always loaded; other loaded restored slots are capped at 8 (`RESTORED_LRU`), never evicting the head or its two neighbours.
- `pushState(operation, state, kind = 'edit' | 'restore')` splices the slot after the index, dropping the redo tail, and emits `edit` or `restore`. While peeking it throws outside release builds and returns `false` in them.
- `undoState` and `redoState` move the index and emit `undo` or `redo` with the crossed step. A slot not yet loaded queues the move; presses coalesce, an edit or a peek cancels them, and a failed load cancels and leaves the stack alone (`MoveOutcome`).
- `markFileEvent('save' | 'export', operation)` emits an entry without touching the stack.
- `resetStates` replaces the stack with one `init` slot and emits `reset`; the storing side starts a new session whose first entry is `init` (`Flusher.begin`). `restoreStates` installs a stored stack (slots lazy, head loaded) and emits nothing; the storing side resumes or continues the session itself.
- A published state is frozen outside release builds (`src/history/freeze.ts`): the flush finds unchanged kinds and entities by identity, so a change in place would store a stale record under a valid hash.

`isDirty` means "changed since the last file event": a pushed step is dirty, a `save` entry clean.

### 2.3 IndexedDB stores

Database `nse-local-data`, `DB_VERSION` 1 (`src/local/db.ts`). Upgrades only add stores, indexes and fields: `UPGRADES[1]` creates the whole set when the database is new. A transaction that names a store the database lacks fails: no write becomes a no-op because its store is absent (`handleRows.ts`, the worker's `StorageCore`). Row updates are field-level, so a field a newer build added stays.

| Store | Key | Holds |
| --- | --- | --- |
| `chains` | `chainId`; indexes `updatedAt`, `docId` | One record per chain (section 2.6) |
| `handles` | `[chainId, role]` | File handles (`file`, `exportTarget`), kept off the chain record |
| `sessions` | `id`; indexes `updatedAt`, `chainId` | One row per session (section 2.6) |
| `entries` | `[sessionId, seq]` | One row per event (section 2.4) |
| `stackBlocks` | `[sessionId, block]` | The stored undo stack (section 2.5) |
| `nodes`, `chunks` | 16-byte hash | Root and node rows; chunk rows |
| `media` | 16-byte hash | `{blob, sha256, size, type, filename?, kind, day}` |
| `tombstones` | `id` | Marks of removed sessions |
| `recovered` | `id` | Bytes of journals that could not be read (section 2.9) |
| `userAssets` | `key`; index `type` | Not History |
| `meta` | `key` | `formatVersion`, `epoch`, `maxSeenTime`, `dbInstanceId`, `deviceId`, `daysOfUse`, `lastUseDate`, `lastGcAt`, `deletionsPending`, `migratedHashes`, `usage`, `lastPersistFailure`, `createdBy` |

**Nothing deletes History yet** (GC, Delete Sessions and tombstone writing are Step 8). `tombstones` is only read: a tombstoned session opens as deleted (`src/local/startup/stored.ts`) and journal apply treats it as removed. The Timeline's "removed to save space" label comes from `kept: false` rows, not tombstones. `meta.epoch` is meant to rise in any transaction that deletes (`bumpEpoch`, no caller yet). Each flush records the `(dbInstanceId, epoch)` at which it knew a chunk was stored, and `writeFlush` re-checks with `getKey` every reused chunk not known at the current pair.

### 2.4 Entries

Key `[sessionId, seq]`, `seq` from 1 per session (`EntryRow`, `src/local/save/cut.ts`; written by `flushWrite.ts`).

| Field | Meaning |
| --- | --- |
| `kind` | One of the nine below. An unknown kind makes the session "Needs a newer version". |
| `step` | `edit`, `restore`, `undo`, `redo`: the complete `UndoableStep` pushed or crossed. |
| `operation` | `init`, `continue`, `save`, `export`, `recovered`: the operation envelope. |
| `recoveryContext` | `recovered` only. |
| `time` | Milliseconds since the epoch. A session's own rows never go back in time (section 2.10); a session opened from a file (`nxsp`, `replaced`) keeps the file's times for the rows it copied, in any order. |
| `snapshot`, `noteCount` | Root hash of the state the entry produced or landed on; its note count. A row without a `noteCount` has an unknown one, never 0: `readEntryRow` leaves it out (`EntryRow.noteCount` is optional), the worker's `TimelineEntry.noteCount` is optional, and a Timeline delta skips a neighbour without one. Flushes always write it; an import keeps a file entry's absence when the file doesn't hold its root. |
| `dirty` | Changed since the last file event. |
| `kept` | `false` when the state is not held whole (section 2.8); flushes write `true`. |
| `revisionId`, `device {id, label}`, `appVersion` | `save` only (section 2.7). |
| `stack {keep, push[], index}` | `recovered` only (section 2.9). |
| `day` | Day-of-use stamp (section 2.10): a counter, not a calendar day. Not in files. |
| `x` | Ignorable carrier (format-versioning section 3). |

| Kind | Written by | Effect in `replay` |
| --- | --- | --- |
| `init` | `resetStates` (new chart, import), the auto-save migration (`src/local/startup/migrationWrite.ts`) | Starts the stack with one slot. First entry only. |
| `continue` | A new visit, Reopen, Restore Session, a fork, a `.nxsp` open (carrying `nse.origin`) | Keeps the inherited stack; with none, starts one slot whose step is `init`. |
| `edit`, `restore` | `pushState` | Truncate after the index, push, index + 1. |
| `undo`, `redo` | `undoState`, `redoState` | Index − 1 or + 1; the entry's snapshot must be the slot landed on. |
| `save`, `export` | A Save or download; an Export | None; the snapshot must be the current slot. |
| `recovered` | Journal apply; a journal-only reload | Replaces slots from `keep` with `push` and sets the index. |

A plain reload of the tab's own head session resumes it with no entry (`Flusher.resumeSession`).

`replay` (`src/local/timeline.ts`) is the oracle and is strict: it throws `ReplayError` on an invalid description, an `init` after the first entry, a first entry other than `init`, `continue` or `recovered` (checked only when no inherited stack is given), nothing to undo or redo, an undo, redo, save or export that does not land on its snapshot or has no stack, an invalid `recovered` stack, or an unknown kind. `EDITING_KINDS` (`edit`, `undo`, `redo`, `restore`, `recovered`) set the chain's `edited` flag.

### 2.5 The stored stack

The page replays its pending entries over the last acknowledged stack (`SessionStack`) and stores the result in blocks, rewriting only blocks whose slots changed.

- `stackBlocks` rows are `{sessionId, block, first, hashes, steps}`: `hashes` the slots' roots packed as 16-byte runs, `steps` their complete steps. `BLOCK_SLOTS = 256`; slot numbers are absolute.
- The session's `stack {base, length, index}` is the stored window: at most `STACK_CAP = 5000` slots, always including the index; normally the newest, and the redo end is cut first when the index sits below them. Blocks outside the window are deleted in the same transaction.
- **The `lastSeq` rule.** A session's rows are created by one writer at a time (the tab holding its lock, a journal replay holding it before any tab runs the session, or the transaction that creates it), only above the `lastSeq` it read, and `lastSeq` moves to the highest. So every `seq` at or below `lastSeq` is final: stored, covered by a `recovered` entry above it, or never used. The one exception is an open's import, which adds the file's rows `1 … count` below the session's own while `importPending`. Readers rely on it: a flush skips an entry at or below it as a re-send; the journal's covered check; the fork split; the Timeline and the stack rebuild. A flush that still finds an entry at or below `lastSeq` without a row stores it (one a `recovered` entry covers it skips) and reports `FlushOrderError` (`orderBreach`): no designed path reaches it.
- A stack the page cannot follow is removed rather than left behind `lastSeq`, and the next flush writes it whole; replay rebuilds a stack where none is stored (`stackRemoved`). A rebuild over parent links follows every one, however long the chain, with a visited set; a session met twice (a cycle in damaged rows) fails, and the session reads as damaged (`rebuild`, `src/local/startup/stored.ts`).
- A restored stack shorter than its history is marked by `earlierSteps`; Undo past it says so.

### 2.6 Sessions and chains

A **session** is one visit's run of entries; a **chain** is the sessions of one document, ordered by `startedAt`.

| Session field | Meaning |
| --- | --- |
| `id`, `chainId` | Identity. A session never changes chain. |
| `v` | `SESSION_V`. Newer: the session and its chain read "Needs a newer version". Any other value (0, a non-integer, absent): not read and not called newer (`sessionReadability`, `src/local/records/unknownValues.ts`). |
| `origin` | `new`, `import` (`Flusher.begin`); `nxsp`, `replaced` (`writeOpenHead`); `continued` (continuations and forks); `migrated` (`migrationWrite.ts`); `journal` (`journal/apply.ts`). An unknown value reads as ordinary for display; `ORIGIN_RULE` counts it as a file's (section 2.10). |
| `startedAt`, `updatedAt` | Milliseconds. Sessions with equal starts are ordered by `parent` links, else a write refuses (`orderSessions`). |
| `parent {id, uptoSeq}` | The session and entry a continuation continues. |
| `stack`, `lastSeq`, `entryCount`, `activeMs`, `ownBytes`, `view`, `day`, `appVersion` | Window, the `lastSeq` mark (section 2.5), counts, active time, bytes, the Timeline's view, the writer's version. |
| `importPending` | An open's background import is unfinished. A Save waits for it, and for every other import of its chain, in "Preparing…" (`waitForChainImports`, section 3.5); the build refuses (`importing`) while it is set. |

The chain record (`chains`):

- Identity: `chainId`, `head` (the head session), `docId` (`project.json` `id`), `lineageId` (provenance), `sourceName`, `name`, `renames`, `exportName`.
- File: `file {name, event, at, hash, entry, completeFrom, disk, options, confirmed}` (handle in `handles`), `revision {id, n, ancestors}`, `replaced {by, at, name}` after a takeover, `extra` (unknown `project.json` keys, written back by Save), `exportTarget` (handle in `handles`).
- Flags and display: `hasContent`, `edited`, `partialImport`, `summary {title, artists, author, rating, tags, noteCount}`, `badChunks`, `deleting`, `updatedAt`, `day`, `appVersion`.

**Continuing.** A continuation stores nothing and holds a shared lock on its parent until its first write, which moves the chain's `head` from the parent to it only if the parent is still the head (a compare-and-set in `writeFlush`). Each open session holds an exclusive Web Lock (`src/local/sessions.ts`); a tab never writes a session it does not hold.

**Forking.** `openSession` (`src/local/startup/api.ts`) opens a stored session as a fork when it is opened as a copy (Restore as a Copy), another tab holds its lock, the parent lock cannot be had, it is no longer the head, or its file is bound by another chain. A continuation that loses the head race forks too (`Flusher.fork`). A Duplicate Tab copies the tab record in `sessionStorage` (`src/local/startup/tab.ts`); `claimTab` calls it a reload when the session lock is free and a duplicate otherwise, and a duplicate forks (without Web Locks, the `nse.unloaded` marker decides). A fork is a new chain with a new `chainId` and `docId`, copied by exclusion (`forkRecord`, `src/local/chainFields.ts`) so fields a newer build added carry: it drops `file`, `exportTarget`, `exportName`, `edited` and `replaced` and the chain's own `head`, `updatedAt`, `day`, `deleting` and `appVersion`, and keeps the rest, `revision` and `extra` included.

### 2.7 Save entries and revisions

A `save` entry records one Save: `operation` `nse.file.save`, `revisionId` (the `project.json` revision written), `device {id, label}` and `appVersion` (which an append would otherwise lose, since `project.json` holds only the last writer's). Its snapshot is the head at the time. `savedAt` is not on the entry; it is `revision.savedAt` in `project.json` (format-versioning section 6; written by `savedAtOf`, read by `parseSavedAt`).

A Save reserves its entry's `seq` before building the file (`Flusher.reserveSave`), so edits made meanwhile take later numbers and wait. Its **identity unit** (`docId`, `revision`, `file` with `entry`, `completeFrom` and `disk`, and the marks the write made) is committed in one transaction with the entry, so a binding is never stored without its marks (`commitIdentity`, `src/local/save/commit.ts`). A reservation is the object `reserveSave` returned: `endSave` ends it once and says what it did (`EndSaveResult`), and does nothing for one already ended, so a stale `finally` never ends a later Save's reservation that reused the `seq` (`Flusher.release`).

The `save` entry has one writer: `endSave` adds it to `pending` at the reserved `seq`, and the flusher stores it with the identity unit. **Our own completed Save** (a file this chain wrote whose binding was not recorded, found later from the marker kept before the write; `ownCompletedSave`) writes no entry: `recordOwnSave` (`src/local/save/bind.ts`) stores the binding with its marks in one strict transaction, from the chain's head, while the record still holds the binding the Save started from and no session of the chain imports. The cut is the file's and counts the `save` row, so the next write that is not an append says "Some earlier Timeline steps may not be included." once (section 2.8). No state is lost: the row's state is the one before it.

### 2.8 Cuts, `completeFrom`, `kept` and `badChunks`

- **The read cut.** A write reads the chain, its sessions, their entries and the saved session's stack blocks in one read-only transaction (`readCut`, `src/local/save/cut.ts`). Bodies (roots, nodes, chunks) are immutable and follow in later transactions. An entry that does not read is counted in `unreadable` and the write refuses (`needsNewer`).
- **The binding's cut.** `file.entry` is `{sessionId, seq, startedAt, count, notKept}`: the last chain row the file holds, its session's start, the file's row count and how many of those rows' states it lacks. `inexact: true` when its write appended to a base whose cut was inexact, or whose cut's session is stored but lacks its own `save` entry at the cut or holds another row there. "Later than the cut" (`isLater`) needs only the binding, so it holds after the session is deleted. A Save without History stores no cut, and an open of a file without history stores count 0. One predicate, `bindingHasHistory` (`file.entry` with `count > 0`, `src/local/save/model.ts`), decides "the base had history" everywhere: the carry test (`baseHadHistory` in `build.ts`), the Replace guard (`replaceDecision`), `baseFacts`, `keptRowsNeed`, `readSaveNeeds`, the Save dialog and the own-file pick (`src/editor/save/flow.ts`).
- **The stack's cut.** The file's undo stack is the longest run of held slots around the index (`cutStack`), renumbered by replay of the written chronology (`renumbering`); if replay cannot follow it, the stack is the head only.
- **`completeFrom`.** `revision.completeFrom` names the oldest revision whose history the file holds whole. An append copies the source's. Any other history write carries the base's value only when the base binding had history and the **carry test** passes (`carryStatus`, `src/local/save/model.ts`): the cut isn't `inexact`, the chain holds the cut's own row (kind `save`, `revisionId` the chain's `revision.id`), the chain's rows up to the binding's cut still number `entry.count`, and the flagged rows among them whose state no unflagged row shares still number `entry.notKept`. Both sets only grow, so equal counts mean equal sets. When it fails, the line says "were not kept" only for steps known missing (rows of the base's file gone from the chain, or, with the own row and the count matching, more of their states lacking from the write than `notKept`), else "may not be included" (`stepsLine`). A flag alone is never known missing. The Replace guard says "holds" only when rows are gone.
- **`kept: false`.** The row's state is not held whole: a Save found a part missing or failing in storage (`markDamaged`, `src/local/save/mark.ts`), an open's import could not bring it (`writeAbandon`, `writeUnlink`), the file lacked it, or (from Step 8) space reduction removed it. The mark is one-way. The row stays in the Timeline and peek says "removed" or "damaged". A flagged row's state is still written to a file when storage holds it whole. A peek or Restore that finds a row's root gone marks the row removed in the Timeline for this tab (`removedEntries`, `src/editor/history/selection.ts`), as a failed one marks it damaged or newer.
- **`badChunks`.** The chain's packed hashes of parts found bad, for the "damaged" label. Display only; it never shrinks.
- **Kept bytes** are different: a file's bytes kept by a partial or unlinked open so a save picker can restore it (`src/local/open/kept.ts`, OPFS folder `nse-kept`).
- **Repair at save.** Damage a build found (`badChunks`) is put right from the chain's own file when an append is built, after the build is checked (`repairFromSource`, `src/local/save/repair.ts`, called by `buildSave`). Every repair is content-addressed and verified against its key, so it can only repair, and only a row that is missing or fails its own check is replaced: a chunk must inflate strictly and hash to its key (`verifyChunk`, `putChunk`); a root or kind node's JSON form must pass its schema and hash to its key; a media item's bytes must hash to its whole `sha256` (only from a STORE entry of at most 64 MiB, `REPAIR_MEDIA_CAP`). It runs bottom-up: chunks, then depth-0 nodes, depth-1 nodes and roots, each stored only once everything it reaches is whole in storage (`closureBad`), so a state that is not whole never appears; a root's media come from its header chunk as storage holds it. Each kind is tried alone, and a failure is only logged. A repair never clears a mark, and what is stored again is what the next dialog no longer counts as short.

### 2.9 The journal and recovery

The journal is the last-chance copy of an open session whose entries are not yet committed strictly (`src/local/journal/`).

- **Where.** One `localStorage` key per session, `<prefix>journal.<sessionId>`, overwritten on each write and verified by reading back. A key holds at most 1 MiB (`JOURNAL_KEY_LIMIT`) and all `journal.*` keys, the legacy recovery slot and the old auto save at most 4 MiB, counted in characters. A write that does not fit trims the optional recovery context, and removes the legacy recovery slot only when that makes room; otherwise it is not made (`writeWhole`, `store.ts`). A page never replaces a key whose text it neither wrote nor loaded.
- **When.** Synchronously on hide, pagehide, beforeunload and freeze while the session has entries not committed strictly, and every 10 s while storage is unavailable (`IDLE_JOURNAL_MS`). A second trigger for the same `seq` writes nothing. A key is cleared only once a strict flush covering its `seq` commits; where IndexedDB has no `durability`, nothing clears it and the next load deletes it as covered, after the strict commit of the replay transaction (below). A journal's `seq` is the newest entry the session holds (`FlushSession.entrySeq`, read by `Flusher.newestSeq`), never a reserved or skipped `seq`, so a page resumed past a marker writes none until it has an entry.
- **Contents** (`Journal`, `format.ts`, `JOURNAL_VERSION`): `journalVersion`, `kind: 'journal'`, `recordsV`, `appVersion`, `writtenAt`, `sessionId`, `seq`; a `descriptor` (the session's `v`, `origin`, `parent`, `startedAt`, flags and the chain record as last written, without handles, hashes as hex); the state as `levelDataGz` (level data, gzip level 1, base64) plus `editorMetadata` and `header {levelInfo, bgm?, ids}` for what level data cannot carry; and `stack {keep, lastKept?, head, context, index}`: slots `0 … keep-1` of the committed stack stay, and `context` is a `RecoveryContext` of the dropped steps.
- **Reading.** A newer journal (`journalVersion` or `recordsV` above this build's, a newer descriptor `v`, an unknown `kind`) is left for a later build. A malformed one (a `journalVersion` or descriptor `v` that is 0, not an integer or absent) goes to the `recovered` store, so nothing is lost.
- **Replay** (every load, before any session opens: canary, journals, then the legacy migration; `src/local/startup/recovery.ts`). One strict transaction under the session lock either **applies** the journal or makes a **recovery session**. Apply writes one `recovered` entry whose `stack` keeps slots below `keep` and pushes the journalled state as an `edit` step of `nse.recovery` with the context. A journal a flush already covered (`lastSeq >= seq`) is deleted without an entry, but only after a strict commit: the covering flush may have been relaxed, so the transaction writes a `meta.maxSeenTime` row that makes it durable before the key goes (`journal/apply.ts`).
- **Recovery session.** When the session was removed or continued, the chain is missing or being deleted, the stored stack does not match, a kept block is missing, or the session has a malformed `v`, the journal becomes a session in a **new chain** (copied from the descriptor as a fork is), origin `journal`, with one `recovered` entry whose stack is one slot. It is stored before the key goes. A chain or session of a newer generation is left in place instead.
- **Journal-only reload.** When storage is unavailable, a reload rebuilds the session from its own journal (`resumeFromJournal`, `src/local/startup/open.ts`) and the flusher queues a `recovered` baseline entry with stack `{keep: 0, push: [the state], index: 0}` (`Flusher.resumeJournalled`; `prepareFlush` checks the shape). It numbers that entry past the journal's `seq` and past a Save's marker, so it never takes the `seq` the Save's file holds.
- **Taken journal.** A continuation or fork that takes up a journal left unapplied pushes it as a plain `edit` entry with an `nse.recovery` step and its context (`openStored`, `src/local/startup/open.ts`).
- **`RecoveryContext`** (`src/history/operations/steps.ts`): `{head, headIndex, dropped[], omitted, x?}`, the descriptions of steps that could not be kept, so the Timeline can say what was lost. At most 64 items (`RECOVERY_CONTEXT_ITEMS`) and 128 KiB (`RECOVERY_CONTEXT_BYTES`) of `dropped`, counted without any `x` on the items (`withoutExtension`); the oldest go first and `omitted` counts them.

### 2.10 Time

`now = max(Date.now(), meta.maxSeenTime + 1)`, and every write moves `maxSeenTime`, so two writes never share a time across tabs or with the clock held back (`src/local/time.ts`). `clampTime` brings a time more than a day ahead back to now for the page's wall times, a journal's entry times and `startedAt` (`flushWrite.ts`, `journal/apply.ts`). Imported file rows keep their times unclamped. `meta.daysOfUse` rises once per calendar day of use; rows carry `day`, and "within N days" means `daysOfUse - day < N`, so a clock jump expires nothing early (`src/local/days.ts`).

A session's own rows never go back in time: each flush or journal row is its own stamp, and an open's own rows share one. A session opened from a file keeps the file's times for the rows it copied. `ORIGIN_RULE` (`src/local/records/unknownValues.ts`) says which sessions hold only their own rows (`new`, `import`, `continued`, `migrated`, `journal`) and which hold a file's (`nxsp`, `replaced`, and a missing or unknown origin); a session's `origin` is set when it is created and never changes, and rows copied from a file are written only into a session of a file origin that the same writer created (it never fills one it did not create). In a session of its own rows a `continue` row is only the lowest.

**Calendar.** Local days, hours and minutes come from `src/calendar/calendar.ts`, given a time and a zone; History samples both into `calendarClock.ts`, formats through `historyFormat`, and passes the zone to `readTimelineIndex`. Pieces are defined by `src/calendar/pieces.ts`: the maximal runs of adjacent entries of a list, dividers skipped, that share a session and a local day. The worker binary-searches only sessions of a new, imported, continued, migrated or recovered origin with no import pending and no kind filter, and reads every other session in full through a memo that grows by the rows added above it. Go To's counts are the steps under the Timeline's headers: every member of a collapsed group, no "Continued from" divider.

## 3. The `.nxsp` history

A `.nxsp` is a plain ZIP; `level.json` is the chart now, and the history is optional extra. The container rules (headers, CRC, timestamps, ZIP64, names) are in `src/zip/` and `src/local/nxsp/execute.ts`, and the full byte-level description in the owner's `work/nxsp-format.md`. What an older reader does with a newer file is format-versioning sections 2 to 4.

### 3.1 Entries

In the writer's order (the checker enforces it; readers do not depend on it):

| Entry | Method | Named by | Holds |
| --- | --- | --- | --- |
| `project.json` | 8 (DEFLATE) | fixed | Identity, `revision`, level info, pointers, `summary` |
| `level.json` | 8 | `level` (must be `"level.json"`) | The chart as level data `{bgmOffset, entities}` |
| `history/segments/<n>.json` | 8; a copied segment keeps its method | `history.segments[n-1]` | Older parts of the chronology |
| `history/manifest.json` | 8 | `history.manifest` | The newest part and the undo stack |
| `history/chunks.bin` | 0 (STORE) | `history.chunks` | Every chunk's stored form, concatenated |
| `assets/cover.<ext>`, `assets/preview.<ext>`, `bgm/<name>` | 0 | `metadata.cover.file`, `metadata.preview.file`, `bgm.file` | The head's media, when held |

Every entry other than `project.json` must be named by exactly one pointer, inside that pointer's prefix. JSON is compact `JSON.stringify`, UTF-8, no BOM; a reader strips one leading BOM.

### 3.2 `project.json` keys History uses

Writer order (`PROJECT_KEYS`, `src/local/nxsp/project.ts`): `format version minor patch levelVersion appVersion id lineageId revision name exportName level editor bgm history summary metadata parts`, then unknown keys from `extra`.

| Key | Rule |
| --- | --- |
| `format` … `levelVersion` | format-versioning section 2. `minor` is 0. |
| `appVersion` | The last writer's version. Per-Save versions are on the `save` entries. |
| `id`, `lineageId` | The `docId`; provenance, copied on forks and Save As. |
| `revision` | `{id, parent, n, savedAt, device {id, label}, ancestors, replaces?, fileName?, completeFrom?}`. `id` is new per write; `parent` is the revision it descends from or `null`; `n` is display only; `ancestors` are newest first, at most 1,024 (`ANCESTOR_LIMIT`, a writer limit the strict checker enforces), read as a set; `replaces` only by Replace. |
| `revision.completeFrom` | History writes only; a non-string reads as absent. The writer keeps the carried value if it is the new id or in `ancestors`, else writes the oldest ancestor, or the new id when there are none. The reader places it against `{id} ∪ ancestors`; an unplaceable value reads as the file's own id (`placedCompleteFrom`). |
| `history` | `{manifest, chunks, entries, segments?}`, present exactly when the file has history. `entries` is the total over all parts; a mismatch is damaged history. At most 4,096 segments (`SEGMENT_CAP`). Any other key (the retired `media` included) is `unknown-key`, and the whole `history` is then dropped. |
| `summary` | `{noteCount, durationMs, revisionId}` from the head; used only when `revisionId == revision.id`, otherwise ignored. |
| `parts` | Never written; any key inside is `unknown-key`. |

### 3.3 Manifest and segments

```
manifest: { version: 1, entries, roots, nodes, chunks, undoStack }
segment:  { entries, roots, nodes, chunks }
```

Both may also hold `x`. The history is the concatenation of the parts: `entries` are the segments in `history.segments` order, then the manifest's; `roots`, `nodes` and `chunks` are the union. A key in two parts must have equal values; a hash may appear in `chunks` once.

| Member | Form |
| --- | --- |
| `entries` | Entry forms, oldest first (below). |
| `roots`, `nodes` | `{hash32: record}`, each part holding those it first references, in first-reference order. The manifest also holds the undo slots' roots. (`planNxsp` sorts any `otherRoots` input by hex; only tests pass one.) |
| `chunks` | `[[hash32, offset, length], ...]` into `chunks.bin`. All parts' indexes together must tile `chunks.bin` exactly. |
| `undoStack` | `{base, slots: [{snapshot, step}], index}`: the head session's stack. `base` is the absolute number of `slots[0]`, `base <= index < base + slots.length`, and the head state is `slots[index - base].snapshot`. |

**Entry form.** Keys (`ENTRY_KEYS`): `kind time operation recoveryContext step snapshot noteCount dirty kept revisionId device appVersion stack x`. The writer emits `kind`, then `step` or `operation` (and `recoveryContext`), then `time snapshot noteCount? dirty? kept? revisionId? device? appVersion? stack? x?`. `seq`, `day`, renames and session ids are not in files; rows are numbered by position and sessions are separated by `continue` entries.

| Field | Rule |
| --- | --- |
| `kind` | `init continue edit undo redo restore save export recovered`. An unknown kind is `newer-history`; its other fields are not checked, but unknown keys are still reported. |
| `step` | Exactly on `edit restore undo redo`. `edit` and `restore` must match `step.kind`; `undo` and `redo` may not cross an `init` step. |
| `operation` | Exactly on `init continue save export recovered`. |
| `recoveryContext` | Exactly on `recovered`. |
| `time` | A safe integer of at least 0. |
| `snapshot` | 32 hex characters, always, even when the file lacks the root. |
| `noteCount` | Optional. A non-negative integer when present; **absent is an unknown count**, never 0, and a reader and the checker accept it (`null` is damage). On import it is replaced by the root's count when the root is held, else kept as the file has it, absent included. A Save writes a stored row's own count, else the count of the root it verified (`countOf`, `src/local/save/build.ts`); a row with neither is written without one, and its state is then not held, so it is written `kept: false`. A `save` entry always has one (the head's). |
| `dirty`, `kept` | `true` and `false` respectively, present only when set. Every row without `kept: false` must have its root in `roots`; a `kept: false` row may still have it. |
| `revisionId`, `device`, `appVersion` | `save` only. The first two required; `appVersion` always written, optional on read. |
| `stack {keep, push: [{snapshot, step}], index}` | `recovered` only, required; numbered as `undoStack`. |
| `x` | A JSON object: the one `x` rule of format-versioning section 3 (at most 256 KiB, at most 32 levels below the `x`; `isExtensionValue`), damage whatever `patch` says. |

A field of another kind (`revisionId`, `device` or `appVersion` off `save`, `stack` off `recovered`) is `unknown-key`, not damage.

### 3.4 Open, and `chunks.bin`

An open writes one new session (origin `nxsp`, or `replaced` for a takeover; `writeOpenHead`, `src/local/open/importWrite.ts`) in one transaction: the file's rows as `seq` 1 to n, then an `edit` entry of `nse.externalChange` when `level.json` differs from the history head, then a `continue` entry of `nse.origin`. Its stack is the file's `undoStack` (plus that edit); a file without history gives one slot whose step is `init`. The binding's cut is row n. Bodies not needed for the head follow in the background import (`importPending`, `src/local/open/importLoop.ts`).

`chunks.bin` holds the stored chunks, concatenated with no framing. An append puts the source's `chunks.bin` first unchanged (one whole-entry copy, checked by CRC), then new chunks in first-reference order: entries in order (the `snapshot`, then a `recovered` entry's pushes), then the undo slots, then remaining roots; for each root its header chunk, then its kinds in order. The order affects offsets only, never a hash.

At open, every root and node is checked (hash of its canonical bytes, form, known `v`, references resolve), as are every root's header chunk and the head state's chunks (decoded and schema-checked, `noteCount` against the slides). Other chunks are inflated and hashed lazily during the background import. A chunk failing then marks the rows that need it `kept: false`; if the file is the chain's own and unchanged (size, modification time and fingerprint, when a handle is held; a picked `File` counts as unchanged), the chain is also unlinked (`writeUnlink`: new `docId`, no `revision` or `file`, `badChunks` added, `partialImport` set).

### 3.5 What a Save appends and what it rewrites

`planSave` (`src/local/save/build.ts`) decides the content; `planNxsp` (`src/local/nxsp/build.ts`) lays it out.

| Write | When | History |
| --- | --- | --- |
| `append` | A write-back to the chain's own file at its base, when that file has a manifest | The old segments are copied whole in order and `chunks.bin` begins with the old one. The old manifest becomes a new segment when it holds 500 or more entries; otherwise its contents carry into the new manifest. The rows after the binding's cut and the new `save` entry go in the manifest, never split. `completeFrom` is the source's. `assertAppend` checks independently that the plan is an append. |
| `copy`, `replace`, `new` | Anything else | The chronology is rebuilt from storage: sessions in chain order, each by `seq`, plus the tab's unflushed rows. Nothing is reused. It is cut into segments of 500 entries (`SEGMENT_ENTRIES`) while more than 500 remain, and the manifest holds the last 1 to 500. |

In every write the history ends with this revision's `save` entry; the undo stack is the saved session's, cut and renumbered (section 2.8); rows whose state is not held whole are written `kept: false`, never filtered out; and `project.json`, `level.json` and the media are rewritten. A writer never thins history inside a file. `new` (Save As, Save to File of a session) starts a new `docId` with no parent; `copy` keeps the `docId` and takes the chain's revision as parent.

Writer-only limits: the 5,000-slot stored window (`STACK_CAP`), 1,024 ancestors, 500-entry segments and the split sizes. `checkLimits` refuses a plan (`PlanError`, reason `plan`) with more than 4,096 segments, history parts over 512 MiB, or anything needing ZIP64 (4 GB, 65,535 entries): the writer never emits ZIP64. Readers accept any count within their caps.

**Picking the chain's own file** (`src/editor/save/flow.ts`). A save picker empties the file it returns, so the page protects what the file holds that storage may lack:

- **A read at every picker.** Every Save or Export picker that may return the chain's own file has a read of it first (`preRead`), per picker and not per dialog. Save, Save As…, Save as a Separate File and the not-found Save As… use the dialog's read (started when it opens), else one started at the press (`pickAndWrite`) with a grant already held, since a prompt would spend the press the picker needs. Export reads when its dialog opens, again after a pick used the read, and when a follow-up dialog that offers Choose Another… opens (`exportPickerOpening`); it keeps the read while its flow runs. The file is read whole into memory, and only when storage lacks something (the carry test fails, rows are lacking, head media is not held, known damage) or the file is not at the base. A read not finished when the picker opens is dropped. Save to File… (a session written as a new document) reads nothing: a pick of the chain's own file there is a takeover by another document, as a pick of another chain's file is.
- **Choose Another… repeats the same Save**, with its own read: Save As… stays Save As… (a new `docId`), Save as a Separate File and the not-found Save As… repeat themselves, and Save to File… repeats for its own session.
- **Putting the bytes back** (`keepingOwn`). When the pick is the chain's own file and bytes were read, every ending but a write, and any throw, puts them back while the file is still empty, under the pick's `nse-bind` exclusive lock, so no other tab writes between the pick's check and the put-back. Bytes that cannot go back (the file was filled meanwhile, or the write failed) are offered as a download (`notPutBack`, or `refused` with `emptied`), then the outcome is shown. Export's pick of the own file that is not written again (no binding, or a Save holds the reservation) is inside the same guard.
- **A failed own-file rebuild** is tried once more (a refusal is not, as it would be the same). With nothing read, the build made before the picker is written only when it is a `copy` with the file's History and BGM options; otherwise the file stays empty, the failure is shown and the next Save fills it from storage. The write is never Save As…'s identity (new `docId`, no ancestors, the dialog's History) over the chain's own file.
- **An open's import** is waited for inside "Preparing…" (`waitForChainImports`, `src/editor/save/imports.ts`; cancel ends the Save only), and so is any other import of the chain. It asks storage's `importPending` (`openPendingImports`), not only this tab's tracker, so after a reload mid-import it waits up to 4 s for the resume to start, then for the import. Recognising our own completed Save waits the same way, and a chain still importing after that is refused as `importing`, the marker kept. A resume that never starts is refused as `importing`, with the line that the file could not be read completely. The Save dialog shows "Estimating size…" and no count while the import runs, and a cached estimate is kept only when the flush left nothing pending.

### 3.6 Reading

`readNxsp` (`src/local/nxsp/read.ts`); the line the open shows is chosen by `partialLine` (`src/local/open/decide.ts`).

| Result | When |
| --- | --- |
| `not-project` | No `project.json`, or `format != "nxsp"`. |
| `unreadable` | Not a readable ZIP; more than 65,535 entries; `project.json` or `level.json` missing or unreadable (cap, CRC, inflate, UTF-8, JSON, nesting). Nothing opens. |
| `nxsp`, `open: 'full'` | The report is empty or holds only `newer-patch`. |
| `nxsp`, `open: 'partial'` | Anything else in the report. Unbound, a new `docId`, no `revision`; it never writes over the original. |

History is read only when the report holds no `damaged` and no `newer-minor`.

| Reason | Cause | Effect |
| --- | --- | --- |
| `damaged` | Duplicate names, overlapping data, a directory recovered by scan, a pointer outside its prefix or two on one entry, a cap passed, a ZIP or JSON failure in a history part (other than `chunks.bin`), a non-object `parts` | History not read; the level opens. |
| `history-unreadable` | A missing part, a dangling hash, an index that does not tile, a chunk not hashing to its name or over 16 MiB, any failure reading `chunks.bin`, a root or node not hashing to its key or invalid, `index` out of range, a key with two values, an `entries` mismatch, a bad entry, a resource-invalid description, a manifest `version` that is not an integer of at least 1 (`version < MANIFEST_VERSION`, `checkPart`) | History not read. |
| `newer-history` | A manifest `version` that is a safe integer above 1, a root `v` above `RECORDS_V`, an entry `kind` or record kind name this build does not know | History not read. |
| `unknown-entry`, `unknown-key`, `invalid-key`, `newer-level`, `newer-minor`, `newer-patch`, `newer-version` | Newer content or a known key of the wrong form (format-versioning section 2) | `unknown-key` covers unknown `level.json` keys too. |
| `media-unreadable` | A media entry missing, or its size or SHA-256 differs from `project.json` | The rest opens. |

**Tolerated:** unknown top-level and `metadata` keys (kept as `extra`, written back); unknown keys inside `revision` and `summary` (ignored); `x` on any carrier; a `savedAt` that is not RFC 3339 (absent); any entry order; STORE or DEFLATE for any entry; data descriptors, extra fields and ZIP64, so an OS re-zip opens; `__MACOSX/`, `cache/`, `.DS_Store`, `Thumbs.db`, `desktop.ini` and `._*` entries (ignored); chunks that hash to their name but are not canonical; one leading BOM in JSON.

**Rejected:** the encryption flag or a method other than 0 or 8; a CRC, size or local-header mismatch; overlapping entries; a hash that is not 32 lowercase hex characters; an `x` that breaks the `x` rule (not an object, over 256 KiB, or nested deeper than 32 levels below it; format-versioning section 3); a key outside its carrier in a step, recovery context or entry (`unknown-key`); `kept` other than `false`, `dirty` other than `true`; an operation with a lone surrogate, a non-finite number, depth over 16 or over 256 KiB. `chunks.bin` stored with STORE is read in slices and its whole-entry CRC is never checked: each chunk is checked by its hash instead. An entry name keeps a leading U+FEFF, so `﻿bgm/a.mp3` is not `bgm/a.mp3`: it is an `unknown-entry` and the pointer's entry is missing.

**Caps:** `NXSP_CAPS` (`read.ts`): `project.json` 1 MiB inflated, `level.json` 64 MiB, the manifest and each segment 256 MiB, all history parts 512 MiB, `chunks.bin` 2 GiB, one chunk 16 MiB inflated, one media entry 1 GiB, JSON depth 64. Also 65,535 entries (`ENTRY_CAP`, `src/zip/directory.ts`) and 4,096 segments (`SEGMENT_CAP`). A STORE entry needs `compressedSize == size`, a DEFLATE entry `compressedSize <= 2*size + 1024`.

### 3.7 The Python checker

`tools/nxsp_check.py` shares no code with the editor. It reads `tools/fields-v1.json` (byte-identical to `src/local/records/fields-v1.json`, both written by `npm run format:gen` from `fieldsTable.ts`; `tests/local/records/formatGen.test.ts` fails when they differ from the schema), using each record's positional fields (`type`, `optional`, `minItems`, `ref`), `kinds`, `kindOrder` and the `enums` for membership.

```
uv run python -I tools/nxsp_check.py FILE...          # strict: what a v1 writer must have written
uv run python -I tools/nxsp_check.py --read FILE...   # second reader: one JSON line per file
uv run python -I tools/nxsp_check.py --show FILE HASH # a record, chunk, root or node with field names
```

Strict mode checks the container byte for byte, `project.json` and `revision` (ancestors, DOS time equal to `savedAt`, `summary` against the head), pointers, segment names and entry order; that `minor` and `patch` equal the lowest the content needs (`expected_minor`, `expected_patch`, as `minorOf` and `patchOf` choose them); then every part's keys, every entry including the carrier rules, step keys and kinds, and a `save` entry's non-empty `appVersion`; index tiling and `history.entries`; every chunk strict-inflated and re-hashed; every node and root re-hashed and checked against `fields-v1.json`; kind order, `noteCount`, header references and the closure of every root; the undo `index`; and the chronology ending with this revision's `save` entry. Across files given together it checks `completeFrom` against the other files' rows. `--read` agrees with the TypeScript reader. Operation payloads are bounded only (`finite_wire_json`: `OP_BYTES` 256 KiB, depth 16, finite numbers, well-formed Unicode); the checker never decodes an envelope.

The checker's hard-coded values are listed in format-versioning section 4, step 3. `ENTRY_KEYS` appears twice in it (strict and `--read`); change both.

Tests: `tests/local/nxsp/` (`read`, `build`, `roundTrip`, `golden` with `golden-v1/`, `checker`, `agreement` (every probe through both readers), `graph`, `project`, `execute`), `tests/zip/` (`zip`, `planConformance` with `plan-conformance-v1/`), `tests/local/records/` (`fields`, `golden`, `schema`, `split`, `canonical`, `chunkVerify`, `hash`, `formatGen`), `tests/local/formatVersions.test.ts`, and the Save tests that run the checker over saved files (`tests/local/save/fixture.ts` `checkFiles`). Checker tests skip without `uv`.

## 4. Operations

### 4.1 What an operation is

An operation describes a step. It is never replayed: Undo and Redo move the index and the slot already holds the state, so nothing a state needs may live in `data`. A cascade (an owner deleted with its objects, a displaced BPM, a default stage that appears) is applied by the action that pushed the state, and the operation records the result as counts.

- **Envelope.** Exactly `{id, version, data, fallback: {text, locale}}`. Native ids are the keys of `operationCodecs` (`src/history/operations/registry.ts`); `version` is `1` for all of them (one literal, no per-id table yet). `createOperation`, through `createHistoryOperation`, captures `{id, data}` within 64 KiB (`OPERATION_NATIVE_BYTES`), checks `data` against the codec (throwing before `pushState` on a mismatch), renders the title in the current locale and stores it, cut to 1,024 code points, as `fallback`.
- **Known** means the four keys, a native `id`, `version === 1`, a valid `fallback`, at most 64 KiB and `data` passing the codec. Anything else is **unsupported** but kept whole (`decodeOperation`).
- **Resource bounds** (`json.ts`, `steps.ts`): plain JSON, finite numbers, no lone surrogates, no cycles or getters, at most 256 KiB UTF-8 (`OPERATION_WIRE_BYTES`) and depth 16; a step with a recovery context at most 2 × 256 KiB + 128 KiB + 4 KiB, depth 20. A step's, a context's and an operation's caps are measured without any `x` in the step, its context, head and dropped items; an `x` has its own limits (format-versioning section 3). Beyond them a description is resource-invalid: damaged history in a file, not merely unsupported.
- **Rendering.** A known operation renders in the current locale. Otherwise the line is `fallback.text` when valid and non-empty, else the coarse kind ("Initial state", "Edit", "Restore", "Continued", "Save", "Export Level Data…", "Recovered changes"; `describeStep`, `describeEntry`, `format.ts`). Step Details says "This step was recorded by a newer version of the editor." for an unknown `nse.` id or a native id with a version above 1, and "This editor cannot read the details of this step." otherwise, including a native id whose `data` fails its codec.
- **Step.** `UndoableStep` is `{kind: 'init' | 'edit' | 'restore', operation, recoveryContext?, x?}`, the kind that pushed it. Any other key is `unknown-key` in a file.
- **Values.** Units are format-versioning section 6. Names are `NameText {text, truncated?: true}` of at most 256 code points; lone surrogates are replaced at every text entry point. Scalar counts (`created`, `targets`, `gathered`, `released`, `droppedSteps`) are non-negative safe integers; a count map (`changed`, `removed`, `placed`, `displaced`, ...) never holds a zero, and its optional form is never empty.

### 4.2 The no-op rule

An action that leaves the chart as it was pushes no step (owner, 2026-10-19). For an `edit`, `pushState` compares the new state with the current one by `sameChart`: the header record text (with identity checks on the BGM buffer and source first), the slides as a set of records (slide ids are not stored), and each event kind in file order (same-beat order is state). Anything `sameChart` cannot decide counts as different, so a step is never dropped on a doubt.

- Equal charts: `pushState` returns `false`; the stack, the current step, snapshot and dirty flag stay. A changed selection replaces the current slot's state (`replaceCurrent`) without a step.
- `restore` always pushes. `restoreEntry` itself compares snapshots first (`sameSnapshot`) and says "Already matches the current chart" instead.
- Producers build `data` from the result, never the request. Codecs accept the "nothing" shapes (`created: 0`, `targets: 0`, `changed: {}`, `removed: {}`) because the operation is built before `pushState` decides; such data never groups (`historyProducerReceipts.test.ts`, "a step that changed nothing carries no count, never zero"). A producer may return before `createHistoryOperation` when it already knows nothing changed.
- File events are not steps; `init`, `continue` and `recovered` come from the storage side. A `save` entry is written for every completed Save, changed chart or not.

Guarded by `tests/editor/noOpSteps.test.ts`.

### 4.3 All operations

| Id | Pushed as | Produced by | `data` |
| --- | --- | --- | --- |
| `nse.note.add` | `edit` | Note tool, Slide tool, Elevation Editor create | `{created}` |
| `nse.note.generate` | `edit` | Generate Slide Notes | `{created}` |
| `nse.note.elevation` | `edit` | Elevation Editor drag changing only elevation | `{targets}` |
| `nse.note.combine` | `edit` | Combine into Slide | `{targets}` |
| `nse.note.split` | `edit` | Split Slide | `{targets}` |
| `nse.note.vertical` | `edit` | Make Vertical | `{targets}` |
| `nse.object.add` | `edit` | BPM, Time Scale and the five event tools | `{subject, created}` |
| `nse.object.edit` | `edit` | A tool edit in place; Elevation Editor width change | `{subject, changed, displaced?, retainedInitialBpm?}` |
| `nse.object.move` | `edit` | A tool or Select drag; Elevation Editor lane change | as `edit`, plus `resized?` |
| `nse.object.replace` | `edit` | A BPM or time scale moved onto an occupied beat | `{subject, changed, displaced, retainedInitialBpm?}` |
| `nse.object.paste` | `edit` | Paste tool, context menu, Elevation Editor | `{placed, variant, flipped, at, displaced?}` |
| `nse.object.brush` | `edit` | Brush tool | property data |
| `nse.object.delete` | `edit` | Eraser, Delete, Elevation Editor | `{removed}` |
| `nse.object.cut` | `edit` | Cut | `{removed}` |
| `nse.object.flip` | `edit` | Flip, Flip Vertical | `{axis, subject, changed, displaced?, retainedInitialBpm?}` |
| `nse.object.scale` | `edit` | Scale Beat, Width, Elevation | `{axis, subject, changed, transform, displaced?, retainedInitialBpm?}` |
| `nse.property.set` | `edit` | Properties panel, quick edits, Move to Group or Stage | property data |
| `nse.header.set` | `edit` | Level Properties, Offset tool, BGM dialog | `{field, before, after}` |
| `nse.bgm.change` | `edit` | BGM dialog, audio open | `{file, offset?}` |
| `nse.levelInfo.set` | `edit` | Nothing yet (Level Info dialog, Step 11) | `{changes}` |
| `nse.dynamicStages.enable` | `edit` | Enabling dynamic stages | `{created}` |
| `nse.owner.create` | `edit` | Add Group, Add Stage, New Folder | `{target, destination, gathered}` |
| `nse.owner.rename` | `edit` | Rename; the Properties dialogs' Name | `{target, before, after}` |
| `nse.owner.set` | `edit` | Group and Stage Properties | `{target, changes}` |
| `nse.owner.move` | `edit` | Move, drag, Move to Folder of one entry | `{target, destination, category, fromIndex?, toIndex?}` |
| `nse.owner.moveMany` | `edit` | Bulk Move to Folder | `{domain, targets, destination}` |
| `nse.owner.duplicate` | `edit` | Duplicate | `{domain, created, source?, objects?}` |
| `nse.owner.delete` | `edit` | Delete | `{domain, removed, target?, objects?, replacement?}` |
| `nse.owner.ungroup` | `edit` | Ungroup | `{target, released}` |
| `nse.origin` | `init` step or entry; `continue` entry of a `.nxsp` open | New, import, open, migration | `{origin, source?}` |
| `nse.continue` | `continue` entry | A continuation or fork | `{fromTime}` |
| `nse.file.save` | `save` entry | Save | `{file, delivery}` |
| `nse.file.export` | `export` entry | Export | `{file, delivery}` |
| `nse.restore` | `restore` step | Restore | `{targetTime}` |
| `nse.recovery` | `edit` step in a `recovered` entry or a plain `edit` entry; `recovered` entry | Journal recovery | `{droppedSteps}` |
| `nse.externalChange` | `edit` entry | A `.nxsp` open whose chart differs from its history head | `{}` |

Any other id is not native; tests use `test.future.*` for unknown ones.

### 4.4 Operation details

#### Chart objects: shared rules

- **Producers** build `data` from a receipt of the edit (`src/state/operations/historyReceipts.ts`), push, and notify with the operation's title only when `pushState` returned `true`.
- **Counts.** `nativeCounts` maps `note, bpm, timeScale, cameraEvent, stageMaskEvent, stagePivotEvent, stageStyleEvent, stageTransformEvent` to positive values with a safe sum, and may be empty; `nativeCountsPlus` must be non-empty and is used for every optional map. `subject` is one native kind or `objects`; `subjectOfCounts` gives the kind when the counts have exactly one key, else `objects`. A codec rejects a subject that disagrees with non-empty counts; with `changed: {}`, `edit`, `move`, `replace`, `flip` and `scale` accept any subject, while property data always checks.
- **Collateral.** `displaced` counts objects the edit replaced that were not its operands. `retainedInitialBpm: true` (`false` is rejected) says the beat-0 BPM was kept in place or added back; it needs subject `bpm` or `objects` (`bpm` only for `replace`). `edit`, `move`, brush and `property.set` accept both (brush and `property.set` only with a `beat` assignment); `replace` requires `displaced`; `flip` allows them only for `vertical`, `scale` only for `beats`; `paste` has `displaced` only. Accepted but not produced today: collateral on `edit` and brush, `displaced` on `property.set` (a lone BPM or time scale beat edit is delegated to its tool).
- **Step Details** (from stored `data` only): a "Changed" counts row when `changed` has two or more kinds (always for `flip` and `scale`), a "Replaced" row from `displaced`, and the fact "Kept the initial BPM change". Titles are plural-aware; with a zero count, families with a `history.summary.*` string use that quantity-free form.

#### Notes

| Id | `data` counts | Title (en) | No-op |
| --- | --- | --- | --- |
| `nse.note.add` | `created`: notes added (a new one-note slide from the Note tool, a note into a slide from the Slide tool, an Elevation Editor create) | "Added {0} note(s)"; zero "Added notes" | Stack rule |
| `nse.note.generate` | `created`: attached notes added on grid lines not already holding one (tap, box select, Elevation Editor) | "Generated {0} note(s)" | Pushed only when notes were made; more than 100,000 lines refuses first |
| `nse.note.elevation` | `targets`: notes changed | "Changed elevation of {0} note(s)" | A drop that changes no note pushes nothing |
| `nse.note.combine` | `targets`: every note of all slides involved | "Combined {0} notes into one slide" | Fewer than two slides: notice, no step |
| `nse.note.split` | `targets`: selected notes that are not their slide's last (cut points) | "Split {0} slide connection(s)" | No cut point: notice |
| `nse.note.vertical` | `targets`: notes whose fields changed | "Made {0} note(s) vertical" | No selection or no change: notice |

- **Apply.** `combine` re-adds all notes of the selected slides as one slide ordered by beat (elevation breaks ties; connector properties and separators rewritten). `split` starts a new slide after each cut note. `vertical` moves the selected notes to the earliest selected beat, sets elevation to beat minus that beat and detaches them; its receipt has `displaced` and `retainedInitialBpm`, which the command does not store.
- **One drag, three ids.** The Elevation Editor gives `nse.object.edit` for a width change, else `nse.object.move` for a lane change, else `nse.note.elevation`.
- **Step Details:** the title only. Zero counts on `elevation`, `combine`, `split` and `vertical` have no quantity-free form; producers never store one.
- **Groups:** all six by subject `note`; `add` and `generate` sum `created`. Group titles are quantity-free ("Changed note elevations", "Combined notes into slides").

#### Add, edit, move, replace

| Id | `data` | Title |
| --- | --- | --- |
| `nse.object.add` | `{subject, created}`; subject `bpm`, `timeScale` or an event kind (`note` and `objects` rejected) | "Added {0} BPM change(s)", "Added {0} {kind} event(s)" and so on |
| `nse.object.edit` | `{subject, changed}` plus collateral; `changed` counts operands whose principal fields changed | "Edited {0} note(s)"; "Edited objects" for `objects` |
| `nse.object.move` | as `edit`, plus `resized?: true` (`false` is rejected) | "Moved {0} note(s)"; "Moved objects"; with `resized`, "Resized {0} note(s)", "Resized {0} {kind} event(s)" |
| `nse.object.replace` | `{subject: bpm \| timeScale, changed, displaced, retainedInitialBpm?}`; every displaced kind is the subject | "Replaced {0} BPM change(s)" |

- **One builder** (`editInput`): intent `move` becomes `replace` when `displaced` is present, the subject is `bpm` or `timeScale` and every displaced object is of that kind. A tap on an occupied BPM edits it. A sidebar edit of a lone BPM or time scale's beat is delegated to its tool and gives `move` or `replace`, not `property.set`.
- **Resize.** A Select drag that takes an edge of a note, a camera event or a stage mask event changes the extent of its lanes and nothing else, and is a resize, not a move. Select writes `resized: true` into `nse.object.move` by what changed: the drag took an edge (every moving object is of the grabbed object's type), at least one object's width or range changed, and no beat did. A drag that took an edge but only shifted it, or one that took the body, stays a plain move. `resized` needs subject `note`, `cameraEvent` or `stageMaskEvent`, and no `displaced` or `retainedInitialBpm`. The group family is its own (`resize`): resizes group with resizes, quantity-free ("Resized notes", "Resized {0} events"), and never with moves.
- **Cascades.** A time scale displaces every time scale of its group at the destination beat; a BPM displaces the BPM there; a Select move of a mixed selection counts per kind. Moving the beat-0 BPM with its tool keeps it and adds a copy at the new beat (`retainedInitialBpm`); Select derives the flag from the selection (an unpinned BPM at beat 0 moved).
- **No-op.** `commitDrop` commits only when an operand changed (`editChanges`); Select returns when nothing moved (`isUnmoved`); then the stack rule. A change that touched no principal field is pushed with `changed: {}` and reads quantity-free ("Edited notes").
- **Step Details:** the shared rows; `replace` omits "Replaced" when it equals `changed` in one kind.
- **Groups:** by subject (a resize is its own family); `add` sums `created`. A multi-assignment `nse.property.set` has the same group key as `nse.object.edit` of its subject, so one group can hold both ids.

#### Paste, brush, delete, cut

| Id | `data` | Title |
| --- | --- | --- |
| `nse.object.paste` | `{placed: nativeCountsPlus, variant: basic \| composed, flipped, at: pointer \| position, displaced?}` | "Pasted {0} object(s)" |
| `nse.object.brush` | property data | "Brushed {0} note(s)" (one kind) or "Brushed {0} object(s)" |
| `nse.object.delete` | `{removed: nativeCounts}` | "Deleted {0} note(s)" or "Deleted {0} object(s)" |
| `nse.object.cut` | `{removed: nativeCounts}` | "Cut {0} note(s)" or "Cut {0} object(s)" |

- **Paste.** Producers: the Paste tool (drag end, tap) and `pasteAtPosition` (context menu, Elevation Editor); the Paste command only switches tool. `placed` counts pasted objects that survive in the committed selection; `pasteOperation` returns `undefined` when there are none. `variant` is `composed` only with the composed layout and dynamic stages; `flipped` is Shift. A pasted BPM or time scale removes the occupant (`displaced`). Stage events are skipped when dynamic stages are off, and the prompt may push a separate `nse.dynamicStages.enable` first. Step Details: "Pasted", "Replaced", "Editor Layout", "Paste Location" and the fact "Pasted flipped".
- **Property data** (brush and `property.set`): `{subject, changed: nativeCountsPlus, assignments}` plus collateral. `assignments` is non-empty, one per field, ascending by field id (61 fields, `fieldCodecs`); each is `{field, before, after}`, a side being `{mode: 'varying'}` or `{mode: 'uniform', value}` with the value passing the field's codec (a number, boolean, enum, ease, or for `groupId` and `stageId` an owner reference with a captured name). Every assignment must apply to some changed kind and every changed kind must have one. Step Details: the shared rows, then one change row per assignment (qualified label, before, after; a row whose texts are equal is dropped). Brush writes every key the brush holds, never touches BPM changes, and its title ignores the assignments.
- **Delete and cut.** Removable: notes, BPM changes above beat 0, time scales and the five event kinds; connectors are not removed. Step Details: a "Removed" row for two or more kinds. Cut writes the clipboard first, outside History, so undo leaves the clipboard. With nothing removable no operation is built: the Eraser clears the selection and any notice, Delete does nothing, and Cut clears the selection, still copies and says "Copied".
- **Groups:** `paste` as `objects` ("Pasted objects"); `brush` by subject; `delete` and `cut` by `subjectOfCounts(removed)`, summing the counts.

#### Flip, scale

| Id | `data` | Title |
| --- | --- | --- |
| `nse.object.flip` | `{axis: horizontal \| vertical, subject, changed}` plus collateral when vertical | "Flipped {0} object(s)", "… vertically" |
| `nse.object.scale` | `{axis: beats \| width \| elevation, subject, changed, transform}` plus collateral for `beats`; `transform` is `{mode: 'uniform', factor, pivot}` or `{mode: 'composed'}` | "Scaled beats of {0} object(s)" and so on |

- **Apply.** A horizontal flip changes per-kind fields (a note's `left` and flick direction, event lanes and rotations, a style's border styles; `editorLane` negated only when the whole selection is of that type). A vertical flip mirrors beats between the selection's ends, reverses connector properties and eases, and re-adds the initial BPM if it moved. Scale applies the preview draft (`src/editor/commands/scaleSelection/session.ts`); `uniform` only when the draft came straight from the source with one scale (a typed factor or one endpoint drag).
- **Cascades** are observed from the grid after the transform; a scale counts only displaced objects the chart held before the session.
- **No-op.** A horizontal flip with no changed operand and a vertical flip that returns the source say "no change"; the scaling session returns when the result is its source; then the stack rule.
- **Step Details:** the shared rows, "Changed" always; scale adds "Scale Factor" and "Scale Origin" for `uniform`, or "Scale Factor: Multiple Adjustments".
- **Groups:** by family and axis.

#### Property edits

**`nse.property.set`** comes from every field edit on selected objects: the Properties panel and modals (a "mixed" value included), note and slide preset quick edits, and moving the selection to a group or stage. All run through `editSelectedEditableEntities` (`src/editor/sidebars/default/index.ts`), which builds the state and the receipt with `planEdit` (`src/state/operations/properties/plan.ts`).

- *Data:* property data. `changed` counts targets with an applied change, deduplicated by pre-edit entity. An assignment is recorded only for a requested field that applies and whose value changed on some target; a coupled effect (Fake or Critical also setting the connector's flag) counts as a change but has no assignment. A side is `uniform` when every holder, including targets already at the value, shares one value. Owner values store the id and a captured name. Ease edits store effective results.
- *Apply:* edits in stored order; re-adds the beat-0 BPM if a beat edit removed it (`retainedInitialBpm`); keeps an attached tick's place when a beat edit takes it past its slide's end.
- *Titles:* "Set {field} to {value} on {0} note(s)" for one uniform assignment, "Changed {field} on {0} note(s)" when it varies, "Edited {0} note(s)" for several.
- *No-op:* an out-of-range beat is refused; an empty `changed` says "no change"; then the stack rule. A missing receipt throws.
- *Groups:* one assignment: family `property` by subject and field, keeping the first `before` and the shared `after` ("Set Lane to 2 on notes", or "Changed Lane on notes"); several: family `edit`, shared with `nse.object.edit`.

Tests: `tests/editor/` `historyProducerReceipts`, `historyReceiptProperties`, `historySelectionReceipts`, `historyCodecTable`, `historyOperationDetails`, `historyOperationPresentation`, `historyOperations`, `noOpSteps`; browser `historyNativeProducers`, `historySelectionProducers`, `historyDetails`, `historyChanges`, `historyRecords`, `elevationNotices`, `scaleSelection`.

#### Header, BGM, level info, dynamic stages

The builders are in `src/editor/headerLabelText.ts`, wrapped by `src/editor/headerLabels.ts` (the file holds non-ASCII text; use `grep -a`). "View Property Changes" (`src/editor/history/propertyChanges.ts`) diffs two snapshots' headers and is separate from Step Details, which reads stored `data` only; the peek change view (`src/editor/history/changes.ts`) diffs chart objects.

**`nse.header.set`** `{field: initialLife | bgmOffset, before, after}` (finite numbers; `bgmOffset` in seconds).

- *Produced by:* Level Properties for Initial Life (`src/editor/commands/properties/index.ts`), the Offset tool drop, and the BGM dialog when only the offset changed (`bgmInput`). The codec allows `before === after`; producers return first when the value is unchanged or the dialog was cancelled.
- *Step Details:* "Set Initial Life to {0}" or "Set BGM Offset to {0} ms" (an exact decimal shift); one change row, `life` ("Initial Life") or `offset` ("Offset (ms)").
- *Groups:* family `header` by field ("Changed Initial Life"); group Details show one net row.

**`nse.bgm.change`** `{file: {before, after: NameText | null}, offset?: {before, after}}` (the file name without extension; `offset` only when it changed).

- *Produced by:* the BGM dialog and `changeBgm` (Open of an audio file, the "Choose Audio…" notice actions) when the buffer or file name changed; otherwise the same action gives `nse.header.set`. Re-picking the same bytes is not a no-op: every pick decodes a new buffer and `sameChart` compares it by identity, so the step has equal names.
- *Apply:* replaces `state.bgm` (name, buffer, waveform, bytes, metadata, offset).
- *Step Details:* "Changed BGM" (with `offset`) or "Changed BGM file"; a "File" change row, or a value row when both names are equal; an "Offset (ms)" row when stored; a missing name reads "Not set". Never grouped.

**`nse.levelInfo.set`** `{changes}`: 1 to 9 changes in the dialog's order `title artists author rating tags description cover preview initialLife`, each field once, each a real change, and not a lone `initialLife` (that is `nse.header.set`).

- Shapes: `title`, `artists`, `author`, `description` `{before, after: NameText}` (unset is the empty name); `rating` `{before, after: number | null}`; `tags` `{added, removed, changed?: positive, reordered?: true}` (counts by title); `cover`, `preview` `{before, after: NameText | null}`; `initialLife` `{before, after}`. A name pair is unchanged only when the texts are equal and neither is cut.
- *Produced by:* nothing yet. `levelInfoInput` builds it for the Level Info dialog (Step 11; one Apply is one step) and returns `undefined` when nothing changed; only tests call it. Today the status label opens Level Properties, which edits Initial Life only.
- *Step Details:* "Changed level info"; change rows per field (`historyChanges.fields.*`, "Preview Audio" for preview), tags as "Tags Added", "Tags Removed", "Tags Changed" and "Tags: Changed" for a reorder. Never grouped.

**`nse.dynamicStages.enable`** `{created: nativeCounts}`.

- *Produced by:* `requestDynamicStages` (`src/history/dynamicStages.ts`) through `checkDynamicStages`: the event tools' commands, the Stage commands, the Stages panel's "Enable Dynamic Stages" and pasting stage events. A confirm comes first; declining or already enabled pushes nothing. `created` counts the mask, pivot and style events it adds at beat 0 (no transform event).
- *Apply:* one default mask, pivot and style joint at beat 0 on the default stage, and `isDynamicStages`; `created` is `{stageMaskEvent: 1, stagePivotEvent: 1, stageStyleEvent: 1}`.
- *Step Details:* "Enabled dynamic stages" and an "Added" row. Never grouped.

#### Groups, stages and folders ("owners")

An owner is `OwnerReference {kind: group | stage | groupFolder | stageFolder, id, name: NameText}`. Producers are `src/editor/workspace/manager/` (`groups.ts`, `stages.ts`, `folders.ts`) and the Group and Stage Properties modals. Indexes are 0-based; a reorder shows them 1-based.

| Id | Produced by | `data` |
| --- | --- | --- |
| `nse.owner.create` | Add Group, Add Stage, an add in a folder, New Folder, "New Folder…" with held entries | `{target, destination: folder \| null, gathered}`: `gathered` is 0 unless the target is a folder; `destination` is null unless a group or stage was added in a folder of its domain |
| `nse.owner.rename` | Inline rename; the Name field of the Properties modals | `{target, before, after}` (`target.name` is the old name) |
| `nse.owner.set` | Group Properties (Force Note Speed); Stage Properties (From Start, Until End, Generate Sim Lines) | `{target, changes}`: 1 to 3 changes ascending by field name, a group only `forceNoteSpeed`, a stage the rest; each `{field, before, after}` (`forceNoteSpeed` number or `null`, booleans, `generateSimLines` `global` or `isolated`). Producers write one change per step. |
| `nse.owner.move` | Move Up and Down, drag, "Move to Folder…" and "No Folder" on one entry; moving a folder | `{target, destination, category: reorder \| intoFolder \| outOfFolder, fromIndex?, toIndex?}`; producers always write both indexes (tree-order positions; for a folder, among top-level items) |
| `nse.owner.moveMany` | Bulk "Move to Folder…" or "No Folder" | `{domain, targets, destination}`; `targets` counts entries whose folder changed |
| `nse.owner.duplicate` | Duplicate on an entry or folder; Duplicate Selected | `{domain, created: ownerCountsPlus, source?, objects?: nativeCountsPlus}`; `source` only for exactly one entry or folder |
| `nse.owner.delete` | Delete Group, Stage, Folder and Groups (confirmed when it has members); Delete Selected | `{domain, removed: ownerCountsPlus, target?, objects?, replacement?}`; `target` for one entry, or one folder with all and only its members; `replacement` is the default entry made when the last went |
| `nse.owner.ungroup` | Ungroup on a folder | `{target: folder, released}`; `released` is the member count, 0 allowed |

- **Codec rules.** A destination is a folder of the target's domain; a folder moves only as `reorder` with no destination; `intoFolder` needs a destination, `outOfFolder` none; `created` and `removed` hold only the domain's kinds; `objects` only what the domain owns (a group: `note`, `timeScale`; a stage: `note` and the four stage events); `replacement` is of the domain.
- **Apply.** A move changes tree order or folder membership and recomputes folder `index`; no chart object changes. Duplicate copies the entries and the objects they own (a group's time scales and notes, a stage's event chains and notes); copied entries and folders are named by `copyName`, except members of a copied folder, which keep their names. Delete removes a group's notes and time scales (whatever the note's stage), or a stage's events and notes, never camera events; if the last group or stage goes, a default one is made (`replacement`). Ungroup removes the folder and leaves its members loose.
- **Step Details.** `create`: "Added "X" group", "Added group folder "X"", "Created folder "X" with 3 groups", and a "Folder" value row with `destination`. `rename`: title only. `set`: "Set Force Note Speed of "A" group to 1.5" ("Cleared …" for `null`) and one change row per field. `move`: "Moved "A" group", "… into folder "F"", "… out of its folder", and an "Order" row for a reorder whose indexes differ. `moveMany`: "Moved 5 groups into folder "F"". `duplicate` and `delete`: the title and an "Added" or "Removed" counts row when `objects` exists or the title does not name what changed; `delete` adds a fact for a replacement. `ungroup`: "Ungrouped "F" folder" and a "Moved out of Folder" row above zero.
- **No-op.** Inline renames return when the name is empty or unchanged; the managers return when the owner is missing, the tree helper finds nothing to move (`sameTree`, `moveEntriesInTree`) or nothing was copied or removed. The Properties modals push every field change and rely on `pushState` for an unchanged value. Create, ungroup and folder deletes always change the chart.
- **Groups** (`operationGroup`): `create` by target kind (a `gathered` step never groups); `rename` by owner; `set` by owner and fields; `move` by target, category and destination; `duplicate` and `delete` by domain and kinds, summing ("Duplicated 3 groups"). `moveMany` and `ungroup` never group. Group Details show net rows.

Tests: `tests/editor/` `headerLabels`, `historyLevelInfo`, `folders`, `folderCopies` and the files above; browser `history`, `historyManagerProducers`, `historyDetails`, `historyRecords`, `toolsAudit`.

#### Session and file events

Made by the storage side and the file flows; none groups. Step Details shows the title and, where noted, one fact.

| Id | `data` | Title (en) |
| --- | --- | --- |
| `nse.origin` | `{origin: new \| import \| autoSave \| recovery, source?}`; `source` only with `import` | "Started a new level"; `import` "Opened {file}" with a source, else "Imported a level"; "Recovered from auto save"; "Recovered changes" |
| `nse.continue` | `{fromTime}` ms | "Continued from {time}" |
| `nse.file.save` | `{file, delivery: file \| download}` | "Saved {file}"; "Downloaded {file}" |
| `nse.file.export` | `{file, delivery}` | "Exported {file}"; a download adds the fact "Downloaded {file}" |
| `nse.restore` | `{targetTime}` ms | "Restored to {time}" |
| `nse.recovery` | `{droppedSteps}` | "Recovered changes"; facts "Actions without their own Timeline step: {n}" above zero, and the recovery context ("Earlier Actions", "Recovered up to here") |
| `nse.externalChange` | `{}` | "Changed outside the editor" |

- **`nse.origin`**: `resetState` (`new`, or `import` when a chart is given), `resetImportedState` (`import` with `source`), `openState` (default `recovery`, for Local Data's journal opens; a `.nxsp` open in safe mode passes `import` with `source` and stores nothing) and the auto-save migration (`autoSave`, written directly as an `init` entry by `src/local/startup/migrationWrite.ts`). A `.nxsp` open writes it as the `continue` entry, with the file's name, and as the `init` step of a file without history (`writeOpenHead`).
- **`nse.continue`**: `Flusher.continueSession`, for a new visit, Reopen, Restore Session, and a reload that finds its own journal unapplied or continues its recovery session. `fromTime` is the parent's `updatedAt`; after a lost head race (`Flusher.fork`) it is the stored head's last entry time.
- **`nse.file.save`**: `saveOperation` (`src/editor/save/flow.ts`), reserved with `Flusher.reserveSave` and written by `endSave` at the reserved `seq`; an own completed Save recognised later writes none (section 2.7). The `save` History action kind (`markFileEvent`) has no producer, so a spec reaches the entry through a real Save with the test pickers. **`nse.file.export`**: `markExported` after an Export (`src/editor/commands/exportLevel/`).
- **`nse.restore`**: `restoreEntry` through `PeekEffects.restoredOperation` (`src/editor/peek.ts`); it carries the restored entry's time, not its key.
- **`nse.recovery`**: journal apply (`writeJournalApply`), the journal-only reload and a taken journal (section 2.9). `droppedSteps` counts the undo steps that could not be kept; the operation factory is in `src/local/start.ts`.
- **`nse.externalChange`**: written by `writeOpenHead` as an `edit` entry before the `continue` entry when a file's `level.json` differs from its history head; the operation comes from `src/editor/commands/open/project.ts`.

### 4.5 Step Details and Timeline grouping

**Step Details** (`StepDetailsModal.vue`; model `OperationDetails` in `operationPresentation/types.ts`, built by `operationDetails` in `details.ts`):

- `description`: the title, as in the Timeline row; for an unsupported step `fallback.text`, with its language marked when it is not the current one.
- `rows`: `counts` (notes, BPM changes, time scales, events, then owners), `change` (label, before, after; dropped when the texts are equal) or `value`. Placeholders ("Not set", "Varies") are drawn quieter. Rows show only what the title does not say.
- `facts`: sentences after the rows; "Name shortened for display" comes last when any name in `data` was cut.
- `note`: why nothing more is shown for a newer or unreadable step.
- `steps`: a group's, undo's or redo's member steps, newest first; `recovery`: the recovery context.

**Grouping.** `operationGroup` (`src/history/operations/grouping.ts`) gives an operation a `GroupDescriptor {key, family, subject?, axis?, field?, ..., metric?}`; `key` is `JSON.stringify([family, subject, axis, field, ...identity])`. Adjacent steps with equal keys collapse into one Timeline row, "{n} steps" (chronology, availability and pins are separate gates). A `metric` lets the title sum ("Duplicated 3 groups"); a total past safe integers falls back to the `history.summary.*` strings. Group Details show net rows: the first `before` to the last `after`. An id without a descriptor never groups. An `undo` or `redo` entry shows the crossed step's line with "Undo ·" or "Redo ·", and a run of them is one parent listing its steps.

### 4.6 Peek, Go To and Restore

- **Peek** (`peekEntry`, `src/history/peek.ts`) shows an entry's state read-only in place of the live one. It starts at once over what is shown, then loads from memory when the tab holds the state (a pending or memory-only entry, a loaded slot), else from the stored snapshot, read and verified in the worker (`createPeekSource`, `src/local/peekSource.ts`). A request within 100 ms of the last waits; a spinner shows after 150 ms; the cache holds 8. A failure gives a `PeekError`: `missing` (no source, no row, no snapshot), `removed` (a `kept: false` row whose root is gone), `damaged` (a part missing or failing its hash, or a kept row whose root is gone) or `newer` (a root from a newer version). While peeking `liveState` stays the live chart, so writers never see the peeked one, and every edit is refused ("Read-only while viewing history"). Nothing peeked reaches storage or a file.
- **Go To** (`GoToList.vue`, `GoToPopover.vue`) is the Timeline's jump list: Now, then days newest first with their sessions; a day of one session is one row, and a day whose rows come back lower in the Timeline is listed again there. Counts are the steps under that day's headers, and steps not stored yet count too: Go To adds the Timeline's own entries above the newest one its index covers (`composeGoTo`, `src/calendar/goTo.ts`). The index is cached per start, filter, zone and `goToStamp` (the newest stored entry of the open session that is loaded; after a jump, the count of the Timeline's reads that have landed), so it is read again after each; an index read while an import fills the path is not kept, and Go To reads again when it next opens. While filtering it lists and counts saves and exports. The Timeline reads entries 100 at a time, newest first, with the open session's unstored entries on top (`src/editor/history/source.ts`, `src/local/worker/timelineHandlers.ts`). Reading with a kind filter reads every entry of a session, as no index holds the kind, and is not bounded: on a very long chain it can outlast the call's timeout, and Go To then fails and can be tried again (nothing is written).
- **Edits Here** scans the chain for edits in the chosen range once (`scanHere`, `hereRange`) and then checks for entries stored since (`checkNewer`). One check runs at a time for every list following (the panel and the dialog share it); a request during a check runs once more after it, and a match already listed is never listed twice. A closed list stops its follow timer. Without a storage worker the search cannot run and offers no Try Again.
- **Row marks.** A row reads removed when its entry is `kept: false` and not damaged or newer, or when a peek or Restore found it removed after the row was read (`removedEntries`, `buildRows`); damaged and newer marks come the same way (`markFailed`). A peek or Restore of an entry not stored yet is told but marks nothing.
- **Restore** (`restoreEntry`) loads the entry, leaves any peek, and pushes its chart, offset and level info with the current audio as a `restore` step (`nse.restore`); "Already matches the current chart" when equal by snapshot. It is cancelled, pushing nothing, if while it loaded the stack, the source, the live state or a peek changed, another Restore started, an Undo or Redo was requested, or any History action other than `save`, `export` or its own fired. A load failure goes to its `onFailure` callback (it throws without one).

## 5. Invariants and safety rules

Each rule says what must never happen, where the code enforces it and the tests that guard it. A change that breaks one needs the owner's decision first. Test paths are under `tests/`.

### 5.1 The stack and the chart

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A published state is never changed in place. | `src/history/freeze.ts` | `local/flush/freeze.test.ts` |
| An unchanged chart pushes no step; a doubt counts as different; Restore always pushes; a selection change never makes a step. | `pushState`, `sameChart` | `editor/noOpSteps.test.ts` |
| Nothing edits while peeking: every edit path calls `refuseWhilePeeking` and returns, `pushState` throws outside release builds, and writers read `liveState`. | callers, `pushState` | `editor/peekGate.test.ts`, `editor/peek.test.ts`, browser `peek.spec.ts` |
| An edit or a peek cancels queued Undo and Redo, so a move never lands after an edit; a failed slot load cancels and a later press retries. | `cancelPendingMoves`, `settle` | `local/timeline/queuedMoves.test.ts`, `local/timeline/history.test.ts` |
| A restored slot loads verified; a missing, damaged or newer snapshot fails the load. | `slotLoader`, `readStoredState` | `local/flush/verifiedRead.test.ts` |
| Restore is an undoable step and is cancelled, pushing nothing, when anything it depends on changed while it loaded. | `restoreEntry` | `editor/peek.test.ts`, browser `historyRestoreFailure.spec.ts`, `historyRowRestoreOwnership.spec.ts` |
| A peek or Restore that finds its entry removed, damaged or newer marks that row, and says so unless the row already does; an entry not stored yet is told and marked nothing. | `markFailed`, `reportFailure`, `buildRows` (`removed`) | `editor/timelineRows.test.ts`, browser `historyRestoreFailure.spec.ts` |
| Edits Here checks for newer entries once at a time for every list following, lists a match once, and a closed list does not read again. | `checkNewer`, `followEntries` | browser `historyChanges.spec.ts` |

### 5.2 Operations

| Rule | Enforced by | Tests |
| --- | --- | --- |
| An operation is a description: never replayed, never a proof of content, an authorization or a GC root. | Undo and Redo only move the index | `local/timeline/history.test.ts`, `editor/historyOperations.test.ts` |
| Native data is captured as plain JSON within 64 KiB and depth 16 (finite numbers, no lone surrogates, no getters) and must pass its codec, or `createOperation` throws before `pushState`. | `captureJson`, `createOperation` | `editor/historyOperations.test.ts`, `editor/historyCodecTable.test.ts` |
| An unknown id, version or field is kept whole and rendered by its `fallback`; no Save, import or retention strips it. | `decodeOperation`, strict codecs | `editor/historyOperations.test.ts`, `historyOperationPresentation.test.ts`, `local/nxsp/read.test.ts` |
| Every id has a codec row, a receipt test and a Step Details case. | `Record<OperationId, …>` types and coverage asserts | `editor/historyCodecTable.test.ts`, `historyProducerReceipts.test.ts`, `historyOperationPresentation.test.ts` |

### 5.3 Storing

| Rule | Enforced by | Tests |
| --- | --- | --- |
| Entries stay pending until the worker acknowledges their transaction; a failed or killed flush loses nothing; a re-sent batch stores nothing twice. | `Flusher`, `writeFlush` | `local/flush/flush.test.ts`, `worker.test.ts`, `early.test.ts`, `earlyChurn.test.ts` |
| A flush that finds a reused chunk missing, or its session no longer the head, writes nothing. | `writeFlush` (closure check, head check) | `local/flush/flush.test.ts` ("an epoch change …") |
| An acknowledgement removes exactly the entries it was for, by identity, never by count or position; an entry that joined `pending` inside the sent range (a worker restart's re-send) stays until a batch of its own stores it. | `acknowledge` | `local/flush/flush.test.ts` |
| A session's rows are created only above its `lastSeq`, by its one writer, so every `seq` at or below it is final; an open's import while `importPending` is the one exception. A flush that finds an entry at or below `lastSeq` without a row stores it and reports the breach. | `writeFlush` (`orderBreach`) | `local/flush/saveEntry.test.ts`, `sessionModel.*.test.ts`, the transition check |
| A chunk is verified on write (deflate, strict inflate, rehash); a bad deflate fails the flush, puts nothing and pauses storing. A chunk row's CRC covers its key. | `verifyChunk`, `putChunk`, `isChunkRowIntact` | `local/records/chunkVerify.test.ts`, `putChunk.test.ts`, `rows.test.ts`, `local/flush/flush.test.ts` |
| A hash is over canonical bytes, never deflated bytes; the schema is the single source. | `canonical.ts`, `hash.ts`, `schema.ts` | `local/records/canonical.test.ts`, `hash.test.ts`, `schema.test.ts`, `fields.test.ts`, `golden.test.ts` |
| The stored stack equals the replay of its entries; a stack the page cannot follow is removed and rewritten whole, never left behind `lastSeq`. | `SessionStack`, `stackViolations` | `local/timeline/stack.test.ts`, `timeline.test.ts`, `local/journal/stackRemoved.test.ts`, `local/fuzz/fuzz.test.ts` |
| Entry times strictly increase across flushes and tabs; outside times are clamped. | `nextTime`, `clampTime` | `local/time.test.ts`, `local/flush/flush.test.ts` |
| In a session of its own rows, times never decrease along `seq` and a `continue` row is only the lowest (`storedViolations`); a session's origin never changes and a file's rows go only into a session of a file origin that the same writer created. | `sessionViolations`, `ORIGIN_RULE` | `local/testing/sessionInvariants.test.ts`, `local/flush/originStable.test.ts` |
| A piece is a run of adjacent entries of one session and one local day, dividers left out; the worker's index, the page's Go To and the Timeline's header days agree. | `piecesOf`, `daysOf`, `readTimelineIndex`, `buildRows` | `editor/calendar/pieces.test.ts`, `local/timeline/indexEquivalence.test.ts`, `editor/goToAgreement.test.ts`, `local/startup/timelineRead.test.ts` |
| Local days, hours and minutes are a function of a time and a zone, total and monotone from 2011 on. | `calendar.ts` | `editor/calendar/zones.test.ts`, `total.test.ts` |
| A storage read that fails is never shown as none: the reads whose empty answer a caller acts on return their value or the failure, and each caller decides what a failure means. | `storedRead` | `local/storedRead.test.ts`, `local/storedReadClasses.test.ts` |
| Row updates are field-level. | `updated` in `flushWrite.ts` | `local/flush/flush.test.ts` ("row updates are field-level") |
| One writer per session: the tab holds the session lock; a continuation moves the head by compare-and-set; the loser forks without the binding. | `src/local/sessions.ts`, `writeFlush`, `Flusher.fork` | `local/flush/sessions.test.ts`, `local/startup/chains.test.ts` |
| Stored text has no lone surrogate. | `toWellFormed` | `local/flush/wellFormed.test.ts` |
| After a kill at any await: no dangling `refs`, no half-deleted chain, every row reachable, the stored stack equal to replay. | `storedViolations` (`src/local/testing/invariants.ts`) | `local/testing/testCore.test.ts`, `local/fuzz/fuzz.test.ts` |
| A transaction that names a store the database lacks fails, and no handle or row is dropped for it. | `UPGRADES`, `StorageCore` | `local/handshake.test.ts`, `local/formatVersions.test.ts`, browser `storageHandshake.spec.ts` |
| A start listener that throws never stops the others or the storing setup; a cancelled one never runs. | `notifyFlusherStart`, `onFlusherStart` | `local/flusherStart.test.ts` |
| Every session lock has one owner at a time and passes only where the flusher takes it at registration; its creator releases it otherwise. | `LockLease` (`src/local/sessions.ts`), `Flusher` registration | `local/startup/leases.test.ts`, `local/startup/open.test.ts`, `local/leaseGuard.test.ts` |

### 5.4 Newer data

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A newer session `v`, an unknown entry kind or a root `v` above `RECORDS_V` is "Needs a newer version", never damage: never continued, restored, reduced, saved or rewritten, and a chain holding one is refused whole. An older or malformed `v` is not newer and not read. | `sessionReadability`, `checkReadable`, `ModelError` | `local/records/unknownValues.test.ts`, `local/save/versionGuards.test.ts`, `local/journal/replay.test.ts` |
| Version constants and tables are pinned. | — | `local/formatVersions.test.ts` |
| An `x` follows one rule on every carrier (a JSON object, at most 256 KiB, at most 32 levels below it, damage otherwise whatever `patch` says) and is never counted in its host's caps; a writer writes the lowest `minor` and `patch` the content needs. | `isExtensionValue`, `withoutExtension`, `minorOf`, `patchOf`, `nxsp_check.py` (`extension_form`, `expected_minor`, `expected_patch`) | `editor/historyOperations.test.ts`, `local/nxsp/agreement.test.ts`, `checker.test.ts`, `local/formatVersions.test.ts` |

### 5.5 Journal and recovery

| Rule | Enforced by | Tests |
| --- | --- | --- |
| The journal is written synchronously on hide, pagehide, beforeunload and freeze and verified by reading back; one write per `seq`; a key is cleared only after a strict commit covers it. | `JournalWriter` | `local/journal/writer.test.ts`, `durable.test.ts`, browser `journalTiming.spec.ts`, `journalKill.spec.ts` |
| A page never replaces or clears a key it neither wrote nor loaded; a write past a size limit is not made. | `storageJournalStore` | `local/startup/open.test.ts`, `local/journal/writer.test.ts` |
| A journal names only an entry the session holds: a page with nothing unflushed writes none, whatever `nextSeq` is, and a journal-only reload numbers past a Save's marker. | `Flusher.newestSeq` (`entrySeq`), `Flusher.resumeJournalled` | `local/journal/phantom.test.ts` (resume past a marker) |
| A journal is applied once, whole or not at all; a covered journal is deleted without an entry, after a strict commit of the replay transaction (it writes a `meta.maxSeenTime` row) so the covering flush is durable before the key goes; one that cannot be applied becomes a recovery session before its key goes. | `writeJournalApply` | `local/journal/replay.test.ts`, `local/startup/guards.test.ts`, `recovery.test.ts` |
| A newer journal is left in place; an unreadable one keeps its bytes in `recovered`. | `readJournal`, `keepRecovered` | `local/journal/replay.test.ts`, `local/fuzz/fuzz.test.ts` |
| The journal's level data round-trips, so the recovered state hashes as the stack around it. | `journalContent`, `withJournalIds` | `local/journal/content.test.ts`, `structuredMetadata.test.ts` |

### 5.6 Save and open

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A write-back never drops a version: an append copies the source's segments and `chunks.bin` prefix unchanged and is asserted; a row whose state is not held is written `kept: false`, never filtered. | `planSave`, `assertAppend` | `local/save/assert.test.ts`, `model.test.ts`, `history.test.ts`, `local/nxsp/build.test.ts` |
| `completeFrom` carries only when the chain still holds the base's rows up to its cut, its own `save` entry among them, and the cut isn't `inexact`; the line says "were not kept" only for steps known missing, else "may not be included". | `carryStatus`, `stepsLine` | `local/save/carry.test.ts`, `model.test.ts` |
| A file is bound to at most one chain, and is never both bound and another chain's Export target; a pick that takes a file revokes the other binding inside `nse-bind` (a revocation storage could not take waits in `revoke.<chainId>`, R11). | `takeOver`, `applyRevocation` | `editor/saveMatrix/invariants.ts` (I9), `editor/saveMatrix/detectors.test.ts` |
| A binding is stored with its marks in one transaction; a binding taken over meanwhile is dropped. | `commitIdentity`, `unitApplies` | `local/save/carry.test.ts`, `versionGuards.test.ts`, `local/flush/saveEntry.test.ts` |
| Our own completed Save records its binding alone, from the chain's head, over the binding it started from, never while the chain imports; it writes no entry. | `recordOwnSave` | `local/save/bind.test.ts`, browser `saveCrashes.spec.ts`, `saveCore.spec.ts` |
| A reservation ends by object identity: a stale end never ends a later Save's reservation that reused its `seq`. | `Flusher.endSave`, `Flusher.release` | `local/flush/endSave.test.ts`, `structuredGuards.test.ts`, browser `saveOwnFile.spec.ts` (ADV-5) |
| Every Save and Export picker that may return the chain's own file has a read of it first, and Choose Another… repeats the same Save with its own read; the read is whole, only when storage lacks something or the file is not at the base. | `pickAndWrite`, `preRead`, Export's read (`startExportRead`, `exportPickerOpening`) | browser `saveOwnFile.spec.ts`, `saveReadFirst.spec.ts`, `local/save/selfPick.test.ts` |
| The bytes read from the own file go back while it is empty, under the pick's `nse-bind` exclusive lock, on every ending but a write and on a throw; bytes that cannot go back are offered as a download. | `keepingOwn`, `putBack` | browser `saveOwnFile.spec.ts` (ADV-3, SF2-4) |
| A failed own-file rebuild is tried once more; with nothing read, the build made before the picker is written only when it is a `copy` with the file's History and BGM, else the file stays empty and the failure is shown. | `afterPick` (`own`) | browser `saveReadFirst.spec.ts` |
| Repair at save stores again only a body that is missing or fails its check, verified against its key (a chunk by inflate and hash, a root or kind node by schema and hash, media by its whole `sha256`), bottom-up and only once everything it reaches is whole; it never clears a mark. | `repairFromSource` | `local/save/selfPick.test.ts` |
| A Save waits for an open's import by storage's `importPending`, never shows a count counted during it, and says the file is not read completely if the resume never starts. | `waitForChainImports`, `importEnded`, the Save dialog's estimate `load` | browser `saveOwnFile.spec.ts` (SF2-5, SF2-6) |
| A stored row without a note count reads without one, never as 0; a Save writes the count of the root it verified, else none. A file entry without one is read and imported without one, and the checker accepts it. | `readEntryRow`, `countOf`, `checkEntry`, `entryRow` | `local/save/noteCount.test.ts`, `local/open/import.test.ts`, `local/nxsp/agreement.test.ts` |
| Damage found in storage is marked one-way and the Save goes on with the line; a damaged head refuses. | `markDamaged` | `local/save/model.test.ts` |
| A built file is verified against its plan before it is handed over. | `src/local/save/verify.ts` | `local/save/model.test.ts` |
| An open stores its head at once, then imports in batches; a failing chunk marks its rows and, from the chain's own unchanged file, unlinks the chain; an abandoned import never lets a later Save carry the file. | `src/local/open/` | `local/open/import.test.ts`, `decide.test.ts` |
| Open reads strictly and never writes over a file it opened partial; two independent readers agree on every probe. | `readNxsp`, `nxsp_check.py` | `local/nxsp/read.test.ts`, `agreement.test.ts`, `checker.test.ts`, `local/fuzz/fuzz.test.ts` |
| A plan builds the same bytes in any implementation. | `planNxsp`, `execute.ts` | `local/nxsp/golden.test.ts`, `zip/planConformance.test.ts` |
| Peek says "removed", "damaged" or "newer", never shows a wrong state. | `PeekError`, `peekSource.ts` | `local/flush/verifiedRead.test.ts`, `editor/peek.test.ts`, browser `historyRestoreFailure.spec.ts` (damaged) |

### 5.7 What must never happen

- Silently dropping a step, a session or a chunk: a missing part is marked and shown, not filtered.
- Calling newer data damaged, or rewriting it.
- Storing a binding without its marks, or a file event ahead of its reserved `seq`, or a `save` entry outside the flusher.
- Creating a row of a session at or below its `lastSeq`, or in a session that is no longer its chain's head, outside an open's import.
- Saying Timeline steps were not kept when none is known missing.
- Acknowledging an entry that was not stored, or by count.
- Dropping a write because its store is missing.
- A picker emptying the chain's own file while its bytes are in hand and no read, put-back or download covers them.
- Writing a build made before a picker over the chain's own file when it is not what that path would have written.
- Making up a note count of 0 for a row that does not say.
- Replacing a journal key this page did not write, or clearing one before a strict commit covers it.
- A notice that is not true: a queued Undo reports only when it lands; a step notice only when `pushState` returned `true`.
- Writing from a peeked state, or editing while peeking.
- Changing a published state in place.
- Dropping `extra` keys on a Save (`local/nxsp/roundTrip.test.ts`), or trusting what they or an `x` hold.

## 6. Adding or changing an operation

Before the ship an operation changes in place at version 1; after it, any change to an id's `data` raises that id's `version`, and a new operation takes a new id (format-versioning section 5).

### 6.1 Files to touch

| What | File | Notes |
| --- | --- | --- |
| Codec | `src/history/operations/registry.ts` (`operationCodecs`) | Shared pieces (`nativeCounts`, `ownerReference`, `nameText`, field ids) in `fields.ts`, combinators in `codec.ts`; `NativeOperationInput` follows from the table. Codecs are strict: an unlisted member fails. |
| Grouping | `src/history/operations/grouping.ts` (`operationGroup`) | Family, subject and `metric`; no case means the id never groups. |
| Title | `src/history/operationPresentation/format.ts` (`describeOperation`) | Exhaustive (`never` check). Also becomes the `fallback`. |
| Step Details | `src/history/operationPresentation/details.ts` (`nativeRecord`) | Exhaustive. Rows show only what the title does not say. |
| Group titles | `src/history/operationPresentation/aggregate.ts` | Only for an id with a metric. |
| Strings | `src/i18n/{en,fr,ja,ko,tr,zhs,zht}/index.json` | Titles under `history.operation.*` (`entry.*` for events), labels under `history.details.*` and `historyChanges.*`. All seven locales in one commit, in the style of `en`. |
| Producer | The tool or command (`src/editor/tools/**`, `src/editor/commands/**`, `src/editor/workspace/manager/*.ts`, `src/history/*.ts`) and the receipt builders (`src/state/operations/historyReceipts.ts`, `src/editor/headerLabelText.ts`) | Build `data` from what changed; `pushState(createHistoryOperation(input), state)`; notify only when it returns `true`. A new command goes on a peek list (`tests/editor/peekGate.test.ts`). |
| Event operations | `src/history/markers.ts`, `src/local/storing.ts`, `src/local/start.ts`, `src/local/flush.ts`, `src/local/open/importWrite.ts` | Event kinds come from the storage side, not `pushState`. |
| A new entry kind (rare) | `src/history/operations/entries.ts`, `src/local/records/unknownValues.ts`, `src/local/nxsp/manifest.ts` (`ENTRY_KINDS`), `src/local/timeline.ts` (`replay`, `applyKind`), `MINOR_TABLE.entryKind` | Not an operation: it raises `minor`. |

### 6.2 Tests and fixtures

| Where | What to add |
| --- | --- |
| `tests/editor/historyCodecTable.test.ts` | Valid and invalid `data`; the table is a `Record<OperationId, Row>`, so a missing id fails to compile. |
| `tests/editor/historyOperationDetails.cases.json` and `.snap.txt` | Inventory cases (one, many, zero, huge; `locales: true` adds the en, fr and ja snapshot). Every case renders in all seven locales. A case holds what a producer can emit; one that holds a shape the codec accepts and no producer emits says so in its `note` ("Not produced today"). Regenerate with `UPDATE_SNAPSHOTS=1` and say so in the commit. |
| `tests/editor/historyOperationPresentation.test.ts` | Its fixture must name every id; add title and Details expectations for special rules. |
| `tests/editor/historyProducerReceipts.test.ts` | A receipt test of the producer; the last test requires one for every id, here or in the browser spec it names. |
| `tests/editor/noOpSteps.test.ts` | When the no-op rule changes. |
| `tests/browser/historyNativeProducers.spec.ts`, `historyManagerProducers.spec.ts`, `historySelectionProducers.spec.ts` | The real producer end to end. |
| `tests/editor/localizations.test.ts`, `localizationUsage.test.ts` | Run as is: every locale has every key with the same placeholders, and every key is read. |
| Goldens | Only when an id the golden chain holds (`nse.origin`, `nse.continue`, `nse.file.save`) changes shape; regenerate in format-versioning section 4's order. |

`tools/fields-v1.json` and `tools/nxsp_check.py` do not change for an operation: operations are not records, and the checker only bounds their bytes.

### 6.3 Checklist

1. Decide the id and fields. Put only the description in `data`: counts, subjects, before and after values, captured names. Nothing a replay needs.
2. Add the codec and its codec-table row.
3. Add the `operationGroup` case, the title and the `nativeRecord` (the compiler lists what is missing).
4. Add the strings in all seven locales.
5. Write the producer so an unchanged chart pushes no step: build `data` from the result and let `pushState` compare.
6. Add the receipt test, the inventory cases and the snapshot.
7. If a golden holds the id, regenerate the goldens and run the checker.
8. Update section 4.3 and `CHANGELOG.md` under Unreleased when users see it.
9. Run `npm test`, then the producer's History browser specs.

## 7. Future work

- **Deleting History (Step 8).** GC, Delete Sessions and space reduction are not built: nothing writes `tombstones`, bumps `meta.epoch` (`bumpEpoch` and `missingHashes` in `db.ts` and `observeTimes` in `time.ts` have no callers, and each says so) or marks a row `kept: false` for space. When they land, every deleting transaction must bump the epoch, which the flush's closure check depends on.
- **Level Info (Step 11).** `nse.levelInfo.set` has its codec, presentation, strings and `levelInfoInput`, but no producer until the Level Info dialog. It has no inventory case in `historyOperationDetails.cases.json` yet.
- **Per-id operation versions.** The envelope has one literal `version: 1`. The first change after the ship needs a per-id version table and the old codec kept for reading.
- **Native apps.** The apps' reader and writer are not in this repository (Step 7 is paused); the conformance cases and the checker are what they must match.
