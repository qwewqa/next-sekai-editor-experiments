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
| Flush | `Flusher` (page), `acknowledge`, `prepareFlush` and `writeFlush` (worker), `notifyFlusherStart`; `notDurableReason` (section 2.9) | `src/local/flush.ts`, `src/local/storing.ts`, `src/local/flushWrite.ts`, `src/local/flusherStart.ts`, `src/local/durable.ts`, `src/local/worker/` |
| Stored stack | `SessionStack`, `replay`, `storedWindow` | `src/local/timeline.ts` |
| Database | `STORES_V1`, `meta` rows, `hashKey`; row forms | `src/local/db.ts`, `src/local/records/rows.ts` |
| Storage reads | `storedRead`, `StoredRead`, `COVERED_READS` | `src/local/storedRead.ts` |
| Startup and sessions | `openSession`, `openStored`, session locks, tab record | `src/local/startup/`, `src/local/sessions.ts` |
| Journal | `buildJournal`, `readJournal`, `JournalWriter`, `writeJournalApply` | `src/local/journal/` |
| Save (storage side) | `planSave`, cuts, carry model, marks, identity commit (`commitIdentity`, `recordOwnSave`), repair at save (`repairFromSource`) | `src/local/save/` |
| Save (page side) | `withSaveAttempt` (`saveAttempt.ts`), `withPickSession` (`pickSession.ts`), `exclusive` (`queue.ts`), `pickAndWrite`, `ownCompletedSave`, Save to File… (`writeSessionFile`); Export's pick body on a session (`pickLevelData`, `exportPick.ts`); `waitForChainImports` (`imports.ts`); the binding view (`binding.ts`) | `src/editor/save/flow.ts`, `saveAttempt.ts`, `pickSession.ts`, `exportPick.ts`, `queue.ts`, `binding.ts`, `imports.ts`, `src/editor/commands/exportLevel/` |
| `.nxsp` | `planNxsp`, `readNxsp`, manifest and project forms, version tables | `src/local/nxsp/` |
| Open (import) | `writeOpenHead`, `writeBatch`, `writeUnlink`, `writeAbandon`, the import loop | `src/local/open/` |
| Deleting and retention | `markDeleted`, `undoDeleted`, `sweepDeleted`, `removeTx`, `deleteSessions`, `readDeleteCandidates`, `notSavedToFile`, `gcPass`, `removeCachedMedia`, `relieveAtLoad`, `createRunner`; Export Raw Data… (`buildRawExport`, which reads rows undecoded: it imports no record decoder) | `src/local/deletion.ts`, `removal.ts`, `deleteSessions.ts`, `candidates.ts`, `keptData.ts`, `gc.ts`, `cleanup.ts`, `pressure.ts`, `maintenance.ts`, `rawExport.ts`, `src/editor/settings/SettingsLocalData.vue` |
| Recent Sessions and Level Info | `readRecent` (one row per chain), `restoreStored`, the row's Delete (`sessionDelete.ts`), held media (`heldItemsOf`, the BGM cache `heldBgm.ts`), the Level Info dialog | `src/local/recent.ts`, `src/editor/history/RecentSessionsTab.vue`, `sessions.ts`, `sessionDelete.ts`, `src/editor/restoreStored.ts`, `src/local/heldMedia.ts`, `src/editor/media/heldBgm.ts`, `src/editor/commands/levelInfo/`, `src/editor/levelInfo/` |
| Check File and History… (storage side) | `openFileCheck`, `checkFileChunks`, `openStoredCheck`, `checkStoredRoots`, `finishCheck`, `removeBadMedia`; worker calls `checkFileOpen`, `checkFileBatch`, `checkStoredOpen`, `checkStoredBatch`, `checkFinish`, `checkDrop` | `src/local/check/`, `src/local/worker/checkHandlers.ts` |
| Independent checker | `nxsp_check.py`, `fields-v1.json` | `tools/` |

### 1.2 One edit, end to end

1. A tool or command builds the new `State` and calls `pushState(createHistoryOperation(input), state)`.
2. `pushState` compares the chart with `sameChart` and returns `false`, with no step, when nothing changed (section 4.2).
3. A pushed step emits a `HistoryAction`; `src/local/storing.ts` passes it to `Flusher.append` with the state. `startStoring` ends by calling the `onFlusherStart` listeners (`notifyFlusherStart`), each alone: one that throws is recorded and stops neither the others nor the setup.
4. About 1 s after the last change (`FLUSH_DELAY_MS`), or at once and strictly on hide or freeze, before a session switch and after a media pick, the flusher extracts the snapshot and the storage worker writes chunks, nodes, the root, the entry, the stack blocks and the session and chain rows in one transaction (`writeFlush`). A routine flush commits with `'default'` durability. A hide's, a switch's, a batch that stores media or carries a Save's identity unit, and the first batch of a session that stores at once commit with `'strict'`: Firefox runs `'relaxed'` with `synchronous = OFF`, which a power loss can leave corrupt, and `'default'` is relaxed in Chromium 121 and later.
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
- **Header chunk.** `[initialLife, isDynamicStages, bgmOffset, groups, stages, groupFolders, stageFolders, levelInfo, bgm?]`. Media (BGM, cover, preview) are named by hash inside it and stored in `media`; a state read from storage names its BGM and holds none of its audio (section 2.2, "Held audio").

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

**Held audio** (`src/editor/media/heldBgm.ts`). A state built from records has `bgm.meta` and no `buffer`. The BGM is **held** when this tab has its bytes (`Bgm.source`, or the cache below) or the media store does; only a BGM neither holds is "not loaded".

- **One `Bgm` per hash.** A cache of three entries (least recently used first out, never the live head's hash) holds the decoded buffer, waveform and original bytes. A pick, an opened file's BGM and a read from the store fill it; a new session empties it, since the reset revokes every waveform. The slot loader gives a slot built from records the cached audio of its `meta.hash` (`withCachedBgm`), so Undo and Redo land with audio.
- **The live watcher.** A live state (never a peek) with `bgm.meta` and no `buffer` gets its audio from the cache, else from the media store (`readMedia`, a worker read that re-hashes the bytes and answers nothing for a missing or damaged row), then decodes it. It attaches with `replaceState` only if the session, the hash and "not peeking" are unchanged after the awaits. An attach is no step and no new root (`sameParts` compares the meta by identity), and the file state is unchanged. A read that failed says nothing and is tried again at the next change of the live BGM.
- **The not-loaded notice** is said at most once per hash per session (`claimNotice`), and only after the store answered "absent": by the load notice (a continue, resume or journal), the Open File card, a switch card's second line (`takeBgmLine`), or, for an Undo or Redo that reaches the BGM, a card of its own. A Timeline Restore keeps the current audio (section 4.6), so it never makes another BGM live.
- **Choose Audio…** opens the system chooser and decides on the picked file's hash alone (`decidePick`). The hash the live `meta` names: attach it, keep the recorded `meta` and name, and store the bytes again (`storeMedia`), as no step. Any other hash: one `nse.bgm.change` step, with the offset unchanged.

**Held cover and preview** (`src/local/heldMedia.ts`). A picked cover or preview clip is kept by hash for the tab’s life (`holdMedia`, `heldItem`); the BGM keeps its own rule above. `heldItemsOf(state)` lists the held items the state names (BGM, cover, preview; each hash once, with its slot’s kind), and both the flush (`heldMediaOf`) and a Save’s build (`heldMedia`) read it, so the cover and preview are stored with the entry first naming them, read back, stored again when their row went missing (also when only the live state holds the bytes, `liveHeld`), and written into a file as the BGM is. A state read from storage holds none; `readMedia` brings the bytes back.

`isDirty` means "changed since the last file event": a pushed step is dirty, a `save` entry clean.

### 2.3 IndexedDB stores

Database `nse-local-data`, `DB_VERSION` 1 (`src/local/db.ts`). Upgrades only add stores, indexes and fields: `UPGRADES[1]` creates the whole set when the database is new. A transaction that names a store the database lacks fails: no write becomes a no-op because its store is absent (`handleRows.ts`, the worker's `StorageCore`). Row updates are field-level, so a field a newer build added stays.

| Store | Key | Holds |
| --- | --- | --- |
| `chains` | `chainId`; indexes `updatedAt`, `docId` | One record per chain (section 2.6) |
| `handles` | `[chainId, role]` | File handles (`file`, `exportTarget`, and `kept`: the file a partial or unlinked open came from, while its session is open), kept off the chain record |
| `sessions` | `id`; indexes `updatedAt`, `chainId` | One row per session (section 2.6) |
| `entries` | `[sessionId, seq]` | One row per event (section 2.4) |
| `stackBlocks` | `[sessionId, block]` | The stored undo stack (section 2.5) |
| `nodes`, `chunks` | 16-byte hash | Root and node rows; chunk rows |
| `media` | 16-byte hash | `{blob, sha256, size, type, filename?, kind, day}` |
| `recovered` | `id` | Bytes of journals that could not be read (section 2.9) |
| `userAssets` | `key`; index `type` | Not History |
| `meta` | `key` | `formatVersion`, `epoch`, `maxSeenTime`, `dbInstanceId`, `deviceId`, `daysOfUse`, `lastUseDate`, `lastGcAt`, `deletionsPending`, `migratedHashes`, `createdBy` |

**Deleting.** Rows go only as whole chains, and bodies only by GC and cleanup under pressure (rules R1–R9 in sections 5.3 and 5.4):

- **Delete** (Recent Sessions) marks the chain `deleting: {at}` (`markDeleted`, `src/local/deletion.ts`): it locks every session and import lock of the chain, applies their pending journals, and writes the mark strictly (`markTx`, `src/local/removal.ts`). A marked chain is gone to every reader but GC's mark. Undo clears the mark only while `at` is still its own (`undoTx`). A flush treats a marked chain as not the head (like journal apply), so a continuation that was already reading it forks into a new chain.
- **The sweep** (`sweepDeleted`) removes chains marked about 10 minutes ago through the removal primitive (`removeLocked`): the page locks every session and import of the chain or skips it, and skips it while any of its sessions has a journal key; the worker's one transaction (`removeTx`) re-reads the chain, its sessions and its mark and refuses when anything differs. It deletes the whole chain in that transaction: every session with its entries and stack blocks (and those of a damaged chain's head id that has no session row), the chain record and its `handles`. It sets `deletionsPending`. A removed chain leaves no marker.
- **Delete Sessions…** (`src/local/deleteSessions.ts`) removes whole chains, each through the removal primitive with `reason: 'deleteSessions'`. `readDeleteChoices` reads every unmarked chain in one worker transaction (`deleteCandidates`, `src/local/candidates.ts`) and leaves out the chains whose session or import locks are held now. Per chain it gives the age in whole local calendar days (the page's zone, the worker's `now`), `readable` (`newer` for a session this build cannot read; such a chain is included and removed by key range like any other) and `notSaved` (`notSavedToFile`, `src/local/keptData.ts`: bound and changed, bound by a download not confirmed, unbound with content, or unreadable). `deleteSessions` removes exactly the chains it is given, retrying `busy` about every 200 ms for at most 10 s in all, skips a chain that is open, has a journal or changed since it was read (its head, last write or sessions, or its file binding's `at`, which a takeover changes), then, when something was deleted, runs the orphan reclaim (markers and kept copies of the deleted chains), `gcPass({ always: true })`, and asks storing to try again when it is paused `full`. Settings › Local Data opens it (`DeleteSessionsDialog.vue`, with the pure counts and confirm lines in `deleteChoices.ts`): five ranges, counts that follow the unticked-by-default "work not saved to a file" box, a confirm that names up to three not-saved chains and warns when a newer chain is included. Unlike Delete it has no 10-minute window. Residual: a Restore as a Copy of a chain it then deletes, while storing is paused so the copy's first write has not landed, loses the copy's Undo into the deleted original (its unloaded slots fail; the live state is stored again from memory), and a journal of a continuation of that chain whose session is not yet in it comes back as a recovery chain at the next load.
- **GC** (`gcPass`, `src/local/gc.ts`) marks from every entry's snapshot, every `recovered` entry's pushed snapshots and every stack block's hashes, follows `refs`, and deletes the `nodes`, `chunks` and `media` rows nothing reaches that were first stored at least 2 days of use ago. It runs when `deletionsPending` is set or once per day of use, under one `nse-maint` exclusive hold, and stops as soon as a writer waits, also between the long reads. It is busy while an import is running (an `nse-import:*` lock is held, or the lock query fails): a running import skips bodies already stored that only its later batches reach. An import left pending with no lock held does not hold it up, since a resumed run starts again at batch 0 and stores again whatever was swept. A pass that finds newer data records `lastGcAt` with `unsafe` and waits for the next day of use. It never reads `userAssets` or `recovered`.
- **Cleanup under pressure** (`removeCachedMedia`, `src/local/cleanup.ts`) removes cached earlier media only, never a Timeline row, session or chain. In one transaction under `nse-maint` exclusive it reads every chain's head (marked chains included, since Undo brings them back), that session's head slot root (`headOf`, or its last entry's snapshot when its stack was removed) and its `refs`, then deletes the other `media` rows first stored at least 2 days of use ago, largest first, until the bytes asked for are freed, with an epoch bump. Reading the heads in the removing transaction means a flush that made a BGM current just before keeps it. It removes nothing while `meta.formatVersion`, a session or a head root is newer, and is busy while an import is running. The page (`src/local/pressure.ts`) runs it at load idle after GC when `estimate()` reports more than 80% of the quota (down to 70%), and when storing turns paused `full`: a round of at least 64 MiB, then Try Again (`retryStoring`), repeated while storing is still paused full and a round removed something. Beyond that storing stays paused with its usual signs, and the user frees space by hand. An earlier step whose BGM went says "BGM not loaded" with Choose Audio…; the open tab's own audio and the flush's re-store of held media cover a BGM in use: each flush checks the media its batch's states name and this tab holds against the store, the live state's included (bytes the BGM cache attached after an Undo, with no step; `liveHeld`), and stores a missing one again.
- **Check File and History…** removes a media row that still fails its re-hash inside the same exclusive hold (section 2.8), with no epoch bump, since every flush checks media by key.
- **When.** The maintenance runner (`src/local/maintenance.ts`) runs the reclaim, the sweep, GC (the one GC call, due through `deletionsPending`) and the load's pressure check at load idle once the page is visible, on becoming visible (at most once a minute), when a mark falls due, when storing turns paused `full` (with the cleanup's rounds), and 30 s after a run that found `nse-maint` held or GC or cleanup busy or stopped. A load that arrives during a run keeps its pressure check for the run queued behind it. At load it also asks `navigator.storage.persist()` wherever the browser has it, Firefox included, never awaited; a refusal changes nothing. It starts only with Web Locks. The reclaim (`reclaimOrphans`, `src/editor/save/env.ts`) removes a deleted chain's `saving.*` marker and `nse-kept` copy once a record read finds no chain.
- **The nearly-full notice** (`announceNearlyFull`, `src/local/start.ts`; `noticeIfNearlyFull`, `src/local/nearlyFull.ts`). After the load's maintenance run, usage still above `HIGH_SHARE` of the quota adds the load notice "Browser storage is almost full." with [Local Data]. It shows only while the start-up notice is current (`startupNoticeCurrent`, `src/editor/notification.ts`, the rule for every load notice found after the startup gate lifts): on its card, or on the quick start-up toast of a clean load while the page is under 12 s old and nothing was edited, undone, redone or restored. It never shows on the faint text that follows, never mid-edit, and at most once per calendar day (`nearlyFullDay` in `localStorage`, stamped when the notice is added). It is skipped when the page was hidden at load, in `?safe`, when storing is paused or unavailable (the chip's dialog covers those), and when `journalsFull` or `journalFailed` shows.

`meta.epoch` rises in every GC or cleanup transaction that deletes a node, chunk or media row (Check's media removal needs none, above). Each flush records the `(dbInstanceId, epoch)` at which it knew a chunk was stored, and `writeFlush` re-checks with `getKey` every reused chunk not known at the current pair, so a hash GC removed is stored again. The Timeline’s "not kept" label comes from `kept: false` rows.

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
| `stack`, `lastSeq`, `entryCount`, `activeMs`, `view`, `day`, `appVersion` | Window, the `lastSeq` mark (section 2.5), counts, active time, the Timeline's view, the writer's version. |
| `importPending` | An open's background import is unfinished. A Save waits for it, and for every other import of its chain, in "Preparing…" (`waitForChainImports`, section 3.5); the build refuses (`importing`) while it is set. |

The chain record (`chains`):

- Identity: `chainId`, `head` (the head session), `docId` (`project.json` `id`), `lineageId` (provenance), `sourceName`, `name` (automatic: a copy's "(2)", "(3)", or the stem of a file the chain lost: `writeUnlink`, `takeOver`), `renames`, `exportName`.
- File: `file {name, event, at, hash, entry, completeFrom, disk, confirmed}` (handle in `handles`), `revision {id, n, ancestors}`, `replaced {by, at, name}` after a takeover, `extra` (unknown `project.json` keys, written back by Save), `exportTarget` (handle in `handles`).
- Flags and display: `hasContent`, `edited`, `partialImport`, `summary {title, artists, author, rating, tags, bgmName, noteCount}`, `badChunks`, `deleting` (`{at}`: marked for Delete, section 2.3), `startedAt` (the chain's first start, set by every maker of a record, a fork's its own: it dates an untitled name, so a later visit does not rename it; `chainStartOf` falls back to the head session's), `updatedAt`, `day`, `appVersion`.

The `summary` is IndexedDB-only (no file carries it) and is written with the head's state by every writer of a chain record. `bgmName` is the head's BGM file name (`meta.filename`, else the buffer's): a stored chain has no state, and the displayed name falls back to the BGM's stem (section 1.3.5), so without it a chart named by its song would be called "Untitled" in Recent Sessions once left. `noteCount` absent means unknown, never 0.

**Recent Sessions' list** (`listRecent`, `src/local/recent.ts`; a covered `storedRead`, so a failed read is a failure, never an empty list) is read in one transaction in the storage worker: every chain in `updatedAt` order, newest first, except those with a `deleting` mark. A row has the chain's id and `updatedAt`, its head session (`sessionId`, `lastSeq`, and `startedAt`, which is the chain's first start), the name parts (`namePartsOf` with the summary's `bgmName`), the bound `file` (`name`, `event`, `at`, `confirmed`), `changed` (the head's root against `file.hash`; a file without a hash is changed, as for an earlier chain at an open), `noteCount` and `readable`: `newer` when any session of the chain has a newer `v`, `damaged` when one has an unsupported `v` or the head's row is missing. Such rows are listed, never hidden. A flush that makes a chain record or moves its head (a continuation's or fork's first write) reports `chainMoved`, which the flusher passes to `onChainMoved` so the page can tell other tabs' lists (`sessionUpdated`).

**Continuing.** A continuation stores nothing and holds a shared lock on its parent until its first write, which moves the chain's `head` from the parent to it only if the parent is still the head (a compare-and-set in `writeFlush`). Each open session holds an exclusive Web Lock (`src/local/sessions.ts`); a tab never writes a session it does not hold.

**Forking.** `openSession` (`src/local/startup/api.ts`) opens a stored session as a fork when it is opened as a copy (Restore as a Copy), another tab holds its lock, the parent lock cannot be had, it is no longer the head, or its file is bound by another chain. A continuation that loses the head race forks too (`Flusher.fork`). `OpenResult` says whether it opened as a copy (`forked`) or why it did not (`why`). In safe mode (`?safe`) it only reads: the exclusive lock and the journal replay are skipped (a replay is a write), it always forks, and the in-memory flusher stores nothing. A Duplicate Tab copies the tab record in `sessionStorage` (`src/local/startup/tab.ts`); `claimTab` calls it a reload when the session lock is free and a duplicate otherwise, and a duplicate forks (without Web Locks, the `unloaded` marker in `sessionStorage` decides). A fork is a new chain with a new `chainId` and `docId`, copied by exclusion (`forkRecord`, `src/local/chainFields.ts`) so fields a newer build added carry: it drops `file`, `exportTarget`, `exportName`, `edited` and `replaced` and the chain's own `head`, `updatedAt`, `day`, `deleting` and `appVersion`, and keeps the rest, `revision` and `extra` included.

### 2.7 Save entries and revisions

A `save` entry records one Save: `operation` `nse.file.save`, `revisionId` (the `project.json` revision written), `device {id, label}` (the file's `revision.device`) and `appVersion` (which an append would otherwise lose, since `project.json` holds only the last writer's). Its snapshot is the head at the time. `savedAt` is not on the entry; it is `revision.savedAt` in `project.json` (format-versioning section 6; written by `savedAtOf`, read by `parseSavedAt`).

**The device is per document.** The browser's own `deviceId` (localStorage, kept in `meta` too) never goes into a file. A Save gives the build `deviceSource()` (`src/editor/save/env.ts`), and the build records `documentDevice(source, chain.lineageId)` (`src/local/deviceId.ts`): HMAC-SHA-256 of the lineage under `deviceId`, as a UUID version 8. The Save core commits the build's `saveEntry.device`, so the entry, the marker and the file agree. A device id is compared only within a lineage, by `ownDeviceId(lineageId)`: the Timeline names a save whose device is not this browser's for the open session's lineage, which every session the Timeline lists shares; recognising our own completed Save and confirming downloads use the file's own `lineageId`. Save As… and forks keep the lineage, so this browser's earlier rows stay its own; two documents of different lineages carry ids that do not link them to one browser.

A Save reserves its entry's `seq` before building the file (`Flusher.reserveSave`), so edits made meanwhile take later numbers and wait. Its **identity unit** (`docId`, `revision`, `file` with `entry`, `completeFrom` and `disk`, and the marks the write made) is committed in one transaction with the entry, so a binding is never stored without its marks (`commitIdentity`, `src/local/save/commit.ts`). A reservation is the object `reserveSave` returned: `endSave` ends it once and says what it did (`EndSaveResult`), and does nothing for one already ended, so a stale `finally` never ends a later Save's reservation that reused the `seq` (`Flusher.release`). Every Save of the Save family (the write-back, Replace, Download Again, and the first Save, Save As…, Save as a Separate File and the not-found Save As… through the pick session) runs in one Save attempt (`src/editor/save/saveAttempt.ts`), which takes the reservation with the state it saves in one step and ends it exactly once. Export's pick and Save to File… run in one too: Export takes a reservation only when it writes the chain's own project again (`PickedFile.reserve`), and Save to File… takes none.

The `save` entry has one writer: `endSave` adds it to `pending` at the reserved `seq`, and the flusher stores it with the identity unit. **Our own completed Save** (a file this chain wrote whose binding was not recorded, found later from the marker kept before the write; `ownCompletedSave`) writes no entry: `recordOwnSave` (`src/local/save/bind.ts`) stores the binding with its marks in one strict transaction, from the chain's head, while the record still holds the binding the Save started from and no session of the chain imports. The cut is the file's and counts the `save` row, so the next write that is not an append says "Some earlier Timeline steps may not be included." once (section 2.8). No state is lost: the row's state is the one before it.

### 2.8 Cuts, `completeFrom`, `kept` and `badChunks`

- **The read cut.** A write reads the chain, its sessions, their entries and the saved session's stack blocks in one read-only transaction (`readCut`, `src/local/save/cut.ts`). Bodies (roots, nodes, chunks) are immutable and follow in later transactions. An entry that does not read is counted in `unreadable` and the write refuses (`needsNewer`).
- **The binding's cut.** `file.entry` is `{sessionId, seq, startedAt, count, notKept}`: the last chain row the file holds, its session's start, the file's row count and how many of those rows' states it lacks. `inexact: true` when its write appended to a base whose cut was inexact, or whose cut's session is stored but lacks its own `save` entry at the cut or holds another row there. "Later than the cut" (`isLater`) needs only the binding, so it holds after the session is deleted. A Save without History stores no cut, and an open of a file without history stores count 0. One predicate, `bindingHasHistory` (`file.entry` with `count > 0`, `src/local/save/model.ts`), decides "the base had history" everywhere: the carry test (`baseHadHistory` in `build.ts`), the Replace guard (`replaceDecision`), `baseFacts`, `keptRowsNeed`, `readSaveNeeds`, the Save dialog and the own-file pick (`src/editor/save/flow.ts`).
- **The stack's cut.** The file's undo stack is the longest run of held slots around the index (`cutStack`), renumbered by replay of the written chronology (`renumbering`); if replay cannot follow it, the stack is the head only.
- **`completeFrom`.** `revision.completeFrom` names the oldest revision whose history the file holds whole. An append copies the source's. Any other history write carries the base's value only when the base binding had history and the **carry test** passes (`carryStatus`, `src/local/save/model.ts`): the cut isn't `inexact`, the chain holds the cut's own row (kind `save`, `revisionId` the chain's `revision.id`), the chain's rows up to the binding's cut still number `entry.count`, and the flagged rows among them whose state no unflagged row shares still number `entry.notKept`. Both sets only grow, so equal counts mean equal sets. When it fails, the line says "were not kept" only for steps known missing (rows of the base's file gone from the chain, or, with the own row and the count matching, more of their states lacking from the write than `notKept`), else "may not be included" (`stepsLine`). A flag alone is never known missing. The Replace guard says "holds" only when rows are gone.
- **`kept: false`.** The row's state is not held whole: a Save, or Check File and History… after its repair, found a part missing or failing in storage (`markDamaged`, `src/local/save/mark.ts`), an open's import could not bring it (`writeAbandon`, `writeUnlink`), or the file lacked it. The mark is one-way. The row stays in the Timeline, marked not kept or damaged. A flagged row's state is still written to a file when storage holds it whole. A peek or Restore that finds a row's root gone marks the row not kept in the Timeline for this tab (`removedEntries`, `src/editor/history/selection.ts`), as a failed one marks it damaged or newer.
- **`badChunks`.** The chain's packed hashes of parts found bad, for the "damaged" label. Display only; it never shrinks.
- **Kept bytes** are different: a file's bytes kept by a partial or unlinked open so a save picker can restore it (`src/local/open/kept.ts`, OPFS folder `nse-kept`).
- **Repair at save.** Damage a build found (`badChunks`) is put right from the chain's own file when an append is built, after the build is checked (`repairFromSource`, `src/local/save/repair.ts`, called by `buildSave`). Every repair is content-addressed and verified against its key, so it can only repair, and only a row that is missing or fails its own check is replaced: a chunk must inflate strictly and hash to its key (`verifyChunk`, `putChunk`); a root or kind node's JSON form must pass its schema and hash to its key; a media item's bytes must hash to its whole `sha256` (only from a STORE entry of at most 64 MiB, `REPAIR_MEDIA_CAP`). It runs bottom-up: chunks, then depth-0 nodes, depth-1 nodes and roots, each stored only once everything it reaches is whole in storage (`closureBad`), so a state that is not whole never appears; a root's media come from its header chunk as storage holds it. Each kind is tried alone, and a failure is only logged. A repair never clears a mark, and what is stored again is what the next dialog no longer counts as short.
- **Check File and History…** (`src/local/check/`, worker `checkHandlers.ts`). The page runs it in its Save queue, after the chain's imports, holding `nse-maint` shared through the file and stored phases. The **file phase** reads the bound file as an open does (`readNxsp`; `damaged`, `history-unreadable` and `media-unreadable` make it damaged, a newer reason leaves it unchecked), then inflates and hashes every chunk in `chunks.bin`, with no stored shortcut. The **stored phase** reads the cut and runs `loadBodies` over the roots of every kept row (snapshots and recovered pushes) in all the chain's sessions, skipping a session whose import is pending, 256 roots a batch; a whole state's header media are re-hashed, and a present row that fails is bad media (a missing one is "not loaded"). A chain with a row or session this build can't read is refused, never judged. Nothing is written until the **finish**, which the page calls after releasing its hold: repair from the file (`repairFromSource` with the check's own `bad` set, in place of `badChunks`), `loadBodies` again over the states that were not whole, `markDamaged` for the rows whose states still are not (with the hashes still bad), then each media row still bad is re-hashed under `nse-maint` exclusive (`core.exclusive`, up to six tries 200 ms apart) and deleted only if it still fails. That delete is a write through the exclusive hold (`hold.write`): it takes no shared hold behind its own exclusive one. In read-only storage (`?safe`) the finish writes nothing and reports the same.

### 2.9 The journal and recovery

The journal is the last-chance copy of an open session whose entries are not yet committed to the database (`src/local/journal/`).

- **Where.** One `localStorage` key per session, `<prefix>journal.<sessionId>`, overwritten on each write and verified by reading back. A key holds at most 1 MiB (`JOURNAL_KEY_LIMIT`) and all `journal.*` keys and the old auto save at most 4 MiB, counted in characters. A write that does not fit trims the optional recovery context; otherwise it is not made (`writeWhole`, `store.ts`). A page never replaces a key whose text it neither wrote nor loaded.
- **When.** Synchronously on hide, pagehide, beforeunload and freeze while the session has entries not committed to the database (still to send, in flight, failed, or acknowledged only by the worker's in-memory store), and every 10 s while storage is unavailable (`IDLE_JOURNAL_MS`). A second trigger for the same `seq` writes nothing. A key is cleared once any commit to the database covers its `seq` (`Flusher.unflushed` compares `ackedSeq`; `JournalWriter.committed`); a commit into memory clears nothing. The hide's and a switch's flush still end with a strict commit (`syncStrict`), so what routine flushes stored is on disk once the page hides, where the browser honours `durability` (not Firefox before 126). Residual: a power loss or OS crash can lose edits the operating system has not yet written to disk, since the relaxed commit and the journal are both unsynced then: typically the last few seconds on Windows and up to about 30 s on Linux, and on Firefox before 126, where no commit is synced, also after a hide. A journal's `seq` is the newest entry the session holds (`FlushSession.entrySeq`, read by `Flusher.newestSeq`), never a reserved or skipped `seq`, so a page resumed past a marker writes none until it has an entry.
- **Durably stored** (`notDurableReason`, `src/local/durable.ts`): the one predicate behind the leave prompt and session switches. Entries not yet committed count as stored only when no flush failed and the journal of the newest `seq` verified. Storage unavailable or paused, a first flush not yet written, and head media the store has not confirmed count as not stored.
- **Contents** (`Journal`, `format.ts`, `JOURNAL_VERSION`): `journalVersion`, `kind: 'journal'`, `recordsV`, `appVersion`, `writtenAt`, `sessionId`, `seq`; a `descriptor` (the session's `v`, `origin`, `parent`, `startedAt`, flags and the chain record as last written, without handles, hashes as hex); the state as `levelDataGz` (level data, gzip level 1, base64) plus `editorMetadata` and `header {levelInfo, bgm?, ids}` for what level data cannot carry; and `stack {keep, lastKept?, head, context, index}`: slots `0 … keep-1` of the committed stack stay, and `context` is a `RecoveryContext` of the dropped steps.
- **Reading.** A newer journal (`journalVersion` or `recordsV` above this build's, a newer descriptor `v`, an unknown `kind`) is left for a later build. A malformed one (a `journalVersion` or descriptor `v` that is 0, not an integer or absent) goes to the `recovered` store, so nothing is lost.
- **Replay** (every load, before any session opens: canary, journals, then the legacy migration; `src/local/startup/recovery.ts`). One strict transaction under the session lock either **applies** the journal or makes a **recovery session**. Apply writes one `recovered` entry whose `stack` keeps slots below `keep` and pushes the journalled state as an `edit` step of `nse.recovery` with the context. A journal a flush already covered (`lastSeq >= seq`) is deleted without an entry (`journal/apply.ts`). A worker restarted over memory refuses replay and the migration (`refuseUnlessStored`), which would commit to memory and remove the key, and the canary's read (`readMetaIds`), whose ids would read as a cleared database. The migration deletes the old auto save key after its commit; where IndexedDB has no `durability` (Firefox before 126), it leaves the key, and the next load, which finds its hash in `meta.migratedHashes`, deletes it.
- **Recovery session.** When the session was removed or continued, the chain is missing or being deleted, the stored stack does not match, a kept block is missing, or the session has a malformed `v`, the journal becomes a session in a **new chain** (copied from the descriptor as a fork is), origin `journal`, with one `recovered` entry whose stack is one slot. It is stored before the key goes. A chain or session of a newer generation is left in place instead.
- **Journal-only reload.** When storage is unavailable, a reload rebuilds the session from its own journal (`resumeFromJournal`, `src/local/startup/open.ts`) and the flusher queues a `recovered` baseline entry with stack `{keep: 0, push: [the state], index: 0}` (`Flusher.resumeJournalled`; `prepareFlush` checks the shape). It numbers that entry past the journal's `seq` and past a Save's marker, so it never takes the `seq` the Save's file holds.
- **Taken journal.** A continuation or fork that takes up a journal left unapplied pushes it as a plain `edit` entry with an `nse.recovery` step and its context (`openStored`, `src/local/startup/open.ts`).
- **`RecoveryContext`** (`src/history/operations/steps.ts`): `{head, headIndex, dropped[], omitted, x?}`, the descriptions of steps that could not be kept, so the Timeline can say what was lost. At most 64 items (`RECOVERY_CONTEXT_ITEMS`) and 128 KiB (`RECOVERY_CONTEXT_BYTES`) of `dropped`, counted without any `x` on the items (`withoutExtension`); the oldest go first and `omitted` counts them.

### 2.10 Time

`now = max(Date.now(), meta.maxSeenTime + 1)`, and every write moves `maxSeenTime`, so two writes never share a time across tabs or with the clock held back (`src/local/time.ts`). `clampTime` brings a time more than a day ahead back to now for the page's wall times, a journal's entry times and `startedAt` (`flushWrite.ts`, `journal/apply.ts`). Imported file rows keep their times unclamped. `meta.daysOfUse` rises once per calendar day of use; rows carry `day`, and "within N days" means `daysOfUse - day < N`, so a clock jump expires nothing early (`src/local/days.ts`).

A session's own rows never go back in time: each flush or journal row is its own stamp, and an open's own rows share one. A session opened from a file keeps the file's times for the rows it copied. `ORIGIN_RULE` (`src/local/records/unknownValues.ts`) says which sessions hold only their own rows (`new`, `import`, `continued`, `migrated`, `journal`) and which hold a file's (`nxsp`, `replaced`, and a missing or unknown origin); a session's `origin` is set when it is created and never changes, and rows copied from a file are written only into a session of a file origin that the same writer created (it never fills one it did not create). In a session of its own rows a `continue` row is only the lowest.

**Calendar.** Local days, hours and minutes come from `src/calendar/calendar.ts`, given a time and a zone; History samples both into `calendarClock.ts`, formats through `historyFormat`, and passes the zone to `readTimelineIndex`. Pieces are defined by `src/calendar/pieces.ts`: the maximal runs of adjacent entries of a list, dividers skipped, that share a session and a local day. The worker binary-searches only sessions of a new, imported, continued, migrated or recovered origin with no import pending and no kind filter, and reads every other session in full through a memo that grows by the rows added above it. Go To's counts are the steps under the Timeline's headers: every member of a collapsed group, no "Continued from" divider.

## 3. The `.nxsp` history

A `.nxsp` is a plain ZIP; `level.json` is the chart now, and the history is optional extra. The container rules (headers, CRC, timestamps, ZIP64, names) are in `src/zip/` and `src/local/nxsp/execute.ts`, and the full byte-level description in [nxsp-format.md](nxsp-format.md). What an older reader does with a newer file is format-versioning sections 2 to 4.

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
| `name` | Read into the chain's `name` at an open; the web's Save never writes it (`src/local/save/build.ts`): every web `name` is automatic (a copy's "(2)", a lost file's stem), and the apps name a library file by it (Part 3 ND15). |
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

**An open of the open session's own last write** makes no session (`reopensOwnFile`, `src/local/open/reopen.ts`; the reads in `ownWriteOf`, `src/editor/commands/open/project.ts`, before the read-only branch). It applies when the open is whole and in this tab only, its level is its history's head, and the binding as a Save reads it again (`bindingOf`, `revokedOf`) has a `file` this chain wrote (`event` not `opened`: an open's import may have ended short of the file), no `replaced`, the file's `id` and `revision.id`, and `file.hash` equal to the file's history head; the live state is unchanged since that binding (`fileChanged`, and the label's hash is the binding's); the handles agree (neither side has one, as on a download browser, where `docId`, revision and head identify the write and the name is no fact; or both, with `isSameEntry` and `sameContent` on the disk states); the chain has no `badChunks`; and every media hash the live state names is held in the tab or in storage. A read that fails is no match. On a match the read is dropped, a peek is left, a download binding is confirmed (`confirmFile`), and the open's notice is the earlier sessions' one as any open of the file gives, else "Opened coconut.nxsp" with no Reopen. Anything else is an ordinary open: a missing BGM, a damaged chain or an open's binding gets the fresh import that repairs it.

`chunks.bin` holds the stored chunks, concatenated with no framing. An append puts the source's `chunks.bin` first unchanged (one whole-entry copy, checked by CRC), then new chunks in first-reference order: entries in order (the `snapshot`, then a `recovered` entry's pushes), then the undo slots, then remaining roots; for each root its header chunk, then its kinds in order. The order affects offsets only, never a hash.

At open, every root and node is checked (hash of its canonical bytes, form, known `v`, references resolve), as are every root's header chunk and the head state's chunks (decoded and schema-checked, `noteCount` against the slides). Other chunks are inflated and hashed lazily during the background import. A chunk failing then marks the rows that need it `kept: false`; if the file is the chain's own and unchanged (size, modification time and fingerprint, when a handle is held; a picked `File` counts as unchanged), the chain is also unlinked (`writeUnlink`: new `docId`, no `revision` or `file`, `badChunks` added, `partialImport` set).

### 3.5 What a Save appends and what it rewrites

`planSave` (`src/local/save/build.ts`) decides the content; `planNxsp` (`src/local/nxsp/build.ts`) lays it out.

| Write | When | History |
| --- | --- | --- |
| `append` | A write-back to the chain's own file at its base, when that file has a manifest | The old segments are copied whole in order and `chunks.bin` begins with the old one. The old manifest becomes a new segment when it holds 500 or more entries; otherwise its contents carry into the new manifest. The rows after the binding's cut and the new `save` entry go in the manifest, never split. `completeFrom` is the source's. `assertAppend` checks independently that the plan is an append. |
| `append` over a file without history | A write-back to the chain's own file at its base, when that file has no manifest | As `copy` below, keeping the identity: there is no history to copy, so the file gains the chain's chronology (from the open's rows for a chain that opened it). The file's one version, its head, is the state of the open's rows. An open's cut of count 0 carries, so `completeFrom` is the file's own id; with no cut (a Save without History) it is the new id. |
| `copy`, `replace`, `new` | Anything else | The chronology is rebuilt from storage: sessions in chain order, each by `seq`, plus the tab's unflushed rows. Nothing is reused. It is cut into segments of 500 entries (`SEGMENT_ENTRIES`) while more than 500 remain, and the manifest holds the last 1 to 500. |

**What to save is chosen per Save** (`SaveOptions.history`, `bgm`): every write includes History and the head's BGM (its bytes when held, else as metadata) unless the Save dialog's ticks for that write leave them out, and nothing is stored on the binding (`DEFAULT_OPTIONS`, `src/editor/save/flow.ts`). A write-back, Download Again, Save as a Separate File, Replace and Export's rewrite of the chain's own file have no dialog, so they use the defaults. An append source with history keeps it whatever the option says, so a Save As… whose picker returns the chain's own file with History unticked still writes its history; a file without history gets none only when that write's History is unticked.

In every write the history ends with this revision's `save` entry; the undo stack is the saved session's, cut and renumbered (section 2.8); rows whose state is not held whole are written `kept: false`, never filtered out; and `project.json`, `level.json` and the media are rewritten. A writer never thins history inside a file. `new` (Save As, Save to File of a session) starts a new `docId` with no parent; `copy` keeps the `docId` and takes the chain's revision as parent.

Writer-only limits: the 5,000-slot stored window (`STACK_CAP`), 1,024 ancestors, 500-entry segments and the split sizes. `checkLimits` refuses a plan (`PlanError`, reason `plan`) with more than 4,096 segments, history parts over 512 MiB, or anything needing ZIP64 (4 GB, 65,535 entries): the writer never emits ZIP64. Readers accept any count within their caps.

**Picking the chain's own file** (`src/editor/save/pickSession.ts`, with the flows in `flow.ts`). A save picker empties the file it returns, so the page protects what the file holds that storage may lack:

- **A read at every picker, awaited.** Every Save or Export picker that may return the chain's own file has a read of it first (`readOwnFile`), per picker and not per dialog. Save, Save As…, Save as a Separate File and the not-found Save As… use the dialog's read (started when it opens), else one started at the press (`'start'`) with a grant already held, since a prompt would spend the press the picker needs. The pick session waits for the read in "Preparing…" (its Cancel cancels the Save); a read that failed (it threw, or storage's handle read failed) is tried once more, and a genuine "no handle" is not. The newest bytes read stay in one slot for the session, SP-1's read after damage included. Export's dialog starts the read when it opens (`startExportRead`) and passes it to its picker, which waits for it as a Save does; its Choose Another… starts a new one at the press. Save to File… starts the read of the open chain's own file when its Save dialog opens, with a grant already held. The file is read whole into memory, and only when storage lacks something (the carry test fails, rows are lacking, head media is not held, known damage) or the file is not at the base. A pick of the open chain's own file in Save to File… is a takeover by another document, so what was read of it is offered (`save.replacedContentGone`) once the other document is written.
- **Choose Another… repeats the same Save**, with its own read: Save As… stays Save As… (a new `docId`), Save as a Separate File and the not-found Save As… repeat themselves, and Save to File… repeats for its own session.
- **Putting the bytes back.** The pick session holds `nse-bind` exclusive from the picker's return to the end of the write or the put-back, in one callback; the pick is committed when the picker returns it, so no Cancel applies from there. When the pick is the chain's own file and bytes were read, every ending but a write, and any throw, puts them back while the file is still empty, so no other tab writes between the pick's check and the put-back. A refused pick (a partial open's file, an opened chart, an Export target) gets the bytes held of it, the kept copy, the opened bytes or the re-exported target, the same way. Bytes that cannot go back (the file was filled meanwhile, or the write failed) are offered as a download at once, right after the hold and before any other dialog (`notPutBack`; "emptied" when the file is empty, else "no longer holds"); a file with nothing readable to give back is told so with [OK] only. An offer for a refused pick takes the refusal dialog's place, and an offer for an emptied file takes a failure's. Export's pick runs the same hold (`exportPick.ts`): the chain's own `.nxsp` is written again as a Save writes it, committing a continuation's first row first, and when that cannot be done (no binding, a Save holds the reservation, or the commit forked the session) what was read goes back and the Save core says it was not written again. Another chain's file or Export target is taken only once the file is known to be empty, and a file filled meanwhile is never written over nor taken from its owner.
- **A failed own-file rebuild** is tried once more (a refusal is not, as it would be the same). With nothing read, the build made before the picker is written only when it is a `copy` with the History the rebuild would write; otherwise the file stays empty, the failure is shown and the next Save fills it from storage. The write is never Save As…'s identity (new `docId`, no ancestors, the dialog's History) over the chain's own file.
- **An open's import** is waited for inside "Preparing…" (`waitForChainImports`, `src/editor/save/imports.ts`; cancel ends the Save only), and so is any other import of the chain. It asks storage's `importPending` (`openPendingImports`), not only this tab's tracker, and resumes once an import no tab runs (its run threw, its tab closed), as a load does, then waits for it; one another tab holds is polled for up to 4 s. A list that cannot be read counts as pending and is read again within the same bound. An import still pending at the bound is refused as `importing`, with the line that the file could not be read completely. Recognising our own completed Save waits the same way, and a chain still importing after that is refused as `importing`, the marker kept. The Save dialog shows "Estimating size…" and no count while the import runs, and a cached estimate is kept only when the flush left nothing pending.

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
| `nse.header.set` | `edit` | Level Info (Initial Life alone), Offset tool, BGM dialog | `{field, before, after}` |
| `nse.bgm.change` | `edit` | BGM dialog, audio open | `{file, offset?}` |
| `nse.levelInfo.set` | `edit` | Level Info dialog (one Apply) | `{changes}` |
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

- *Produced by:* Level Info for Initial Life alone (`applyLevelInfo`, `src/editor/levelInfo/apply.ts`), the Offset tool drop, and the BGM dialog when only the offset changed (`bgmInput`). The codec allows `before === after`; producers return first when the value is unchanged or the dialog was cancelled.
- *Step Details:* "Set Initial Life to {0}" or "Set BGM Offset to {0} ms" (an exact decimal shift); one change row, `life` ("Initial Life") or `offset` ("Offset (ms)").
- *Groups:* family `header` by field ("Changed Initial Life"); group Details show one net row.

**`nse.bgm.change`** `{file: {before, after: NameText | null}, offset?: {before, after}}` (the file name without extension; `offset` only when it changed).

- *Produced by:* the BGM dialog and `changeBgm` (Open of an audio file) and Choose Audio… (the "Choose Audio…" notice actions) with a file other than the one the state names, when the buffer or file name changed; otherwise the same action gives `nse.header.set`. Re-picking the same bytes is not a no-op: every pick decodes a new buffer and `sameChart` compares it by identity, so the step has equal names.
- *Apply:* replaces `state.bgm` (name, buffer, waveform, bytes, metadata, offset).
- *Step Details:* "Changed BGM" (with `offset`) or "Changed BGM file"; a "File" change row, or a value row when both names are equal; an "Offset (ms)" row when stored; a missing name reads "Not set". Never grouped.

**`nse.levelInfo.set`** `{changes}`: 1 to 9 changes in the dialog's order `title artists author rating tags description cover preview initialLife`, each field once, each a real change, and not a lone `initialLife` (that is `nse.header.set`).

- Shapes: `title`, `artists`, `author`, `description` `{before, after: NameText}` (unset is the empty name); `rating` `{before, after: number | null}`; `tags` `{added, removed, changed?: positive, reordered?: true}` (counts by title); `cover`, `preview` `{before, after: NameText | null}`; `initialLife` `{before, after}`. A name pair is unchanged only when the texts are equal and neither is cut.
- *Produced by:* the Level Info dialog (`applyLevelInfo`, `src/editor/levelInfo/apply.ts`). One Apply is at most one step: `levelInfoInput` compares the live state's level info with the fields the user changed, laid over it (the dialog's own BGM steps stay), and returns `undefined` when nothing changed, which pushes no step. A cover or preview picked in the dialog is held (`holdMedia`) at the pick, before the step names it, so the flush that stores the step carries its bytes.
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
| `nse.origin` | `{origin: new \| import \| autoSave \| recovery, source?}`; `source` only with `import` | "Started a new level"; `import` "Opened {file}" with a source, else "Imported a level"; "Opened the old auto save"; "Recovered changes" |
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
- `facts`: sentences after the rows; "Text shortened for display" comes last when any name in `data` was cut.
- `note`: why nothing more is shown for a newer or unreadable step.
- `steps`: a group's, undo's or redo's member steps, newest first; `recovery`: the recovery context.

**Grouping.** `operationGroup` (`src/history/operations/grouping.ts`) gives an operation a `GroupDescriptor {key, family, subject?, axis?, field?, ..., metric?}`; `key` is `JSON.stringify([family, subject, axis, field, ...identity])`. Adjacent steps with equal keys collapse into one Timeline row, "{n} steps" (chronology, availability and pins are separate gates). A `metric` lets the title sum ("Duplicated 3 groups"); a total past safe integers falls back to the `history.summary.*` strings. Group Details show net rows: the first `before` to the last `after`. An id without a descriptor never groups. An `undo` or `redo` entry shows the crossed step's line with "Undo ·" or "Redo ·", and a run of them is one parent listing its steps.

### 4.6 Peek, Go To and Restore

- **Peek** (`peekEntry`, `src/history/peek.ts`) shows an entry's state read-only in place of the live one. It starts at once over what is shown, then loads from memory when the tab holds the state (a pending or memory-only entry, a loaded slot), else from the stored snapshot, read and verified in the worker (`createPeekSource`, `src/local/peekSource.ts`). A request within 100 ms of the last waits; a spinner shows after 150 ms; the cache holds 8. A failure gives a `PeekError`: `missing` (no source, no row, no snapshot), `removed` (a `kept: false` row whose root is gone), `damaged` (a part missing or failing its hash, or a kept row whose root is gone) or `newer` (a root from a newer version). While peeking `liveState` stays the live chart, so writers never see the peeked one, and every edit is refused ("Read-only while viewing history"). Nothing peeked reaches storage or a file.
- **The peek bar's hold.** While a new step's change is read (`changes.ts`), for up to 250 ms from the first switch the whole bar keeps the last read step's date, line, counts, enabled arrows and summary (`heldBar`, `barInfo`), so one swap follows; after 250 ms it names the new step and shows loading (`slowRead`). A press of an arrow, Show Change, View Property Changes or Step Details while a change is being read (`awaitingRead`) is kept (the latest only) and acts on the new step once its change is read (`pressWhenRead`); Restore acts on the new step at once. The first step of a peek has nothing to keep: its date and change strip stay hidden in place until its change is read or the loading state shows at 250 ms (`firstRead`), so nothing blank or dashed is painted, and a press then waits the same way (`awaitingRead`). Tests: browser `historyChanges.spec.ts`.
- **Go To** (`GoToList.vue`, `GoToPopover.vue`) is the Timeline's jump list: Now, then days newest first with their sessions; a day of one session is one row, and a day whose rows come back lower in the Timeline is listed again there. Counts are the steps under that day's headers, and steps not stored yet count too: Go To adds the Timeline's own entries above the newest one its index covers (`composeGoTo`, `src/calendar/goTo.ts`). The index is cached per start, filter, zone and `goToStamp` (the newest stored entry of the open session that is loaded; after a jump, the count of the Timeline's reads that have landed), so it is read again after each; an index read while an import fills the path is not kept, and Go To reads again when it next opens. While filtering it lists and counts saves and exports. The Timeline reads entries 100 at a time, newest first, with the open session's unstored entries on top (`src/editor/history/source.ts`, `src/local/worker/timelineHandlers.ts`). Reading with a kind filter reads every entry of a session, as no index holds the kind, and is not bounded: on a very long chain it can outlast the call's timeout, and Go To then fails and can be tried again (nothing is written).
- **Edits Here** scans the chain for edits in the chosen range once (`scanHere`, `hereRange`) and then checks for entries stored since (`checkNewer`). One check runs at a time for every list following (the panel and the dialog share it); a request during a check runs once more after it, and a match already listed is never listed twice. A closed list stops its follow timer. Without a storage worker the search cannot run and offers no Try Again.
- **Row marks.** A row reads not kept when its entry is `kept: false` and not damaged or newer, or when a peek or Restore found it gone after the row was read (`removedEntries`, `buildRows`); damaged and newer marks come the same way (`markFailed`). A peek or Restore of an entry not stored yet is told but marks nothing.
- **A session's peek** (Recent Sessions, `requestSessionPeek`, `selection.ts`) peeks the head's last entry with `peekEntry(key, { audio: 'none' })`, so it plays without BGM, while it loads and once shown. It is kept in `peekedSession`, apart from the steps' `peekedInfo`: the bar shows the name over the time with Back to Now and Restore Session (or Restore as a Copy), no change view, arrows or Step Details, and Find Edits Here is not offered. Leaving the Recent Sessions tab ends it. A session that cannot be read marks its row (`damaged`, `newer`) and says "Could not view this session" only for a failure the row does not show.
- **Restore Session** (`restoreStored`, `src/editor/restoreStored.ts`, the one path for the list, its peek bar, the load notices and the open notice) runs the not-stored prompt, `restoreSession` or `restoreAsCopy` (`OpenResult.forked` picks "Restored …" or "Restored a copy of …"), then the switch card with Reopen and, when the BGM is not loaded, its second line (`takeBgmLine`). It then shows the Timeline tab. A Restore Session, Restore as a Copy or Reopen that cannot open the session (deleted meanwhile, newer, damaged) says why in an error card (`notifyNotOpened`, `src/editor/openFailure.ts`), the same kind as Delete's failed and refused cards, not a quick toast.
- **Delete in Recent Sessions** (`sessionDelete.ts`, wired in `sessionDeleteLive.ts`): ⋯ › Delete or the Delete key (only while focus is in the list; key repeat and an inline row ignore it) calls `markDeleted` and ends the row's peek first. `marked` turns the row into an inline "Deleted "X"" row with Undo where it stood (a marked chain the next read no longer lists goes back in by its `updatedAt`); the inline row is the one surface, and a screen reader hears it through the list's live region (`data-sessions-live`). `open` (a session lock held: a tab or window, this one included, holds the chain) raises an error card "Not deleted. "X" is in use in a tab or window.", `failed` one with ""X" could not be deleted.", `gone` says nothing and the list reads again. The menu item is disabled with a reason when the row's head is held elsewhere; the core's lock check decides. A chain whose head cannot be read (`damaged`, no head id) or needs a newer version can be deleted. Undo (`undoDeleted`) restores, or says "Deleted "X". It can no longer be undone." for a chain the sweep removed, or "Could not undo" with Try Again for the same marks. The marks live in memory only, and closing History drops the inline rows, not the marks.
- **The Timeline's end.** `readTimeline`'s last page reports `earlierMissing` when the oldest stored session continues a session with no row (its chain was deleted and swept: a fork's parent chain); the list then ends with "Earlier Timeline steps are not stored in this browser." under the oldest divider.
- **Restore** (`restoreEntry`) loads the entry, leaves any peek, and pushes its chart and level info with the current audio as a `restore` step (`nse.restore`), with the entry's offset when its BGM hash is the current one and the current offset when the BGM differs (the offset fits the BGM it was set against); "Already matches the current chart" when equal by snapshot. It is cancelled, pushing nothing, if while it loaded the stack, the source, the live state or a peek changed, another Restore started, an Undo or Redo was requested, or any History action other than `save`, `export` or its own fired. A load failure goes to its `onFailure` callback (it throws without one).

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
| A routine flush commits with `'default'` durability, never `'relaxed'`; a hide's, a switch's, one that stores media or carries a Save's identity unit, and one that stores at once commit `'strict'`. | `Flusher` (`FlushBatch.durability`) | `local/flush/flush.test.ts` |
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
| R1. Every transaction that deletes rows or bodies runs inside `nse-maint` exclusive, requested with ifAvailable (never queued: `busy` retries later); its writes take no shared hold, never pause storing, and run while storing is paused for a full browser. | `StorageCore.exclusive` | `local/deletion/gc.test.ts` (busy, paused), `local/testing/testCore.test.ts` |
| R2. A GC or cleanup transaction that deletes a node, chunk or media row bumps the epoch in that transaction; removing session rows bumps nothing. | `gcPass`, `removeCachedMedia` (`bumpEpoch`) | `local/deletion/gc.test.ts` (one bump per sweep transaction; the closure check) |
| R3. A remover locks every session lock and import lock of a chain, exclusive and ifAvailable, across its transaction, or skips the chain: open tabs, continuations' parent holds, Save to File…, builds and imports are never touched. | `removeLocked`, `markDeleted` (`lockChain`); the test core's lock rule | `local/deletion/delete.test.ts` (each holder; the lock rule fires) |
| R4. A chain goes whole in one transaction: every session (entries, stack blocks, row), the record and its handles; the transaction refuses (`changed`) when the chain, its sessions or its mark differ from what was locked. | `removeTx` | `local/deletion/delete.test.ts`, `local/deletion/crash.test.ts` |
| R5. No remover deletes a journal: Delete applies the chain's journals before the mark, and every remover skips a chain with a `journal.<sessionId>` key; a marked chain's journal becomes a recovery chain at the next load. | `markDeleted`, `removeLocked`, `writeJournalApply` (`CHAIN_DELETING`) | `local/deletion/delete.test.ts` |
| R6. GC holds one exclusive hold from its mark to its last sweep, never resumes from an earlier mark, stops when a writer waits with its swept batches committed, and keeps a body first stored within the last 2 days of use. It is busy only while an import is running. | `gcPass` | `local/deletion/gc.test.ts` |
| Cleanup under pressure removes only `media` rows no chain's latest state reaches (marked chains included), past the 2-day grace period, largest first, read and removed in one transaction under `nse-maint` exclusive; never a Timeline row, session or chain; busy while an import is running. It runs at load above 80% of the quota and when storing pauses full, with Try Again after each round that removed something. | `removeCachedMedia`, `relieveAtLoad`, `relieveFull` | `local/deletion/cleanup.test.ts`, `local/deletion/pressure.test.ts`, `local/deletion/runner.test.ts`, browser `storagePressure.spec.ts` |
| R8. A marked chain is gone to every reader but GC's mark: the newest session, an open, the open notice and pending imports skip it. | `readSessionForOpen`, `readNewestSession`, `openPendingImports`, `readEarlierChains` | `local/startup/stored.test.ts`, `local/deletion/delete.test.ts` |
| R9. Undo clears a mark only while its `at` is the one its Delete wrote; a chain the sweep removed first is reported lost. | `undoTx` | `local/deletion/delete.test.ts` |
| A kill at any await of Delete, the sweep or GC leaves each chain whole (marked or not) or gone, and the next load's sweep and GC finish it. | the single removal transaction, `storedViolations` | `local/deletion/crash.test.ts` |

### 5.4 Newer data

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A newer session `v`, an unknown entry kind or a root `v` above `RECORDS_V` is "Needs a newer version", never damage: never continued, restored, reduced, saved or rewritten; automatic processes (GC, cleanup) never reduce it (R7), and only a user’s explicit whole-chain Delete or Delete Sessions… removes it. An older or malformed `v` is not newer and not read. | `sessionReadability`, `checkReadable`, `ModelError` | `local/records/unknownValues.test.ts`, `local/save/versionGuards.test.ts`, `local/journal/replay.test.ts` |
| R7. Automatic removal never reduces newer data: cleanup removes nothing while `meta.formatVersion`, a session or a head root is newer, and GC removes nothing while `meta.formatVersion` is newer, a session is newer or an entry kind is unknown, or when its traversal reaches a node of an unknown `t` or a root above `RECORDS_V` (an unreachable one is swept). A user's whole-chain Delete or Delete Sessions… removes such a chain: its rows go by key range, unread. | `removeCachedMedia`, `gcPass` | `local/deletion/cleanup.test.ts`, `local/deletion/gc.test.ts` |
| Version constants and tables are pinned. | — | `local/formatVersions.test.ts` |
| An `x` follows one rule on every carrier (a JSON object, at most 256 KiB, at most 32 levels below it, damage otherwise whatever `patch` says) and is never counted in its host's caps; a writer writes the lowest `minor` and `patch` the content needs. | `isExtensionValue`, `withoutExtension`, `minorOf`, `patchOf`, `nxsp_check.py` (`extension_form`, `expected_minor`, `expected_patch`) | `editor/historyOperations.test.ts`, `local/nxsp/agreement.test.ts`, `checker.test.ts`, `local/formatVersions.test.ts` |

### 5.5 Journal and recovery

| Rule | Enforced by | Tests |
| --- | --- | --- |
| The journal is written synchronously on hide, pagehide, beforeunload and freeze while entries are not committed to the database, and verified by reading back; one write per `seq`; a key is cleared once a commit to the database covers it. | `JournalWriter`, `Flusher.unflushed` | `local/journal/writer.test.ts`, `durable.test.ts`, browser `journalTiming.spec.ts`, `journalKill.spec.ts` |
| A page never replaces or clears a key it neither wrote nor loaded; a write past a size limit is not made. | `storageJournalStore` | `local/startup/open.test.ts`, `local/journal/writer.test.ts` |
| A journal names only an entry the session holds: a page with nothing unflushed writes none, whatever `nextSeq` is, and a journal-only reload numbers past a Save's marker. | `Flusher.newestSeq` (`entrySeq`), `Flusher.resumeJournalled` | `local/journal/phantom.test.ts` (resume past a marker) |
| A journal is applied once, whole or not at all; a covered journal is deleted without an entry; one that cannot be applied becomes a recovery session before its key goes. | `writeJournalApply` | `local/journal/replay.test.ts`, `local/startup/guards.test.ts`, `recovery.test.ts` |
| A newer journal is left in place; an unreadable one keeps its bytes in `recovered`. | `readJournal`, `keepRecovered` | `local/journal/replay.test.ts`, `local/fuzz/fuzz.test.ts` |
| A worker over memory refuses replay and the migration, so their keys stay; without `durability` the migration leaves the old auto save key to the next load. | `refuseUnlessStored`, `migrationStep` | `local/startup/recovery.test.ts` |
| The journal's level data round-trips, so the recovered state hashes as the stack around it. | `journalContent`, `withJournalIds` | `local/journal/content.test.ts`, `structuredMetadata.test.ts` |

### 5.6 Save and open

| Rule | Enforced by | Tests |
| --- | --- | --- |
| A write-back never drops a version: an append copies the source's segments and `chunks.bin` prefix unchanged and is asserted; a row whose state is not held is written `kept: false`, never filtered. | `planSave`, `assertAppend` | `local/save/assert.test.ts`, `model.test.ts`, `history.test.ts`, `local/nxsp/build.test.ts` |
| What to save is per Save: nothing is stored on the binding, every Save without a dialog includes History and the BGM, and a file's history is never stripped; a write-back to the chain's own file without history gives it the chain's history. | `DEFAULT_OPTIONS`, `projectPicked` (`own`), `planSave` | `local/save/pending.test.ts`, browser `saveOptions.spec.ts`, `saveAudit.spec.ts` |
| `completeFrom` carries only when the chain still holds the base's rows up to its cut, its own `save` entry among them, and the cut isn't `inexact`; the line says "were not kept" only for steps known missing, else "may not be included". | `carryStatus`, `stepsLine` | `local/save/carry.test.ts`, `model.test.ts` |
| A file is bound to at most one chain by a pick, and is never both bound and another chain's Export target; a pick that takes a file revokes the other binding inside `nse-bind`, and a takeover storage cannot record is refused, writing nothing (R11). An Open may bind a second chain (Part 1 §1.3.2); the tab check and the changed-on-disk check keep one writer. | `takeOver` (`src/local/save/bind.ts`), `revoke` (`src/editor/save/flow.ts`) | `editor/saveMatrix/invariants.ts` (I9), `editor/saveMatrix/detectors.test.ts` |
| A binding is stored with its marks in one transaction; a binding taken over meanwhile is dropped. | `commitIdentity`, `unitApplies` | `local/save/carry.test.ts`, `versionGuards.test.ts`, `local/flush/saveEntry.test.ts` |
| Our own completed Save records its binding alone, from the chain's head, over the binding it started from, never while the chain imports; it writes no entry. | `recordOwnSave` | `local/save/bind.test.ts`, browser `saveCrashes.spec.ts`, `saveCore.spec.ts` |
| A reservation ends by object identity: a stale end never ends a later Save's reservation that reused its `seq`. | `Flusher.endSave`, `Flusher.release`; every Save, and Export's own-project pick, take and end it through the Save attempt (`saveAttempt.ts`) | `local/flush/endSave.test.ts`, `structuredGuards.test.ts`, `editor/save/saveAttempt.test.ts`, browser `saveOwnFile.spec.ts` (ADV-5) |
| Every Save and Export picker that may return the chain's own file has a read of it first, and Choose Another… repeats the same Save with its own read; the read is whole, only when storage lacks something or the file is not at the base. | the pick session (`readOwnFile`, awaited, one retry) | `editor/save/pickSession.test.ts`, browser `saveOwnFile.spec.ts`, `saveReadFirst.spec.ts`, `local/save/selfPick.test.ts` |
| The bytes read from the own file go back while it is empty, under the pick's `nse-bind` exclusive lock, on every ending but a write and on a throw; bytes that cannot go back are offered as a download at once. | the pick session's hold and its offer, for the Save family, Export and Save to File… | `editor/save/pickSession.test.ts`, browser `saveOwnFile.spec.ts` (ADV-3, SF2-4) |
| From the picker's return, a pick ends written, put back or offered; Cancel no longer applies. | `pickSession.ts` | `editor/save/pickSession.test.ts`, the matrix's `export-cancel-after-pick` cells |
| Every save picker is opened by the pick session; `platform.saveFile` opens none. | `pickSession.ts` | `editor/saveMatrix/b4Acceptance.test.ts` |
| A failed own-file rebuild is tried once more; with nothing read, the build made before the picker is written only when it is a `copy` with the file's History and BGM, else the file stays empty and the failure is shown. | `projectPicked` (`own`) | browser `saveReadFirst.spec.ts` |
| Repair at save stores again only a body that is missing or fails its check, verified against its key (a chunk by inflate and hash, a root or kind node by schema and hash, media by its whole `sha256`), bottom-up and only once everything it reaches is whole; it never clears a mark. | `repairFromSource` | `local/save/selfPick.test.ts` |
| Every Save, Export and Save to File… wait for an open's import by storage's `importPending`, never show a count counted during it, and refuse as `importing` (the file is not read completely) if an import is still pending at the bound. | the attempt's start (`waitForChainImports`), `whenImported` (`src/local/open/importLoop.ts`), the Save dialog's estimate `load` | browser `saveOwnFile.spec.ts` (SF2-5, SF2-6) |
| Every Save in a tab runs through one queue: none overlaps, none is dropped. | `src/editor/save/queue.ts` | `editor/save/queue.test.ts` |
| A stored row without a note count reads without one, never as 0; a Save writes the count of the root it verified, else none. A file entry without one is read and imported without one, and the checker accepts it. | `readEntryRow`, `countOf`, `checkEntry`, `entryRow` | `local/save/noteCount.test.ts`, `local/open/import.test.ts`, `local/nxsp/agreement.test.ts` |
| Recent Sessions' list never shows a chain marked for Delete, lists a head it cannot read as `newer` or `damaged` instead of hiding it, and a failed read is a failure, never an empty list. A row's label comes from `labelOf`, the function the status bar uses. | `readRecent`, `listRecent`, `labelOf` | `local/recent.test.ts`, `editor/fileLabel.test.ts` |
| Delete's Undo never does nothing silently: it restores, says the chain can no longer be undone, or says it failed and offers Try Again with the same marks; the Delete key acts only while focus is in the list and never on key repeat or an inline row. | `createDeleteModel`, `RecentSessionsTab.vue` | `editor/sessionDelete.test.ts`, browser `recentSessionsDelete.spec.ts` |
| A chain is deletable whatever it holds: a head this build cannot read, a session of a newer version or no head id; only a chain another tab has open is refused. | `readDeleteTarget`, `readDeleteCandidates` | `local/deletion/delete.test.ts`, `local/deleteSessions/deleteSessions.test.ts` |
| In safe mode a restore reads only: no journal replay, always a copy, nothing stored. | `openSession` | `local/startup/api.test.ts` |
| Damage found in storage is marked one-way and the Save goes on with the line; a damaged head refuses. | `markDamaged` | `local/save/model.test.ts` |
| Check File and History… reads the bound file whole: every chunk inflated and hashed, never skipped because storage holds it. | `openFileCheck`, `checkFileChunks` | `local/check/check.test.ts` |
| Check writes nothing before its finish; it repairs from the file before it marks, marks only the rows whose states still reach a bad hash, removes no root, node or chunk, and removes a media row only when it still fails its re-hash under `nse-maint` exclusive; read-only storage gets the same report and no write. | `finishCheck`, `removeBadMedia` | `local/check/check.test.ts` |
| A built file is verified against its plan before it is handed over. | `src/local/save/verify.ts` | `local/save/model.test.ts` |
| An open stores its head at once, then imports in batches; a failing chunk marks its rows and, from the chain's own unchanged file, unlinks the chain; an abandoned import never lets a later Save carry the file. | `src/local/open/` | `local/open/import.test.ts`, `decide.test.ts` |
| Open reads strictly and never writes over a file it opened partial; two independent readers agree on every probe. | `readNxsp`, `nxsp_check.py` | `local/nxsp/read.test.ts`, `agreement.test.ts`, `checker.test.ts`, `local/fuzz/fuzz.test.ts` |
| A plan builds the same bytes in any implementation. | `planNxsp`, `execute.ts` | `local/nxsp/golden.test.ts`, `zip/planConformance.test.ts` |
| Peek names the failure on the row (not kept, damaged, newer), never shows a wrong state. | `PeekError`, `peekSource.ts` | `local/flush/verifiedRead.test.ts`, `editor/peek.test.ts`, browser `historyRestoreFailure.spec.ts` (damaged) |

### 5.7 What must never happen

- Silently dropping a step, a session or a chunk: a missing part is marked and shown, not filtered.
- Calling newer data damaged, or rewriting it.
- Storing a binding without its marks, or a file event ahead of its reserved `seq`, or a `save` entry outside the flusher.
- Creating a row of a session at or below its `lastSeq`, or in a session that is no longer its chain's head, outside an open's import.
- Saying Timeline steps were not kept when none is known missing.
- Acknowledging an entry that was not stored, or by count.
- Dropping a write because its store is missing.
- A picker emptying the chain's own file while its bytes are in hand and no read, put-back or download covers them.
- Opening a save picker outside the pick session, or writing a picked file outside its hold.
- Writing a build made before a picker over the chain's own file when it is not what that path would have written.
- Making up a note count of 0 for a row that does not say.
- Replacing a journal key this page did not write, or clearing one before a commit to the database covers it.
- A notice that is not true: a queued Undo reports only when it lands; a step notice only when `pushState` returned `true`.
- Writing from a peeked state, or editing while peeking.
- Showing a failed Recent Sessions read as an empty list; changing the rows under the pointer or focus (a refresh waits for both to leave, but the user's own action applies at once); a session's peek playing the open session's BGM.
- Attaching audio to a state that names another hash, another session or a peek, or making a step or a new root by doing so; saying "not loaded" for a BGM that memory or the media store holds, or twice for one hash in a session.
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

- **Trimming history.** Nothing marks a row `kept: false` for space: cleanup under pressure removes only cached earlier media. Trimming one chain's old history while keeping it ("Delete Earlier History") is deferred.
- **Level Info (Step 11).** `nse.levelInfo.set` has a producer, the Level Info dialog, but no inventory case in `historyOperationDetails.cases.json` yet.
- **Per-id operation versions.** The envelope has one literal `version: 1`. The first change after the ship needs a per-id version table and the old codec kept for reading.
- **Native apps.** The apps' reader and writer are not in this repository (Stage 2); the conformance cases and the checker are what they must match.
