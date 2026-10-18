import { session as currentSession } from '../../history/session'
import { isPeeking } from '../../history/stack'
import { i18n } from '../../i18n'
import { formatDateTime } from '../../i18n/dateTime'
import { formatDate } from '../../i18n/when'
import { launch } from '../../launch'
import type { Flusher, FlushSession, SaveReservation } from '../../local/flush'
import { handleOf, readableWithoutPrompt, requestRead, storableHandle } from '../../local/handles'
import { toHex } from '../../local/hash'
import { displayName, namePartsOf, stemOf } from '../../local/names'
import { NXSP_MINOR, NXSP_VERSION } from '../../local/nxsp/version'
import { isImporting, whenImported } from '../../local/open/importLoop'
import { readKeptCopy } from '../../local/open/kept'
import type { HandleOwner } from '../../local/save/bind'
import type { IdentityUnit } from '../../local/save/commit'
import type { BuiltSave } from '../../local/save/execute'
import { storageWorker } from '../../local/start'
import { storageStatus } from '../../local/startup/events'
import { journalWriter, flusher as storingFlusher } from '../../local/storing'
import {
    appVersion,
    diskStateOfBytes,
    FileError,
    platform,
    type DiskState,
    type FileTarget,
    type SaveResult,
} from '../../platform'
import { hasActivation, reportsActivation } from '../../platform/detect'
import { nxspDiskState, sameContent } from '../../platform/fingerprint'
import { requestWrite } from '../../platform/handover'
import { savePoint } from '../../platform/testPause'
import { PRODUCT_NAME } from '../../product'
import { isSafeMode } from '../../safe'
import { settings } from '../../settings'
import type { State } from '../../state'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { validName } from '../commands/exportLevel/fileName'
import { exportMemory, sameEntry, type OpenedSource } from '../commands/exportLevel/memory'
import type { ProjectPick } from '../commands/exportLevel/pick'
import { fileErrorText } from '../commands/exportLevel/ui'
import { bindFile, unbindFile } from '../file'
import { exportUsed, firstSaveDone, markFirstSaveDone } from '../file/flags'
import { setDiskFinding } from '../file/state'
import {
    BuildRefused,
    headHashOf,
    rootOf,
    runBuild,
    type BuildEnv,
    type BuildRequest,
} from './build'
import {
    replaceNewerLine,
    saveUi,
    type ConflictChoice,
    type DiskVersion,
    type Preparing,
    type RefusedReason,
    type SaveDialogInput,
    type SaveDialogKind,
} from './dialogs'
import { otherProject, readDiskFacts, type DiskFacts } from './disk'
import {
    deviceForm,
    deviceId,
    forgetHandle,
    heldHandle,
    markerFile,
    markerUnit,
    readMarker,
    rememberHandle,
    removeMarker,
    savedState,
    withBind,
    writeMarker,
    writeRevocation,
    type SaveMarker,
} from './env'
import { refreshBinding, revokedOf } from './watch'

// Save, Save As… and Save to File… (Part 1 §1.4.7; owner decision log D5): write-back with
// `requestPermission` first, the changed-on-disk check, our own completed Save, the Save dialog,
// the save picker's rules R1–R12 under `nse-bind`, downloads, and the follow-up dialogs. The
// dialogs are `saveUi`'s; the writer is the storage worker's (`buildSave`).

/** The binding as the chain record holds it (§1.6.11.2). */
export type StoredFile = {
    name: string
    event: 'opened' | 'saved' | 'downloaded'
    at: number
    hash: Uint8Array
    entry?: { sessionId: string; seq: number; startedAt: number; count: number; notKept: number }
    completeFrom?: string
    disk?: DiskState
    options: { history: boolean; bgm: boolean }
    confirmed?: true
}

/** The chain's identity fields as a Save reads them: stored, or kept in memory. */
export type Binding = {
    docId: string
    revision?: { id: string; n: number; ancestors: string[] }
    file?: StoredFile
    replaced?: { by: string; at: number; name: string }
}

type Env = BuildEnv & { chainId: string }

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A disk state that matches nothing: a binding without one meets the conflict dialog. */
const NO_DISK: DiskState = { fingerprint: 'none', size: -1, lastModified: 0 }

/** The project picker's id (§1.4.7). */
const PICKER_ID = 'nse-project'

/** A build longer than this shows "Preparing…" (§1.4.7, §1.5.6). */
const PREPARING_MS = 1000

const environment = (): Env | undefined => {
    const worker = storageWorker
    const flusher: Flusher | undefined = storingFlusher
    const session = flusher?.session
    if (!worker || !flusher || !session) return
    return { worker, flusher, session, chainId: session.chainId }
}

/** The binding of a record, with the one kept in memory over it (storage paused, §1.3.2). */
const bindingOf = (record: Row | undefined, session: FlushSession): Binding => {
    const identity = session.identity
    const source: Row = identity
        ? { ...record, docId: identity.docId, revision: identity.revision, file: identity.file }
        : (record ?? {})
    const file =
        isRow(source.file) && typeof source.file.name === 'string' ? source.file : undefined
    return {
        docId: typeof source.docId === 'string' ? source.docId : session.docId,
        ...(isRow(source.revision) ? { revision: source.revision as Binding['revision'] } : {}),
        ...(file ? { file: file as unknown as StoredFile } : {}),
        ...(!identity && isRow(source.replaced)
            ? { replaced: source.replaced as Binding['replaced'] }
            : {}),
    }
}

/** The record as this tab last wrote it: what a press decides by, before the check. */
const quickBinding = (env: Env) => bindingOf(env.session.chain, env.session)

/** The record read again (R10), with a revocation localStorage holds for it (R11). */
const readBinding = async (env: Env): Promise<Binding> => {
    const record = await env.worker.call('readChainRecord', env.chainId)
    // Taken over since: by the record, or by a key kept while storage couldn't take it (R11).
    const replaced = revokedOf(record, env.session) as Binding['replaced'] | undefined
    if (replaced) {
        const binding = bindingOf(record, { ...env.session, identity: undefined })
        return {
            docId: binding.docId,
            ...(binding.revision ? { revision: binding.revision } : {}),
            replaced,
        }
    }
    return bindingOf(record, env.session)
}

/** The handle of the chain's binding: this tab's, else the stored one, read when needed (D24). */
const bindingHandle = async (env: Env, file: StoredFile) => {
    const held = heldHandle(env.chainId, file.name)
    if (held) return held
    const stored = await handleOf(env.worker, env.chainId, 'file')
    return stored?.name === file.name ? stored : undefined
}

/** A continuation not stored yet commits its first row before its first file write (§1.3.1). */
const commitFirst = async (env: Env) => {
    const { session } = env
    if (!session.stored) session.atOnce = true
    await env.flusher.flush({ strict: true })
}

/** The label of the `save` entry and a file event: "Saved coconut.nxsp" (§1.3.8). */
const entryLabel = (name: string, download: boolean) =>
    interpolate(() => (download ? i18n.value.entry.downloaded : i18n.value.entry.saved), name)

const fileError = (error: unknown) =>
    error instanceof FileError
        ? error
        : new FileError('io', error instanceof Error ? error.message : String(error))

// The Preparing dialog: opened when a build is slow, or a Save waits for an import.

type PreparingSlot = { dialog?: Preparing; name: string; timer?: ReturnType<typeof setTimeout> }

const preparingFor = (name: string): PreparingSlot => ({ name })

const openPreparing = (slot: PreparingSlot) => (slot.dialog ??= saveUi.preparing(slot.name))

const whenSlow = (slot: PreparingSlot) => {
    slot.timer ??= setTimeout(() => {
        openPreparing(slot)
    }, PREPARING_MS)
}

const closePreparing = (slot: PreparingSlot) => {
    clearTimeout(slot.timer)
    slot.dialog?.close()
    slot.dialog = undefined
}

/** Whether the press's activation lapsed while building (§1.4.7 R12). */
const activationLapsed = (startedAt: number) =>
    reportsActivation() ? !hasActivation() : performance.now() - startedAt > PREPARING_MS

/**
 * Waits for the open's import of this session (§1.4.7): inside "Preparing…", whose Cancel
 * cancels the Save only. `unlinked` when the import found damage meanwhile.
 */
const waitForImport = async (env: Env, slot: PreparingSlot) => {
    if (!isImporting(env.session.id)) return 'done'
    const dialog = openPreparing(slot)
    try {
        const outcome = await whenImported(env.session.id, dialog.signal)
        return outcome.kind === 'unlinked' ? 'unlinked' : 'done'
    } catch {
        return 'cancelled'
    }
}

// The binding a write commits (§1.6.11.2).

const bindingFile = async (
    built: BuiltSave,
    reservation: SaveReservation,
    request: {
        name: string
        event: 'saved' | 'downloaded'
        handle?: FileSystemFileHandle
        disk?: DiskState
        options: { history: boolean; bgm: boolean }
    },
): Promise<Row> => {
    const { identity } = built
    const handle = await storableHandle(request.handle)
    return {
        name: request.name,
        ...(handle ? { handle } : {}),
        event: request.event,
        at: reservation.wall,
        hash: headHashOf(built),
        ...(identity.entry
            ? {
                  entry: {
                      sessionId: reservation.session.id,
                      seq: reservation.seq,
                      startedAt: reservation.session.startedAt,
                      ...identity.entry,
                  },
              }
            : {}),
        ...(identity.completeFrom === undefined ? {} : { completeFrom: identity.completeFrom }),
        ...(request.disk ? { disk: request.disk } : {}),
        options: request.options,
    }
}

/**
 * The record's binding as this Save found it (§1.3.2): a unit committed later is dropped when a
 * takeover changed it meanwhile (R5). A binding kept in memory carries the one it started from.
 */
const fromOf = (env: Env): IdentityUnit['from'] => {
    const { identity, chain } = env.session
    if (identity) return identity.from
    const at = (field: unknown) =>
        isRow(field) && typeof field.at === 'number' ? field.at : undefined
    const fileAt = at(chain?.file)
    const replacedAt = at(chain?.replaced)
    return {
        ...(fileAt === undefined ? {} : { fileAt }),
        ...(replacedAt === undefined ? {} : { replacedAt }),
    }
}

const unitOf = (env: Env, built: BuiltSave, file: Row): IdentityUnit => {
    const from = fromOf(env)
    return {
        docId: built.identity.docId,
        revision: built.identity.revision,
        file,
        marks: built.identity.marks,
        ...(from ? { from } : {}),
    }
}

/** The marker kept while a write's binding isn't stored: what our own completed Save commits. */
const markerOf = (
    env: Env,
    built: BuiltSave,
    reservation: SaveReservation,
    parent: string | null,
    file: Row,
): SaveMarker => ({
    chainId: env.chainId,
    entry: {
        sessionId: reservation.session.id,
        seq: reservation.seq,
        time: reservation.wall,
        label: built.saveEntry.label,
        snapshot: built.saveEntry.snapshot,
        noteCount: built.saveEntry.noteCount,
        revisionId: built.revisionId,
        device: deviceForm(),
    },
    parent,
    unit: {
        docId: built.identity.docId,
        revision: built.identity.revision,
        file: markerFile(file),
        marks: built.identity.marks,
    },
})

/**
 * Commits a write that binds (§1.3.2): its `save` entry at the reserved `seq` and the identity
 * unit with it, through the flush (kept in memory while storage is paused), and the tab's label.
 */
const bindWrite = async (
    env: Env,
    reservation: SaveReservation,
    built: BuiltSave,
    state: State,
    file: Row,
) => {
    const name = String(file.name)
    await env.flusher.endSave(
        reservation,
        {
            wall: reservation.wall,
            label: () => built.saveEntry.label,
            state,
            revisionId: built.revisionId,
            device: deviceForm(),
        },
        unitOf(env, built, file),
    )
    if (currentSession.value.sessionId === reservation.session.id) {
        const { copyOf: _copy, ...rest } = currentSession.value
        currentSession.value = { ...rest, docId: built.identity.docId }
        bindFile(
            {
                name,
                event: String(file.event),
                at: reservation.wall,
                hash: toHex(headHashOf(built)),
            },
            state,
        )
        markFirstSaveDone()
    }
}

const savedOf = (built: BuiltSave, kind: 'saved' | 'download', name: string, tookOver = false) => ({
    kind,
    name,
    size: built.blob.size,
    someStepsNotKept: built.someStepsNotKept,
    tookOver,
    without: built.without,
    tooLarge: built.tooLarge,
})

const feedback = (built: BuiltSave, kind: 'saved' | 'download', name: string, tookOver = false) => {
    saveUi.saved(savedOf(built, kind, name, tookOver))
}

/** A refusal's message (§1.4.7): a reader cap, a newer version, damage, or a bug. */
const refusalText = (refusal: BuildRefused, name: string) => {
    const { refused } = refusal.refusal
    if (refused === 'needsNewer')
        return () => interpolateRaw(i18n.value.conflict.replaceNewer, PRODUCT_NAME)
    if (refused === 'unreadableHead') return interpolate(() => i18n.value.save.unreadable, name)
    if (refused === 'plan' && 'limit' in refusal.refusal && refusal.refusal.limit)
        return () => i18n.value.save.tooLarge
    // A bug, logged by the writer: the file could not be prepared.
    return interpolate(() => i18n.value.save.buildFailed, name)
}

// R1: suggestions that never name a known file.

const knownNames = async (env: Env) => {
    try {
        const owners = await env.worker.call('listHandleOwners')
        return new Set(owners.map((owner) => owner.name.normalize('NFC').toLocaleLowerCase()))
    } catch {
        return new Set<string>()
    }
}

/** A suggestion made valid and, when a stored binding or target has its name, " (2)", " (3)"… */
const suggestion = async (env: Env, stem: string) => {
    const known = await knownNames(env)
    const base = validName(stem)
    const taken = (name: string) => known.has(`${name}.nxsp`.normalize('NFC').toLocaleLowerCase())
    if (!taken(base)) return base
    for (let n = 2; ; n++) if (!taken(`${base} (${n})`)) return `${base} (${n})`
}

/** The displayed name as a file name, or empty for the date fallback (§1.3.5, round 8). */
const shownStem = (env: Env, state: State) => {
    const shown = displayName(namePartsOf(env.session.chain, state))
    if (shown.kind === 'date') return ''
    const text = shown.kind === 'name' || shown.kind === 'title' ? shown.text : stemOf(shown.text)
    return text === 'LevelData' ? '' : text
}

const copyStem = (stem: string) => (!stem || / \(\d+\)$/.test(stem) ? stem : `${stem} (2)`)

/** A file time for a name: "Oct 16, 2.41 PM" (no colon in a file name). */
const nameTime = (time: number) => formatDateTime(settings.locale, time).replaceAll(':', '.')

// Pre-reading this chain's own file before a picker (R2).

type PreRead = { blob: Blob; disk: DiskState; atBase: boolean }

/** The head's media whose bytes this tab doesn't hold, by hash: storage or the file may. */
const mediaNotHeld = (state: State, options: StoredFile['options']) => {
    const { meta, source } = state.bgm
    const refs = [
        ...(meta && !source && options.bgm ? [meta] : []),
        ...(state.levelInfo.cover ? [state.levelInfo.cover] : []),
        ...(state.levelInfo.preview ? [state.levelInfo.preview] : []),
    ]
    return refs.map((ref) => ref.hash)
}

/**
 * Reads the chain's own file before a save picker that may return it (R2), when its dialog
 * opens: whole, and only when it isn't at the base, when storage lacks rows of its base (the
 * carry test) or head media it may hold. Read access is asked for only when storage lacks
 * something; otherwise only a grant already held reads. Undefined when nothing was read.
 */
const preRead = async (env: Env, binding: Binding): Promise<PreRead | undefined> => {
    const file = binding.file
    if (!file) return
    const handle = await bindingHandle(env, file)
    if (!handle) return
    const needs = await env.worker
        .call('saveNeeds', {
            chainId: env.chainId,
            media: mediaNotHeld(savedState(), file.options),
        })
        .catch(() => undefined)
    const short = !needs?.carries || needs.lacking.length > 0
    let readable = await readableWithoutPrompt(handle)
    if (!readable && short) readable = await requestRead(handle)
    if (!readable) return
    try {
        const found = await handle.getFile()
        const disk = await nxspDiskState(found, found.lastModified)
        if (disk.size === 0) return
        const atBase = !!file.disk && sameContent(disk, file.disk)
        // At the base, with storage holding all it does: nothing to keep.
        if (atBase && !short) return
        // Into memory: a picker empties the file under any `File` read before.
        return { blob: new Blob([await found.arrayBuffer()]), disk, atBase }
    } catch {
        return
    }
}

// The save picker (§1.4.7 R1–R12).

/** What a picked handle is (R3, R7). */
type Picked =
    | { kind: 'own' }
    | { kind: 'other'; owner: HandleOwner }
    /** An Export target: Export's picker writes it (E1, E2); a project picker refuses it (R7). */
    | { kind: 'target'; owner: HandleOwner }
    /** `bytes`: those kept at its open, once kept (R7). */
    | { kind: 'refused'; reason: RefusedReason; bytes?: Promise<Blob | undefined> }
    | { kind: 'unknown' }

/**
 * Whether two handles name one file (`isSameEntry`), asked both ways: a handle read back from
 * storage may only compare from its own side (the specs' OPFS tokens).
 */
const same = async (a: FileSystemFileHandle, b: FileSystemFileHandle) =>
    (await sameEntry(a, b)) || sameEntry(b, a)

/** Identifies a picked file under `nse-bind` (R3, R7), outside any transaction. */
const identify = async (env: Env, handle: FileSystemFileHandle): Promise<Picked> => {
    const { opened } = exportMemory
    if (opened && (await same(handle, opened.handle))) {
        if (!opened.project)
            return {
                kind: 'refused',
                reason: opened.levelData ? 'levelData' : 'notProject',
                ...(opened.kept ? { bytes: Promise.resolve(new Blob([opened.kept])) } : {}),
            }
        // Its bytes are awaited: a quick Save never finds them still being read (m8).
        if (opened.partial) return { kind: 'refused', reason: 'notKept', bytes: kept(opened) }
    }
    const own = quickBinding(env).file
    const held = own && heldHandle(env.chainId, own.name)
    if (held && (await same(handle, held))) return { kind: 'own' }
    let owners: HandleOwner[] = []
    try {
        owners = await env.worker.call('listHandleOwners')
    } catch {
        // Storage unavailable: no other chain is known (R11), and the pick is R8's.
    }
    for (const owner of owners) {
        if (!owner.handle) continue
        const stored = await handleOf(env.worker, owner.chainId, owner.role)
        if (!stored || !(await same(handle, stored))) continue
        if (owner.role === 'exportTarget') return { kind: 'target', owner }
        // A partial open's file, in this tab after a reload or in another tab (R7, D26).
        if (owner.role === 'kept')
            return { kind: 'refused', reason: 'notKept', bytes: readKeptCopy(owner.chainId) }
        return owner.chainId === env.chainId ? { kind: 'own' } : { kind: 'other', owner }
    }
    return { kind: 'unknown' }
}

/** The bytes a partial open kept, in memory or as an OPFS copy. */
const kept = async (opened: OpenedSource) =>
    (await opened.keptCopy) ?? (opened.bytes && new Blob([opened.bytes]))

/** A project picker's pick of an Export target: level data, refused and put back (R7). */
const refusedTarget = (env: Env, picked: Picked): Exclude<Picked, { kind: 'target' }> =>
    picked.kind === 'target'
        ? { kind: 'refused', reason: 'levelData', bytes: targetBytes(env, picked.owner) }
        : picked

/**
 * The bytes an Export target holds, re-exported from this chain's live state when they hash to
 * what the target last held (R7); undefined for another chain's target or any other state.
 */
const targetBytes = async (env: Env, owner: HandleOwner) => {
    if (owner.chainId !== env.chainId) return
    try {
        const record = await env.worker.call('readChainRecord', env.chainId)
        const target = isRow(record?.exportTarget) ? record.exportTarget : undefined
        const disk = isRow(target?.disk) ? (target.disk as DiskState) : undefined
        if (!disk) return
        const { buildLevelData } = await import('../commands/exportLevel/build')
        const bytes = await buildLevelData().arrayBuffer()
        return (await diskStateOfBytes(bytes, 0)).fingerprint === disk.fingerprint
            ? new Blob([bytes])
            : undefined
    } catch {
        return
    }
}

/** Writes bytes back into a picked file while it's still empty (R4, R7); true when it holds them. */
const putBack = async (target: FileTarget, bytes: ArrayBuffer | Blob) => {
    try {
        // Its precondition is the empty file as this write's kind measures it (R9).
        const empty = await platform.inspect(target)
        if (empty === 'missing' || empty.size !== 0) return false
        await platform.saveFile({
            kind: 'recovery',
            suggestedName: target.kind === 'handle' ? target.handle.name : '',
            target,
            expected: empty,
            build: () => Promise.resolve(bytes instanceof Blob ? bytes : new Blob([bytes])),
        })
        return true
    } catch {
        return false
    }
}

/** A disk state of an empty file: what a save picker leaves (R9). */
const EMPTY_DISK: DiskState = { fingerprint: 'damaged:0:0', size: 0, lastModified: 0 }

/** The hash no state has: a pre-bound chain counts as changed (R9). */
const NO_HASH = new Uint8Array(16)

type Revoked = { ok: boolean; revoked: boolean; preBound: boolean }

/** Takes a file over from another chain (R5), or keeps the revocation in localStorage (R11). */
const revoke = async (
    env: Env,
    owner: HandleOwner | undefined,
    preBind: { file: Row; docId?: string } | undefined,
): Promise<Revoked> => {
    const at = Date.now()
    try {
        const done = await env.worker.call('takeOver', {
            ...(owner ? { owner } : {}),
            ...(preBind ? { preBind: { chainId: env.chainId, ...preBind } } : {}),
            by: env.chainId,
            at,
        })
        return { ok: true, ...done }
    } catch {
        // Storage paused or full: the revocation goes to localStorage first (R11).
        if (!owner) return { ok: true, revoked: false, preBound: false }
        if (isSafeMode() || owner.at === undefined)
            return { ok: false, revoked: false, preBound: false }
        const kept = writeRevocation(owner.chainId, {
            by: env.chainId,
            at,
            name: owner.name,
            fileAt: owner.at,
        })
        return { ok: kept, revoked: kept, preBound: false }
    }
}

/** A takeover that could not be kept: nothing is written (R11). */
const notTakenOver = (name: string): Outcome =>
    isSafeMode()
        ? { kind: 'refused', name, reason: 'safeMode', emptied: true }
        : { kind: 'failed', error: new FileError('io', `${name} was not taken over`), name }

/**
 * The open session follows a pre-bind (R5, R9): its record, its `docId`, and a label bound to the
 * emptied file, which counts as changed until the write is recorded.
 */
const followPreBind = async (env: Env, reservation: SaveReservation, name: string) => {
    const record = await env.worker.call('readChainRecord', env.chainId).catch(() => undefined)
    if (!record) return
    env.session.chain = record
    if (typeof record.docId === 'string') env.session.docId = record.docId
    if (currentSession.value.sessionId !== reservation.session.id) return
    const { copyOf: _copy, ...rest } = currentSession.value
    currentSession.value = { ...rest, docId: env.session.docId }
    bindFile({ name, event: 'saved', at: reservation.wall, hash: toHex(NO_HASH) })
}

/** What a Save that picks wants written. */
type PickRequest = {
    dialog: SaveDialogKind | 'separate' | 'notFound'
    fileName: string
    history: boolean
    bgm: boolean
    /** `new` mints a `docId` (Save As…); `copy` keeps the chain's identity. */
    target: 'new' | 'copy'
    startIn?: FileSystemHandle
    pre?: Promise<PreRead | undefined>
}

type Outcome =
    | { kind: 'done' }
    | { kind: 'cancelled' }
    | {
          kind: 'refused'
          name: string
          reason: RefusedReason
          emptied: boolean
          /** The bytes kept at its open, offered as a download when they could not go back. */
          bytes?: Blob
      }
    | { kind: 'conflict'; handle: FileSystemFileHandle; binding: Binding }
    | { kind: 'failed'; error: FileError; name: string }
    | { kind: 'error'; message: () => string }

let running: Promise<void> | undefined
let queued = false

/**
 * One Save at a time in a tab: a press while one runs waits for it and runs once after (a second
 * press then finds nothing changed); more presses meanwhile add nothing.
 */
const exclusive = async (run: () => Promise<void>) => {
    if (running) {
        if (queued) return
        queued = true
        await running
        queued = false
    }
    const current = run().catch((error: unknown) => {
        console.error('A Save failed', error)
    })
    running = current
    try {
        await current
    } finally {
        if (running === current) running = undefined
    }
}

/** Ends a reservation no path ended (a throw): its `seq` kept, since the write may have landed. */
const release = async (env: Env, reservation: SaveReservation) => {
    if (reservation.session.reserved === reservation.seq)
        await env.flusher.endSave(reservation, undefined, undefined, true)
}

/** A read before the picker, as it stands now: one that hasn't finished is dropped (R2). */
const settledNow = <T>(promise: Promise<T | undefined> | undefined) =>
    promise ? Promise.race([promise, Promise.resolve(undefined)]) : Promise.resolve(undefined)

/**
 * Saves through the picker, or downloads where there's none: the file is built and verified
 * first (D5), then picked, identified under `nse-bind` exclusive, written over the emptied file
 * (its empty state the precondition, R9) and bound.
 */
const pickAndWrite = async (env: Env, request: PickRequest): Promise<Outcome> => {
    const slot = preparingFor(request.fileName)
    const startedAt = performance.now()
    await commitFirst(env)
    if ((await waitForImport(env, slot)) === 'cancelled') {
        closePreparing(slot)
        return { kind: 'cancelled' }
    }
    const binding = quickBinding(env)
    const reservation = env.flusher.reserveSave()
    if (!reservation) {
        closePreparing(slot)
        return { kind: 'cancelled' }
    }
    try {
        return await pickReserved(env, reservation, request, binding, slot, startedAt)
    } finally {
        closePreparing(slot)
        await release(env, reservation)
    }
}

const pickReserved = async (
    env: Env,
    reservation: SaveReservation,
    request: PickRequest,
    binding: Binding,
    slot: PreparingSlot,
    startedAt: number,
): Promise<Outcome> => {
    const state = savedState()
    const docId = request.target === 'new' ? crypto.randomUUID() : binding.docId
    const buildRequest: BuildRequest = {
        target: request.target === 'new' ? { kind: 'new', docId } : { kind: 'copy' },
        history: request.history,
        bgm: request.bgm,
        fileName: request.fileName,
        save: {
            time: reservation.wall,
            label: entryLabel(request.fileName, !platform.pickSaveFile)(),
        },
        state,
    }
    let built: BuiltSave
    whenSlow(slot)
    try {
        built = await runBuild(env, buildRequest)
    } catch (error) {
        closePreparing(slot)
        await env.flusher.endSave(reservation)
        if (error instanceof BuildRefused)
            return { kind: 'error', message: refusalText(error, request.fileName) }
        return { kind: 'failed', error: fileError(error), name: request.fileName }
    }
    clearTimeout(slot.timer)
    slot.dialog?.built(built.blob.size)
    if (slot.dialog?.signal.aborted) {
        closePreparing(slot)
        await env.flusher.endSave(reservation)
        return { kind: 'cancelled' }
    }

    const pickSaveFile = platform.pickSaveFile
    if (!pickSaveFile) return download(env, reservation, built, state, request, slot)

    // R12: a build that outlasted the press asks for a new one.
    if (
        activationLapsed(startedAt) &&
        !(await openPreparing(slot).ready('save', built.blob.size))
    ) {
        closePreparing(slot)
        await env.flusher.endSave(reservation)
        return { kind: 'cancelled' }
    }
    closePreparing(slot)
    // A read that hasn't finished when the picker opens is dropped (R2).
    const pre = await settledNow(request.pre)
    let target: FileTarget | undefined
    try {
        target = await pickSaveFile({
            suggestedName: request.fileName,
            picker: {
                id: PICKER_ID,
                types: [{ description: i18n.value.save.fileType, extension: '.nxsp' }],
                excludeAll: true,
                startIn: request.startIn ?? 'documents',
            },
        })
    } catch (error) {
        await env.flusher.endSave(reservation)
        return { kind: 'failed', error: fileError(error), name: request.fileName }
    }
    if (target?.kind !== 'handle') {
        await env.flusher.endSave(reservation)
        return { kind: 'cancelled' }
    }
    const picked = target
    await savePoint('picked')
    return withBind('exclusive', () =>
        afterPick(env, reservation, built, state, request, binding, picked, pre),
    )
}

/** The disk state another chain's binding records, for a file filled while a pick waited. */
const ownerDisk = async (env: Env, owner: HandleOwner) => {
    const record = await env.worker.call('readChainRecord', owner.chainId).catch(() => undefined)
    const file = isRow(record?.file) ? record.file : undefined
    return file && file.at === owner.at && isRow(file.disk) ? (file.disk as DiskState) : undefined
}

/** A picked file holding what nobody here wrote: nothing is written over it. */
const changedWhilePicked = (name: string): Outcome => ({
    kind: 'failed',
    error: new FileError('conflict', `${name} changed on disk`),
    name,
})

/** After a pick, under `nse-bind` exclusive: R3–R9, the write, and the binding. */
const afterPick = async (
    env: Env,
    reservation: SaveReservation,
    /** Built before the picker; Export's pick of the chain's own file builds after it. */
    prebuilt: BuiltSave | undefined,
    state: State,
    request: PickRequest,
    binding: Binding,
    target: FileTarget & { kind: 'handle' },
    pre: PreRead | undefined,
): Promise<Outcome> => {
    const { handle } = target
    const name = handle.name
    let found: DiskState
    try {
        const disk = await platform.inspect(target, 'nxsp')
        if (disk === 'missing') throw new FileError('not-found', `${name} cannot be found`)
        found = disk
    } catch (error) {
        await env.flusher.endSave(reservation)
        return { kind: 'failed', error: fileError(error), name }
    }
    // Written since the pick: by a sync client, or by its owner while this pick waited (R9).
    const filled = found.size !== 0
    const picked = refusedTarget(env, await identify(env, handle))
    let built = prebuilt
    let tookOver = false
    let bound = binding
    switch (picked.kind) {
        case 'refused': {
            // R7: refused, and the bytes kept at its open put back while it's still empty.
            await env.flusher.endSave(reservation)
            const bytes = await picked.bytes
            const back = !filled && bytes ? await putBack(target, bytes) : false
            return {
                kind: 'refused',
                name,
                reason: picked.reason,
                emptied: !filled && !back,
                ...(bytes ? { bytes } : {}),
            }
        }
        case 'own': {
            // R4: this chain's own file keeps the identity, appending to the bytes read first.
            if (filled) {
                await env.flusher.endSave(reservation)
                return { kind: 'conflict', handle, binding }
            }
            if (pre && !pre.atBase) {
                await env.flusher.endSave(reservation)
                if (await putBack(target, pre.blob)) return { kind: 'conflict', handle, binding }
                // The version on disk could not go back: offered as a download (R7).
                return { kind: 'refused', name, reason: 'notKept', emptied: true, bytes: pre.blob }
            }
            const options = binding.file?.options ?? { history: true, bgm: request.bgm }
            const history = binding.file ? !!binding.file.entry : options.history
            try {
                built = await runBuild(
                    env,
                    {
                        target: pre ? { kind: 'append', source: 'pre' } : { kind: 'copy' },
                        history,
                        bgm: options.bgm,
                        fileName: name,
                        save: { time: reservation.wall, label: entryLabel(name, false)() },
                        state,
                    },
                    pre
                        ? [
                              {
                                  token: 'pre',
                                  role: 'target',
                                  file: pre.blob,
                                  fingerprint: pre.disk.fingerprint,
                              },
                          ]
                        : [],
                )
            } catch (error) {
                await env.flusher.endSave(reservation)
                if (error instanceof BuildRefused)
                    return { kind: 'error', message: refusalText(error, name) }
                return { kind: 'failed', error: fileError(error), name }
            }
            break
        }
        case 'other':
        case 'unknown': {
            // Filled while this pick waited: taken over only when it's its owner's own last Save.
            const owners = picked.kind === 'other' ? await ownerDisk(env, picked.owner) : undefined
            const ownersOwn = filled && !!owners && sameContent(found, owners)
            if (filled && picked.kind === 'other' && !ownersOwn) {
                await env.flusher.endSave(reservation)
                return changedWhilePicked(name)
            }
            const preBind = {
                file: {
                    name,
                    handle: await storableHandle(handle),
                    event: 'saved',
                    at: reservation.wall,
                    hash: NO_HASH,
                    // A sync client's bytes are never the pre-bind's: the next Save meets them.
                    disk: filled && !ownersOwn ? EMPTY_DISK : found,
                    options: { history: request.history, bgm: request.bgm },
                },
                // Save As…'s new identity goes with its file (§1.3.2: one unit).
                ...(request.target === 'new' && built ? { docId: built.identity.docId } : {}),
            }
            const done = await revoke(
                env,
                picked.kind === 'other' ? picked.owner : undefined,
                preBind,
            )
            if (!done.ok) {
                await env.flusher.endSave(reservation)
                return notTakenOver(name)
            }
            tookOver = done.revoked
            if (done.preBound) {
                await followPreBind(env, reservation, name)
                bound = await readBinding(env).catch(() => binding)
            }
            if (tookOver) broadcastUpdated()
            await savePoint('revoked')
            // A sync client's write after the pick: pre-bound, never written over (R9).
            if (filled && !ownersOwn) {
                await env.flusher.endSave(reservation)
                return done.preBound
                    ? { kind: 'conflict', handle, binding: bound }
                    : changedWhilePicked(name)
            }
            break
        }
    }

    if (!built) {
        await env.flusher.endSave(reservation)
        return { kind: 'failed', error: new FileError('io', `${name} was not built`), name }
    }
    const file = await bindingFile(built, reservation, {
        name,
        event: 'saved',
        handle,
        options: {
            history: !!built.identity.entry,
            bgm: picked.kind === 'own' ? (binding.file?.options.bgm ?? request.bgm) : request.bgm,
        },
    })
    const written = await writeBuilt(env, reservation, built, target, found, bound, file)
    if (written.kind !== 'saved') return written.outcome
    await savePoint('closed')
    rememberHandle(env.chainId, handle)
    await bindWrite(env, reservation, built, state, {
        ...file,
        ...(written.disk ? { disk: written.disk } : {}),
    })
    feedback(built, 'saved', name, tookOver)
    return { kind: 'done' }
}

/** A failure before anything was written: a precondition or a denial. */
const notWritten = (failure: FileError) => failure.step === 'check' || failure.code === 'denied'

type Written = { kind: 'saved'; disk?: DiskState } | { kind: 'failed'; outcome: Outcome }

/**
 * Writes a built file to a target whose disk state is `expected`, with the marker kept from just
 * before the write until its binding is stored (our own completed Save, §1.4.7).
 */
const writeBuilt = async (
    env: Env,
    reservation: SaveReservation,
    built: BuiltSave,
    target: FileTarget & { kind: 'handle' },
    expected: DiskState,
    binding: Binding,
    file: Row | undefined,
): Promise<Written> => {
    const name = target.handle.name
    const parent = built.identity.revision.ancestors.length ? (binding.revision?.id ?? null) : null
    if (file) writeMarker(markerOf(env, built, reservation, parent, file))
    let result: SaveResult
    try {
        result = await platform.saveFile({
            kind: 'nxsp',
            suggestedName: name,
            target,
            expected,
            build: () => Promise.resolve({ kind: 'blob', blob: built.blob }),
        })
    } catch (error) {
        const failure = fileError(error)
        // The write may have landed (a failed read-back): its `seq` stays for the marker.
        const unwritten = notWritten(failure)
        if (unwritten && file) removeMarker(env.chainId, built.revisionId)
        await env.flusher.endSave(reservation, undefined, undefined, !unwritten)
        if (failure.code === 'conflict')
            return {
                kind: 'failed',
                outcome: { kind: 'conflict', handle: target.handle, binding },
            }
        return { kind: 'failed', outcome: { kind: 'failed', error: failure, name } }
    }
    return {
        kind: 'saved',
        ...(result.status === 'saved' && result.disk ? { disk: result.disk } : {}),
    }
}

/** Downloads a built file (download browsers, a binding by name), binding it by name. */
const download = async (
    env: Env,
    reservation: SaveReservation,
    built: BuiltSave,
    state: State,
    request: Pick<PickRequest, 'fileName' | 'history' | 'bgm' | 'dialog'>,
    slot: PreparingSlot,
): Promise<Outcome> => {
    let result: SaveResult
    try {
        result = await platform.saveFile({
            kind: 'nxsp',
            suggestedName: request.fileName,
            build: () => Promise.resolve({ kind: 'blob', blob: built.blob }),
            ready: (file) => openPreparing(slot).ready('download', file.size),
        })
    } catch (error) {
        closePreparing(slot)
        await env.flusher.endSave(reservation)
        return { kind: 'failed', error: fileError(error), name: request.fileName }
    }
    closePreparing(slot)
    if (result.status !== 'download-started') {
        await env.flusher.endSave(reservation)
        return { kind: 'cancelled' }
    }
    if (request.dialog !== 'saveToFile') {
        const file = await bindingFile(built, reservation, {
            name: request.fileName,
            event: 'downloaded',
            options: { history: request.history, bgm: request.bgm },
        })
        await bindWrite(env, reservation, built, state, file)
        forgetHandle(env.chainId)
    } else await env.flusher.endSave(reservation)
    feedback(built, 'download', request.fileName)
    return { kind: 'done' }
}

// The write-back (§1.4.7's first row).

/**
 * Our own completed Save (§1.4.7, r13-dataloss Minor 1): a file this chain wrote whose binding
 * wasn't recorded. Recorded from the marker kept before the write, after the file's checks.
 */
const ownCompletedSave = async (
    env: Env,
    binding: Binding,
    handle: FileSystemFileHandle,
    file: Blob,
    disk: DiskState,
) => {
    const marker = readMarker(env.chainId)
    if (!marker) return false
    const facts = await readDiskFacts(file, deviceId()).catch(() => undefined)
    const project = isRow(facts?.projectJson) ? facts.projectJson : undefined
    const revision = isRow(project?.revision) ? project.revision : undefined
    const device = isRow(revision?.device) ? revision.device : undefined
    const last = facts?.last
    // The file holds this write: its revision, this browser, and its `save` entry last.
    if (
        revision?.id !== marker.entry.revisionId ||
        device?.id !== deviceId() ||
        (revision.parent ?? null) !== marker.parent ||
        (marker.parent !== null && marker.parent !== binding.revision?.id) ||
        last?.kind !== 'save' ||
        last.revisionId !== marker.entry.revisionId
    )
        return false
    const unit = markerUnit(marker)
    if (unit.file.name !== handle.name) return false
    // The handle the check used stays the binding's, so later Saves write back in place.
    const stored = await storableHandle(handle)
    const done = await env.worker
        .call('finishOwnSave', {
            chainId: env.chainId,
            entry: marker.entry,
            unit: {
                ...unit,
                file: { ...unit.file, ...(stored ? { handle: stored } : {}), disk, event: 'saved' },
            },
        })
        .catch(() => false)
    if (!done) return false
    removeMarker(env.chainId, marker.entry.revisionId)
    rememberHandle(env.chainId, handle)
    const record = await env.worker.call('readChainRecord', env.chainId).catch(() => undefined)
    if (record) env.session.chain = record
    if (currentSession.value.sessionId === env.session.id)
        bindFile({
            name: handle.name,
            event: 'saved',
            ...(typeof unit.file.at === 'number' ? { at: unit.file.at } : {}),
            hash: marker.unit.file.hash,
        })
    return true
}

type CheckOutcome = Outcome | { kind: 'noChanges'; event: StoredFile['event'] }

type Checked =
    | { kind: 'write'; binding: Binding; file: StoredFile; expected: DiskState }
    | { kind: 'outcome'; outcome: CheckOutcome }
    | { kind: 'revoked'; binding: Binding }

/**
 * Under `nse-bind` shared: the binding read again (R10), and when nothing changed since its file
 * event, the check alone (§1.4.7's "Nothing changed" row).
 */
const check = async (env: Env, handle: FileSystemFileHandle): Promise<Checked> => {
    const binding = await readBinding(env)
    const file = binding.file
    if (!file || binding.replaced) return { kind: 'revoked', binding }
    if (file.name !== handle.name) return { kind: 'revoked', binding }
    const expected = file.disk ?? NO_DISK
    if (rootOf(savedState()) !== toHex(file.hash)) return { kind: 'write', binding, file, expected }
    let disk: DiskState | 'missing'
    try {
        disk = await platform.inspect({ kind: 'handle', handle }, 'nxsp')
    } catch (error) {
        return {
            kind: 'outcome',
            outcome: { kind: 'failed', error: fileError(error), name: file.name },
        }
    }
    if (disk === 'missing')
        return {
            kind: 'outcome',
            outcome: {
                kind: 'failed',
                error: new FileError('not-found', 'Not found'),
                name: file.name,
            },
        }
    if (sameContent(disk, expected))
        return { kind: 'outcome', outcome: { kind: 'noChanges', event: file.event } }
    // An empty file holds nothing to keep (R9).
    if (disk.size === 0) return { kind: 'write', binding, file, expected: disk }
    return { kind: 'outcome', outcome: { kind: 'conflict', handle, binding } }
}

/**
 * The write-back, under `nse-bind` shared: the check pins the file; the writer appends to it; a
 * change before `close()` aborts; the read-back confirms; the binding follows (§1.4.7).
 */
const writeBackLocked = async (
    env: Env,
    handle: FileSystemFileHandle,
): Promise<CheckOutcome | 'revoked'> => {
    for (let attempt = 0; attempt < 2; attempt++) {
        const checked = await check(env, handle)
        if (checked.kind === 'revoked') return 'revoked'
        if (checked.kind === 'outcome') {
            if (checked.outcome.kind !== 'conflict') return checked.outcome
            if (attempt === 0 && (await recognise(env, checked.outcome.binding, handle))) continue
            return checked.outcome
        }
        const outcome = await writeBack(
            env,
            handle,
            checked.binding,
            checked.file,
            checked.expected,
        )
        if (outcome.kind !== 'conflict' || attempt > 0) return outcome
        if (!(await recognise(env, outcome.binding, handle))) return outcome
    }
    return { kind: 'cancelled' }
}

/** Our own completed Save, checked on the file as it is now. */
const recognise = async (env: Env, binding: Binding, handle: FileSystemFileHandle) => {
    try {
        const file = await handle.getFile()
        const disk = await platform.inspect({ kind: 'handle', handle }, 'nxsp')
        if (disk === 'missing') return false
        return await ownCompletedSave(env, binding, handle, file, disk)
    } catch {
        return false
    }
}

const writeBack = async (
    env: Env,
    handle: FileSystemFileHandle,
    binding: Binding,
    file: StoredFile,
    expected: DiskState,
    /** Replace: the revision of the version on disk, kept first (§1.4.7). */
    replaces?: string,
): Promise<Outcome> => {
    const reservation = env.flusher.reserveSave()
    if (!reservation) return { kind: 'cancelled' }
    const state = savedState()
    const slot = preparingFor(file.name)
    let built: BuiltSave | undefined
    let bound: Row = {}
    let result: SaveResult
    whenSlow(slot)
    try {
        result = await platform.saveFile({
            kind: 'nxsp',
            suggestedName: file.name,
            target: { kind: 'handle', handle },
            expected,
            // A target found empty holds nothing to keep: written, never a conflict (R9).
            overEmpty: true,
            build: async (sources) => {
                const source = replaces
                    ? undefined
                    : sources.find((each) => each.token === 'target')
                built = await runBuild(
                    env,
                    {
                        target: replaces
                            ? { kind: 'replace', replaces }
                            : source && binding.revision
                              ? { kind: 'append', source: 'target' }
                              : { kind: 'copy' },
                        history: file.options.history,
                        bgm: file.options.bgm,
                        fileName: file.name,
                        save: { time: reservation.wall, label: entryLabel(file.name, false)() },
                        state,
                    },
                    source ? [source] : [],
                )
                bound = await bindingFile(built, reservation, {
                    name: file.name,
                    event: 'saved',
                    handle,
                    options: { history: !!built.identity.entry, bgm: file.options.bgm },
                })
                writeMarker(markerOf(env, built, reservation, binding.revision?.id ?? null, bound))
                return { kind: 'blob', blob: built.blob }
            },
        })
    } catch (error) {
        closePreparing(slot)
        // Once built, the write may have landed: its `seq` stays for the marker.
        const unwritten = !built || (error instanceof FileError && notWritten(error))
        if (built && unwritten) removeMarker(env.chainId, built.revisionId)
        await env.flusher.endSave(reservation, undefined, undefined, !unwritten)
        if (error instanceof BuildRefused) {
            if (error.refusal.refused === 'damagedSource') return unlinkAndSaveAs(env, file.name)
            return { kind: 'error', message: refusalText(error, file.name) }
        }
        const failure = fileError(error)
        if (failure.code === 'conflict') return { kind: 'conflict', handle, binding }
        return { kind: 'failed', error: failure, name: file.name }
    }
    closePreparing(slot)
    if (result.status !== 'saved' || !built) {
        await env.flusher.endSave(reservation)
        return { kind: 'cancelled' }
    }
    await savePoint('closed')
    const done = built
    await bindWrite(env, reservation, done, state, {
        ...bound,
        ...(result.disk ? { disk: result.disk } : {}),
    })
    rememberHandle(env.chainId, handle)
    feedback(done, 'saved', file.name)
    return { kind: 'done' }
}

/** An append that met damage in the chain's own file: the chain unlinks, and Save As… follows. */
const unlinkAndSaveAs = async (env: Env, name: string): Promise<Outcome> => {
    const docId = crypto.randomUUID()
    const record = await env.worker
        .call('unlinkChain', {
            chainId: env.chainId,
            docId,
            appVersion: appVersion().appVersion,
        })
        .catch(() => undefined)
    if (record) {
        env.session.docId = docId
        env.session.chain = record
        journalWriter?.rewrite()
        unbindFile()
        currentSession.value = { ...currentSession.value, docId, copyOf: { name, bound: true } }
        exportMemory.partial = true
    }
    forgetHandle(env.chainId)
    pendingLine = interpolate(() => i18n.value.open.damagedHistory, name)
    return { kind: 'cancelled' }
}

/** A line the next Save dialog shows first (the damage unlink's notice). */
let pendingLine: (() => string) | undefined

// The follow-up dialogs.

/** "Saved on iPad, Oct 16, 2:41 PM · 1,220 notes." or another project's name. */
/** The conflict dialog's facts, and the `File` and disk state Replace keeps and writes over. */
const conflictInput = async (env: Env, binding: Binding, handle: FileSystemFileHandle) => {
    let facts: DiskFacts = { version: { kind: 'unknown' } }
    let replaceDisabled: (() => string) | undefined
    let pinned: { file: File; disk: DiskState } | undefined
    let relation: string | undefined
    try {
        const file = await handle.getFile()
        const disk = await platform.inspect({ kind: 'handle', handle }, 'nxsp')
        facts = await readDiskFacts(file, deviceId())
        if (disk !== 'missing') pinned = { file, disk }
        if (disk !== 'missing' && facts.projectJson !== undefined) {
            const decision = await env.worker.call('replaceDecision', {
                chainId: env.chainId,
                projectJson: facts.projectJson,
                fingerprint: disk.fingerprint,
            })
            relation = decision?.relation
            if (decision?.holdsBase) replaceDisabled = () => i18n.value.conflict.replaceHoldsEarlier
        }
    } catch {
        // What is on disk cannot be read: the title and body say enough.
    }
    const version: DiskVersion = otherProject(facts, binding.docId) ?? facts.version
    replaceDisabled ??= replaceUnavailable(facts, pinned?.disk)
    return {
        input: {
            name: handle.name,
            disk: version,
            ...(replaceDisabled ? { replaceDisabled } : {}),
        },
        pinned,
        newer: relation === 'newer',
    }
}

/**
 * Why Replace cannot keep the version on disk first (§1.4.7): a file this build cannot import
 * whole, or storage that cannot take it; undefined when it can.
 */
const replaceUnavailable = (facts: DiskFacts, disk: DiskState | undefined) => {
    const project = isRow(facts.projectJson) ? facts.projectJson : undefined
    if (!disk?.revisionId || !project) return () => i18n.value.open.damaged
    if (
        (typeof project.version === 'number' && project.version > NXSP_VERSION) ||
        (typeof project.minor === 'number' && project.minor > NXSP_MINOR)
    )
        return replaceNewerLine
    const status = storageStatus.value
    if (isSafeMode() || status?.mode !== 'stored' || status.reason !== undefined)
        return () => i18n.value.notSaving.bar
    return undefined
}

const conflictFlow = async (env: Env, binding: Binding, handle: FileSystemFileHandle) => {
    // The version on disk read first, in case Save as a Separate File's picker returns it (R2).
    const pre = preRead(env, binding)
    const { input, pinned, newer } = await conflictInput(env, binding, handle)
    setDiskFinding(newer ? 'newer' : 'changed')
    const choice: ConflictChoice | undefined = await saveUi.conflict(input)
    switch (choice) {
        case 'separate':
            await separateFile(env, binding, handle, pre)
            return
        case 'openOther': {
            const file = await handle.getFile().catch(() => undefined)
            if (!file) return
            const { openProject } = await import('../commands/open/project')
            await openProject(file, handle)
            return
        }
        case 'replace':
            if (pinned) await replace(env, handle, pinned)
            return
        case undefined:
            return
    }
}

/**
 * Replace (§1.4.7, Part 0 §0.9.6): the version on disk is kept first, as an ordinary session in
 * Recent Sessions, committed before anything is written; then the file is written with `replaces`,
 * while it still equals the kept copy. A change meanwhile shows the dialog again.
 */
const replace = async (
    env: Env,
    handle: FileSystemFileHandle,
    pinned: { file: File; disk: DiskState },
) => {
    const replaces = pinned.disk.revisionId
    if (!replaces) return
    const { keepReplaced } = await import('../commands/open/project')
    const stem = shownStem(env, savedState()) || stemOf(handle.name)
    const keptName = interpolateRaw(i18n.value.conflict.keptName, stem, formatDate(Date.now()))
    const kept = await keepReplaced(pinned.file, keptName)
    if (kept !== 'kept') {
        saveUi.error(
            kept === 'newer'
                ? replaceNewerLine
                : kept === 'damaged'
                  ? () => i18n.value.open.damaged
                  : () => i18n.value.notSaving.bar,
        )
        return
    }
    const outcome = await withBind('shared', async (): Promise<Outcome> => {
        const binding = await readBinding(env)
        const file = binding.file
        if (!file || binding.replaced || file.name !== handle.name) return { kind: 'cancelled' }
        return writeBack(env, handle, binding, file, pinned.disk, replaces)
    })
    await afterOutcome(env, outcome)
}

/** Save as a Separate File (§1.4.7): keeps the `docId`, in the original's folder. */
const separateFile = async (
    env: Env,
    binding: Binding,
    handle: FileSystemFileHandle,
    pre: Promise<PreRead | undefined>,
) => {
    const stem = stemOf(handle.name)
    const engine = deviceForm().label.replace(/^Web \((.*)\)$/, '$1')
    const name = await suggestion(env, `${stem} (${engine}, ${nameTime(Date.now())})`)
    const options = binding.file?.options ?? { history: true, bgm: true }
    await afterOutcome(
        env,
        await pickAndWrite(env, {
            dialog: 'separate',
            fileName: `${name}.nxsp`,
            history: options.history,
            bgm: options.bgm,
            target: 'copy',
            startIn: handle,
            pre,
        }),
    )
}

/** Shows what an outcome needs: a follow-up dialog, or nothing. */
const afterOutcome = async (env: Env, outcome: Outcome | { kind: 'noChanges' }): Promise<void> => {
    switch (outcome.kind) {
        case 'done':
        case 'cancelled':
        case 'noChanges':
            if (pendingLine) {
                const line = pendingLine
                pendingLine = undefined
                await dialogSave(env, 'saveAs', [line], true)
            }
            return
        case 'error':
            saveUi.error(outcome.message)
            return
        case 'conflict':
            // Only a binding of this very file has a conflict dialog (m5): anything else changed.
            if (outcome.binding.file?.name !== outcome.handle.name) {
                await afterOutcome(env, changedWhilePicked(outcome.handle.name))
                return
            }
            await conflictFlow(env, outcome.binding, outcome.handle)
            return
        case 'refused': {
            if (outcome.emptied && outcome.reason !== 'safeMode') {
                const bytes = outcome.bytes
                const choice = await saveUi.notPutBack(outcome.name, true)
                if (choice === 'download' && bytes) await downloadBytes(outcome.name, bytes)
                return
            }
            const choice = await saveUi.refused(outcome.name, outcome.reason)
            if (choice === 'chooseAnother') await dialogSave(env, 'save')
            else if (choice === 'export') {
                await openExport()
            }
            return
        }
        case 'failed': {
            const { error, name } = outcome
            console.warn('A Save failed', error)
            const writable = !!platform.pickSaveFile
            let choice: 'saveAs' | 'tryAgain' | undefined
            switch (error.code) {
                case 'not-found':
                    setDiskFinding('missing')
                    choice = await saveUi.notFound(name)
                    if (choice === 'saveAs') await notFoundSaveAs(env)
                    return
                case 'denied':
                    choice = await saveUi.denied(name)
                    // Try Again asks for permission again, on this press.
                    if (choice === 'tryAgain') await saveNow(env)
                    else if (choice === 'saveAs') await dialogSave(env, 'saveAs')
                    return
                case 'no-space':
                case 'not-local':
                case 'conflict':
                case 'read-only':
                case 'io':
                    break
            }
            if (error.code === 'read-only') choice = await saveUi.readOnly(name)
            else choice = await saveUi.failed(name, () => fileErrorText(name, error), writable)
            if (choice === 'saveAs') await dialogSave(env, 'saveAs')
            return
        }
    }
}

/** Export Level Data… (the Save dialog's Export line, R7's refusal), as its command runs. */
const openExport = async () => {
    const { commands } = await import('../commands')
    const { runCommand } = await import('../commands/runCommand')
    await runCommand(commands.exportLevel)
}

/** Downloads bytes kept at an open that could not be put back (§1.4.7 R7, Step 1c). */
const downloadBytes = async (name: string, bytes: Blob) => {
    try {
        const result = await platform.saveFile({
            kind: 'recovery',
            suggestedName: name,
            build: () => Promise.resolve(bytes),
        })
        if (result.status === 'download-started')
            saveUi.saved({
                kind: 'download',
                name,
                size: bytes.size,
                someStepsNotKept: false,
                tookOver: false,
                without: [],
                tooLarge: [],
            })
    } catch {
        saveUi.error(interpolate(() => i18n.value.save.downloadFailed, name))
    }
}

/** The not-found dialog's Save As…: keeps the identity and Export target, writes a new file. */
const notFoundSaveAs = async (env: Env) => {
    const binding = quickBinding(env)
    const stem = copyStem(binding.file ? stemOf(binding.file.name) : shownStem(env, savedState()))
    const name = await suggestion(env, stem)
    const input = dialogInput(env, 'saveAs', name, [])
    const result = await saveUi.saveDialog(input)
    if (result?.action !== 'save') return
    await afterOutcome(
        env,
        await pickAndWrite(env, {
            dialog: 'notFound',
            fileName: result.fileName,
            ...answered(input, result, binding),
            target: 'copy',
        }),
    )
}

const dialogInput = (
    env: Env,
    kind: SaveDialogKind,
    name: string,
    lines: (() => string)[],
): SaveDialogInput => {
    const state = savedState()
    const binding = quickBinding(env)
    const options = binding.file?.options
    const meta = state.bgm.meta
    const held = !!state.bgm.source
    // A first Save after an open by name writes that file again: its history stays (§0.9.7).
    const kept = kind === 'save' && binding.file?.event === 'opened' && !!binding.file.entry
    return {
        kind,
        name,
        lines,
        // Hashing needs a secure context: elsewhere a file holds no history (§1.4.7).
        history: globalThis.isSecureContext
            ? {
                  kind: 'available',
                  ticked: kept || (options?.history ?? true),
                  locked: kept,
                  steps: 0,
                  ...(kept && binding.file ? { keptIn: binding.file.name } : {}),
              }
            : { kind: 'insecure' },
        bgm: meta
            ? held
                ? {
                      kind: 'held',
                      name: meta.filename || (state.bgm.filename ?? 'BGM'),
                      ticked: kind === 'saveAs' ? true : (options?.bgm ?? true),
                      locked: false,
                  }
                : { kind: 'notLoaded' }
            : { kind: 'none' },
        exportLine:
            exportMemory.target !== undefined ||
            exportMemory.sourceName !== undefined ||
            (launch.isExistingUser && !exportUsed.value),
        downloadNote: !platform.pickSaveFile && !firstSaveDone.value,
        peeking: isPeeking.value,
        estimate: {
            load: () =>
                env.worker
                    .call('estimateSaveSize', {
                        chainId: env.chainId,
                        ...(meta ? { bgm: meta.hash } : {}),
                    })
                    .catch(() => undefined),
        },
    }
}

/**
 * The options a dialog's answer sets (§1.4.7): a disabled row never changes its option, so only a
 * user's untick sets `bgm` false; with no hashing, no history.
 */
const answered = (
    input: SaveDialogInput,
    result: { history: boolean; bgm: boolean },
    binding: Binding,
) => ({
    history: input.history.kind === 'available' && result.history,
    bgm:
        input.bgm.kind === 'held' && !input.bgm.locked
            ? result.bgm
            : (binding.file?.options.bgm ?? true),
})

/** The Save dialog, then the picker or a download (§1.4.7's "Not bound" row and Save As…). */
const dialogSave = async (
    env: Env,
    kind: 'save' | 'saveAs',
    lines: (() => string)[] = [],
    unlinked = false,
) => {
    const binding = quickBinding(env)
    const state = savedState()
    const copy =
        kind === 'saveAs' ||
        unlinked ||
        !!binding.replaced ||
        currentSession.value.copyOf !== undefined ||
        exportMemory.partial === true
    const stem = shownStem(env, state) || (binding.replaced ? stemOf(binding.replaced.name) : '')
    const name = await suggestion(env, copy ? copyStem(stem) : stem)
    const replaced = binding.replaced
    const replacedLine = replaced
        ? [interpolate(() => i18n.value.file.replacedElsewhere, replaced.name)]
        : []
    // R2: this chain's own file read first, when it may hold what storage lacks.
    const pre = kind === 'saveAs' && binding.file ? preRead(env, binding) : undefined
    const input = dialogInput(env, kind, name, [...lines, ...replacedLine])
    const result = await saveUi.saveDialog(input)
    if (!result) return
    if (result.action === 'export') {
        await openExport()
        return
    }
    await afterOutcome(
        env,
        await pickAndWrite(env, {
            dialog: kind,
            fileName: result.fileName,
            ...answered(input, result, binding),
            // Save As… gives a new `docId`; a first Save, a fork's and a taken-over chain's keep it.
            target: kind === 'saveAs' && !unlinked ? 'new' : 'copy',
            ...(pre ? { pre } : {}),
        }),
    )
}

/** A Save bound by name (a download, or a file opened without a handle). */
const downloadAgain = async (env: Env, file: StoredFile) => {
    await commitFirst(env)
    const reservation = env.flusher.reserveSave()
    if (!reservation) return
    const state = savedState()
    const slot = preparingFor(file.name)
    whenSlow(slot)
    let built: BuiltSave
    try {
        built = await runBuild(env, {
            target: { kind: 'copy' },
            history: file.options.history,
            bgm: file.options.bgm,
            fileName: file.name,
            save: { time: reservation.wall, label: entryLabel(file.name, true)() },
            state,
        })
    } catch (error) {
        closePreparing(slot)
        await env.flusher.endSave(reservation)
        await afterOutcome(
            env,
            error instanceof BuildRefused
                ? { kind: 'error', message: refusalText(error, file.name) }
                : { kind: 'failed', error: fileError(error), name: file.name },
        )
        return
    }
    clearTimeout(slot.timer)
    await afterOutcome(
        env,
        await download(
            env,
            reservation,
            built,
            state,
            { dialog: 'save', fileName: file.name, ...file.options },
            slot,
        ),
    )
}

/** Save (§1.4.7): write-back, a download by name, or the Save dialog. */
export const save = () =>
    exclusive(async () => {
        const env = environment()
        if (!env) {
            saveUi.error(() => i18n.value.save.unavailable)
            return
        }
        await saveNow(env)
    })

const saveNow = async (env: Env) => {
    const binding = quickBinding(env)
    const file = binding.file
    if (!file || binding.replaced) {
        await dialogSave(env, 'save')
        return
    }
    const handle = platform.pickSaveFile ? await bindingHandle(env, file) : undefined
    if (!handle) {
        // By name: the first Save after an open shows the dialog; an unchanged download asks.
        if (file.event === 'opened') {
            await dialogSave(env, 'save')
            return
        }
        if (rootOf(savedState()) === toHex(file.hash)) {
            saveUi.noChanges(file.name, 'downloaded', () => {
                void exclusive(async () => {
                    // Pressed later: only for the session it was shown for, as it is now.
                    const now = environment()
                    const bound = now?.session === env.session && quickBinding(now).file
                    if (now && bound && bound.name === file.name) await downloadAgain(now, bound)
                })
            })
            return
        }
        await downloadAgain(env, file)
        return
    }
    // The gesture's first call (Part 0 §0.9.1).
    const permission = requestWrite(handle)
    permission.catch(() => undefined)
    await commitFirst(env)
    let granted: PermissionState
    try {
        granted = await permission
    } catch {
        granted = 'denied'
    }
    if (granted !== 'granted') {
        await afterOutcome(env, {
            kind: 'failed',
            error: new FileError('denied', 'Not allowed'),
            name: file.name,
        })
        return
    }
    const slot = preparingFor(file.name)
    const waited = await waitForImport(env, slot)
    closePreparing(slot)
    if (waited === 'cancelled') return
    if (waited === 'unlinked') {
        await dialogSave(
            env,
            'saveAs',
            [interpolate(() => i18n.value.open.damagedHistory, file.name)],
            true,
        )
        return
    }
    const outcome = await withBind('shared', () => writeBackLocked(env, handle))
    if (outcome === 'revoked') {
        // Taken over (R6): the label goes, and the dialog says why.
        await refreshOwn(env)
        await dialogSave(env, 'save')
        return
    }
    if (outcome.kind === 'noChanges') {
        saveUi.noChanges(file.name, outcome.event === 'opened' ? 'opened' : 'saved')
        return
    }
    await afterOutcome(env, outcome)
}

/** Save As… (§1.4.7): always the dialog, a new `docId` (R4 keeps it for the chain's own file). */
export const saveAs = () =>
    exclusive(async () => {
        const env = environment()
        if (!env) {
            saveUi.error(() => i18n.value.save.unavailable)
            return
        }
        await dialogSave(env, 'saveAs')
    })

// Save to File… (Recent Sessions' ⋯; §1.4.7): Save As for a session that isn't open.

/**
 * Save to File…: the session's pending journal applied first under its lock, its head with its
 * history written as a new `.nxsp` with a new `docId`, binding nothing. Its picker follows the
 * rules above: a file a chain is bound to is taken from it (R5, R6). A session open in another
 * tab is written as storage holds it, and the feedback says so.
 */
export const saveToFile = (sessionId: string) =>
    exclusive(async () => {
        const env = environment()
        if (!env) {
            saveUi.error(() => i18n.value.save.unavailable)
            return
        }
        const { applyPendingJournal } = await import('../../local/startup/api')
        const applied = await applyPendingJournal(sessionId).catch(() => undefined)
        const read = await env.worker.call('readSession', sessionId).catch(() => undefined)
        if (read?.kind !== 'open') {
            saveUi.error(() => i18n.value.save.unavailable)
            return
        }
        const chainId = read.session.chainId as string
        const shown = displayName(namePartsOf(read.chain))
        const stem =
            shown.kind === 'date'
                ? ''
                : shown.kind === 'name' || shown.kind === 'title'
                  ? shown.text
                  : stemOf(shown.text)
        const updatedAt =
            typeof read.session.updatedAt === 'number' ? read.session.updatedAt : Date.now()
        const name = await suggestion(
            env,
            stem ? interpolateRaw(i18n.value.save.restoredName, stem, formatDate(updatedAt)) : '',
        )
        const input: SaveDialogInput = {
            kind: 'saveToFile',
            name,
            lines: [],
            history: globalThis.isSecureContext
                ? { kind: 'available', ticked: true, locked: false, steps: 0 }
                : { kind: 'insecure' },
            bgm: { kind: 'held', name: 'BGM', ticked: true, locked: false },
            exportLine: false,
            downloadNote: !platform.pickSaveFile && !firstSaveDone.value,
            peeking: false,
            estimate: {
                load: () =>
                    env.worker
                        .call('estimateSaveSize', { chainId, sessionId })
                        .catch(() => undefined),
            },
        }
        const result = await saveUi.saveDialog(input)
        if (result?.action !== 'save') return
        const options = answered(input, result, { docId: '' })
        // Its session hold before the build, so Delete Sessions… skips it (§1.6.6).
        await withSessionHold(sessionId, async () => {
            const outcome = await writeSessionFile(env, {
                chainId,
                sessionId,
                fileName: result.fileName,
                ...options,
                committed: applied === 'held',
            })
            await afterOutcome(env, outcome)
        })
    })

/** Holds a session's lock shared while it's written, when no tab holds it exclusively. */
const withSessionHold = async (sessionId: string, run: () => Promise<void>) => {
    const { holdShared } = await import('../../local/startup/open')
    const held = await holdShared(platform.locks, sessionId).catch(() => undefined)
    try {
        await run()
    } finally {
        held?.release()
    }
}

/** Builds a session that isn't open as a new file and writes it, binding nothing. */
const writeSessionFile = async (
    env: Env,
    request: {
        chainId: string
        sessionId: string
        fileName: string
        history: boolean
        bgm: boolean
        committed: boolean
    },
): Promise<Outcome> => {
    const slot = preparingFor(request.fileName)
    const startedAt = performance.now()
    whenSlow(slot)
    const built = await env.worker
        .call(
            'buildSave',
            {
                chainId: request.chainId,
                target: { kind: 'new', docId: crypto.randomUUID(), sessionId: request.sessionId },
                options: {
                    history: request.history,
                    bgm: request.bgm,
                    fileName: request.fileName,
                    save: {
                        time: Date.now(),
                        label: entryLabel(request.fileName, !platform.pickSaveFile)(),
                    },
                    context: {
                        now: Date.now(),
                        device: deviceForm(),
                        appVersion: appVersion().appVersion,
                    },
                    sessionId: request.sessionId,
                },
            },
            { timeoutMs: 10 * 60_000 },
        )
        .catch((error: unknown) => fileError(error))
    clearTimeout(slot.timer)
    if (built instanceof FileError) {
        closePreparing(slot)
        return { kind: 'failed', error: built, name: request.fileName }
    }
    if ('refused' in built) {
        closePreparing(slot)
        return {
            kind: 'error',
            message: refusalText(new BuildRefused(built), request.fileName),
        }
    }
    const pickSaveFile = platform.pickSaveFile
    if (!pickSaveFile) {
        let result: SaveResult
        try {
            result = await platform.saveFile({
                kind: 'nxsp',
                suggestedName: request.fileName,
                build: () => Promise.resolve({ kind: 'blob', blob: built.blob }),
                ready: (file) => openPreparing(slot).ready('download', file.size),
            })
        } catch (error) {
            closePreparing(slot)
            return { kind: 'failed', error: fileError(error), name: request.fileName }
        }
        closePreparing(slot)
        if (result.status !== 'download-started') return { kind: 'cancelled' }
        saveUi.saved({
            ...savedOf(built, 'download', request.fileName),
            committedState: request.committed,
        })
        markFirstSaveDone()
        return { kind: 'done' }
    }
    if (
        activationLapsed(startedAt) &&
        !(await openPreparing(slot).ready('save', built.blob.size))
    ) {
        closePreparing(slot)
        return { kind: 'cancelled' }
    }
    closePreparing(slot)
    let target: FileTarget | undefined
    try {
        target = await pickSaveFile({
            suggestedName: request.fileName,
            picker: {
                id: PICKER_ID,
                types: [{ description: i18n.value.save.fileType, extension: '.nxsp' }],
                excludeAll: true,
                startIn: 'documents',
            },
        })
    } catch (error) {
        return { kind: 'failed', error: fileError(error), name: request.fileName }
    }
    if (target?.kind !== 'handle') return { kind: 'cancelled' }
    const picked = target
    return withBind('exclusive', async (): Promise<Outcome> => {
        const { handle } = picked
        let empty: DiskState
        try {
            const found = await platform.inspect(picked, 'nxsp')
            if (found === 'missing')
                throw new FileError('not-found', `${handle.name} cannot be found`)
            empty = found
        } catch (error) {
            return { kind: 'failed', error: fileError(error), name: handle.name }
        }
        // Written since the pick (a sync client): never written over unseen (R9).
        if (empty.size !== 0)
            return {
                kind: 'failed',
                error: new FileError('conflict', `${handle.name} changed`),
                name: handle.name,
            }
        const identity = refusedTarget(env, await identify(env, handle))
        let tookOver = false
        if (identity.kind === 'refused') {
            const bytes = await identity.bytes
            const back = bytes ? await putBack(picked, bytes) : false
            return {
                kind: 'refused',
                name: handle.name,
                reason: identity.reason,
                emptied: !back,
                ...(bytes ? { bytes } : {}),
            }
        }
        if (identity.kind !== 'unknown') {
            // It binds nothing: the chain bound to the file loses it (R5, R6).
            const own = quickBinding(env).file
            const owner: HandleOwner | undefined =
                identity.kind === 'other'
                    ? identity.owner
                    : own && {
                          chainId: env.chainId,
                          role: 'file',
                          name: own.name,
                          at: own.at,
                          handle: true,
                      }
            const done = await revoke(env, owner, undefined)
            if (!done.ok) return notTakenOver(handle.name)
            tookOver = done.revoked
            if (identity.kind === 'own' && done.revoked) {
                forgetHandle(env.chainId)
                void refreshOwn(env)
            }
        }
        try {
            await platform.saveFile({
                kind: 'nxsp',
                suggestedName: handle.name,
                target: picked,
                expected: empty,
                build: () => Promise.resolve({ kind: 'blob', blob: built.blob }),
            })
        } catch (error) {
            const failure = fileError(error)
            return { kind: 'failed', error: failure, name: handle.name }
        }
        if (tookOver) broadcastUpdated()
        saveUi.saved({
            ...savedOf(built, 'saved', handle.name, tookOver),
            committedState: request.committed,
        })
        markFirstSaveDone()
        return { kind: 'done' }
    })
}

/** The open chain lost its file to this tab's own Save to File…: its label follows (R6). */
const refreshOwn = (env: Env) => refreshBinding(env.worker, env.flusher)

// Export's picker (§1.4.7, `work/d5/safety.md` E1–E5).

/** Export's read of this chain's own file, from its dialog's opening to its close (R2). */
let exportRead: Promise<PreRead | undefined> | undefined

/** Export's dialog opened: this chain's own file is read first when it may hold more (R2). */
export const startExportRead = () => {
    const env = environment()
    const binding = env && quickBinding(env)
    exportRead = env && binding?.file && !binding.replaced ? preRead(env, binding) : undefined
}

/** Export's dialog closed: the bytes read go. */
export const endExportRead = () => {
    exportRead = undefined
}

/**
 * A pick in Export's picker, under `nse-bind` exclusive held across Export's write (§1.4.8): this
 * chain's own `.nxsp` is written again keeping its identity (from the bytes read first, R2) and
 * refused; another chain's is taken over (its binding revoked) and Export writes it; another
 * chain's Export target loses it (R5).
 */
export const projectPick = async (handle: FileSystemFileHandle): Promise<ProjectPick> => {
    const env = environment()
    if (!env) return
    const picked = await identify(env, handle)
    if (
        picked.kind === 'other' ||
        (picked.kind === 'target' && picked.owner.chainId !== env.chainId)
    ) {
        const done = await revoke(env, picked.owner, undefined)
        if (done.revoked) broadcastUpdated()
        return 'taken'
    }
    // A partial open's file (E7): refused, and its kept bytes put back.
    if (picked.kind === 'refused' && picked.reason === 'notKept')
        return { keep: picked.bytes ?? Promise.resolve(undefined) }
    if (picked.kind !== 'own') return
    const binding = quickBinding(env)
    const file = binding.file
    const pre = await settledNow(exportRead)
    const reservation = file && env.flusher.reserveSave()
    // Left empty: shown, and the next Save fills it (R9).
    if (!file || !reservation)
        return {
            show: () =>
                afterOutcome(env, {
                    kind: 'failed',
                    error: new FileError('io', `${handle.name} was not written again`),
                    name: handle.name,
                }),
        }
    try {
        const outcome = await afterPick(
            env,
            reservation,
            undefined,
            savedState(),
            { dialog: 'save', fileName: handle.name, ...file.options, target: 'copy' },
            binding,
            { kind: 'handle', handle },
            pre,
        )
        if (outcome.kind === 'done') return 'own'
        return { show: () => afterOutcome(env, outcome) }
    } finally {
        await release(env, reservation)
    }
}

// The file state's actions (`src/editor/file`): its chip dialogs and notices run these.

/** The not-found chip's Save As…: keeps the chain's identity (§1.4.7). */
export const fileSaveAs = () =>
    exclusive(async () => {
        const env = environment()
        if (env) await notFoundSaveAs(env)
    })

/** Download Again: builds and downloads the bound file once more. */
export const fileDownloadAgain = () =>
    exclusive(async () => {
        const env = environment()
        const file = env && quickBinding(env).file
        if (env && file) await downloadAgain(env, file)
    })

/** Open the Other Version: the file on disk as a new session in place of this one (§0.9.6). */
export const openOtherVersion = async () => {
    const env = environment()
    const file = env && quickBinding(env).file
    if (!env || !file) return
    const handle = await bindingHandle(env, file)
    const opened = await handle?.getFile().catch(() => undefined)
    if (!handle || !opened) return
    const { openProject } = await import('../commands/open/project')
    await openProject(opened, handle)
}

/** I Have the File: `file.confirmed` stored on the chain record (§1.3.4). */
export const persistConfirmed = () => {
    const env = environment()
    if (!env) return
    const { session } = env
    if (session.identity) {
        session.identity = {
            ...session.identity,
            file: { ...session.identity.file, confirmed: true },
        }
        return
    }
    const file = session.chain?.file
    if (isRow(file)) void env.flusher.setChainFields({ file: { ...file, confirmed: true } })
}

// Broadcasts: a takeover tells other tabs to read their record again (§1.6.6).

let channel: BroadcastChannel | undefined

const broadcastUpdated = () => {
    try {
        channel ??= new BroadcastChannel('nse-local-data')
        channel.postMessage({ type: 'sessionUpdated' })
    } catch {
        // A hint only: the other tab's next write reads its binding again (R10).
    }
}
