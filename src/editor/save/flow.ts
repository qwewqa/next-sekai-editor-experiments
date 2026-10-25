import { recordError } from '../../diagnostics'
import { createHistoryOperation } from '../../history/createHistoryOperation'
import { captureName, entryOperation as operationOfEntry } from '../../history/operations'
import { session as currentSession } from '../../history/session'
import { isPeeking } from '../../history/stack'
import { i18n } from '../../i18n'
import { formatDateTime } from '../../i18n/dateTime'
import { formatDate } from '../../i18n/when'
import { launch } from '../../launch'
import type { SaveReservation } from '../../local/flush'
import { storableHandle } from '../../local/handles'
import { toHex } from '../../local/hash'
import {
    displayName,
    hasCopyNumber,
    namePartsOf,
    nextCopyName,
    prefillOf,
    stemOf,
} from '../../local/names'
import { NXSP_MINOR, NXSP_VERSION } from '../../local/nxsp/version'
import { isImporting, whenImported } from '../../local/open/importLoop'
import type { HandleOwner } from '../../local/save/bind'
import type { IdentityUnit } from '../../local/save/commit'
import type { SaveSizeEstimate } from '../../local/save/estimate'
import type { BuiltSave } from '../../local/save/execute'
import { bindingHasHistory } from '../../local/save/model'
import { storageStatus } from '../../local/startup/events'
import { readValue, storedRead } from '../../local/storedRead'
import { appVersion, FileError, platform, type DiskState, type SaveResult } from '../../platform'
import { sameContent } from '../../platform/fingerprint'
import { requestWrite } from '../../platform/handover'
import { savePoint } from '../../platform/testPause'
import { PRODUCT_NAME } from '../../product'
import { isSafeMode } from '../../safe'
import { settings } from '../../settings'
import type { State } from '../../state'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { fileError } from '../commands/exportLevel/errorText'
import { validName } from '../commands/exportLevel/fileName'
import { clearExportDestination, exportMemory } from '../commands/exportLevel/memory'
import { knownTargetAvailable } from '../commands/exportLevel/ownership'
import { fileErrorText } from '../commands/exportLevel/ui'
import { bindFile } from '../file'
import { exportUsed, firstSaveDone, markFirstSaveDone } from '../file/flags'
import { setDiskFinding } from '../file/state'
import { withSwitchRequest, type SwitchRequest } from '../switchRequest'
import {
    bindingHandle,
    environment,
    quickBinding,
    readBinding,
    type Binding,
    type Env,
    type StoredFile,
} from './binding'
import { BuildRefused, headHashOf, rootOf, runBuild } from './build'
import {
    replaceNewerLine,
    saveUi,
    type BgmRow,
    type ConflictChoice,
    type DiskVersion,
    type RefusedReason,
    type SaveDialogInput,
    type SaveDialogKind,
} from './dialogs'
import { otherProject, readDiskFacts, type DiskFacts } from './disk'
import {
    deviceLabel,
    deviceSource,
    forgetHandle,
    heldHandle,
    markerFile,
    markerUnit,
    ownDeviceId,
    readMarker,
    rememberHandle,
    removeMarker,
    savedState,
    withBind,
    type SaveMarker,
} from './env'
import { pause, RESUME_WAIT_MS } from './imports'
import {
    projectPicker,
    readOwnFile,
    withPickSession,
    type Dismissed,
    type PickedFile,
    type PickSession,
    type ReadResult,
} from './pickSession'
import {
    estimatedTotal,
    estimateKey,
    isTouchDevice,
    knownEstimate,
    LARGE_BUILD_BYTES,
    noteLoaded,
    rememberEstimate,
    storageNote,
} from './preview'
import { exclusive } from './queue'
import { Cancelled, withSaveAttempt, type Reserved, type SaveAttempt } from './saveAttempt'
import { unlinkSession } from './unlink'
import { refreshBinding } from './watch'

// Save, Save As… and Recent Sessions' Save…: write-back with
// `requestPermission` first, the changed-on-disk check, our own completed Save, the Save dialog,
// the save picker under `nse-bind`, downloads, and the follow-up dialogs. The
// dialogs are `saveUi`'s; the writer is the storage worker's (`buildSave`).

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A disk state that matches nothing: a binding without one meets the conflict dialog. */
const NO_DISK: DiskState = { fingerprint: 'none', size: -1, lastModified: 0 }

/** The label of the `save` entry and a file event: "Saved coconut.nxsp". */
const saveOperation = (name: string, download: boolean) =>
    createHistoryOperation({
        id: 'nse.file.save',
        data: { file: captureName(name), delivery: download ? 'download' : 'file' },
    })

// The Preparing dialog is the attempt's (`saveAttempt.ts`): opened when a build is slow, or a Save
// waits for an import.

/** How a Save opens its "Preparing…": the Save UI's, which tests replace. */
const preparingUi = {
    preparing: (name: string, kind?: 'save' | 'export') => saveUi.preparing(name, kind),
}

/** How often a dialog counts again while an import is pending that runs nowhere here. */
const ESTIMATE_POLL_MS = 1000

/** Resolves once `signal` aborts; at once without one. */
const untilAborted = (signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (!signal || signal.aborted) resolve()
        else
            signal.addEventListener(
                'abort',
                () => {
                    resolve()
                },
                { once: true },
            )
    })

/**
 * A dialog's size estimate, never one counted during an open's import: such a count
 * is low, since the import's batches add rows. While `sessionId`'s import runs here, it waits for
 * it to end and counts again. While one is pending that runs nowhere here (a reload's resume not
 * started yet, or another session's import that never ends), it counts again a few times, for
 * `RESUME_WAIT_MS` in all; then the size stays "Estimating size…" until the dialog closes, with no
 * more counts. Undefined when a count failed or `signal` aborted.
 */
const countedWhole = async (
    sessionId: string,
    count: () => Promise<SaveSizeEstimate | undefined>,
    signal?: AbortSignal,
): Promise<SaveSizeEstimate | undefined> => {
    for (let waited = 0; ;) {
        const loaded = await count()
        if (!loaded || signal?.aborted) return
        if (!loaded.importing) return loaded
        if (isImporting(sessionId)) {
            try {
                await whenImported(sessionId, signal)
            } catch {
                return
            }
            continue
        }
        if (waited >= RESUME_WAIT_MS) {
            await untilAborted(signal)
            return
        }
        if (!(await pause(ESTIMATE_POLL_MS, signal))) return
        waited += ESTIMATE_POLL_MS
    }
}

// The binding a write commits.

const bindingFile = async (
    built: BuiltSave,
    reservation: SaveReservation,
    request: {
        name: string
        event: 'saved' | 'downloaded'
        handle?: FileSystemFileHandle
        disk?: DiskState
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
    }
}

/**
 * The record's binding as this Save found it: a unit committed later is dropped when a
 * takeover changed it meanwhile. A binding kept in memory carries the one it started from.
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
        ...(built.identity.clearExport ? { clearExport: true } : {}),
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
        operation: operationOfEntry(built.saveEntry),
        snapshot: built.saveEntry.snapshot,
        noteCount: built.saveEntry.noteCount,
        revisionId: built.revisionId,
        device: built.saveEntry.device,
        ...(built.saveEntry.appVersion === undefined
            ? {}
            : { appVersion: built.saveEntry.appVersion }),
    },
    parent,
    unit: {
        ...(built.identity.clearExport ? { clearExport: true } : {}),
        docId: built.identity.docId,
        revision: built.identity.revision,
        file: markerFile(file),
        marks: built.identity.marks,
    },
})

/**
 * Commits a write that binds: its `save` entry at the reserved `seq` and the identity
 * unit with it, through the flush (kept in memory while storage is paused), and the tab's label.
 */
const bindWrite = async (
    env: Env,
    ending: Pick<SaveAttempt, 'complete'>,
    reservation: SaveReservation,
    built: BuiltSave,
    state: State,
    file: Row,
) => {
    const name = String(file.name)
    await ending.complete(
        {
            wall: reservation.wall,
            operation: operationOfEntry(built.saveEntry),
            state,
            revisionId: built.revisionId,
            device: built.saveEntry.device,
            ...(built.saveEntry.appVersion === undefined
                ? {}
                : { appVersion: built.saveEntry.appVersion }),
        },
        unitOf(env, built, file),
    )
    if (currentSession.value.sessionId === reservation.session.id) {
        if (built.identity.clearExport) clearExportDestination()
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

const savedOf = (built: BuiltSave, kind: 'saved' | 'download', name: string) => ({
    kind,
    name,
    size: built.blob.size,
    stepsLine: built.stepsLine,
    tooLarge: built.tooLarge,
})

const feedback = (built: BuiltSave, kind: 'saved' | 'download', name: string) => {
    saveUi.saved(savedOf(built, kind, name))
}

/**
 * The line for a Save refused while an import is pending: that storing is paused full, which keeps
 * the import from storing and which the user can end, else that the file is not read completely.
 */
const importingText = (source: string) => {
    const status = storageStatus.value
    return status?.mode === 'stored' && status.reason === 'full'
        ? () => i18n.value.save.notKeptFull
        : interpolate(() => i18n.value.save.notKept, source)
}

/**
 * A refusal's message: a reader cap, a newer version, damage, an open's import not
 * finished (`source`: the file it reads), or a bug.
 */
const refusalText = (refusal: BuildRefused, name: string, source = name) => {
    const { refused } = refusal.refusal
    // The import the Save waited for didn't start or end: the file is not read whole yet.
    if (refused === 'importing') return importingText(source)
    if (refused === 'needsNewer')
        return () => interpolateRaw(i18n.value.conflict.replaceNewer, PRODUCT_NAME)
    if (refused === 'unreadableHead') return interpolate(() => i18n.value.save.unreadable, name)
    if (refused === 'plan' && 'limit' in refusal.refusal && refusal.refusal.limit)
        return () => i18n.value.save.tooLarge
    // A bug, logged by the writer: the file could not be prepared.
    return interpolate(() => i18n.value.save.buildFailed, name)
}

// Suggestions that never name a known file.

const knownNames = async (env: Env) => {
    const read = await storedRead(env.worker, 'listHandleOwners', undefined)
    // A failed list suggests as if no file were known, as today: the name is only a suggestion,
    // and the picker or the write still checks the file.
    if (read.storedRead === 'failed') return new Set<string>()
    return new Set(read.storedValue.map((owner) => owner.name.normalize('NFC').toLocaleLowerCase()))
}

/**
 * A suggestion made valid and, where a save picker suggests it and a stored binding or target has
 * its name, numbered upward: "coconut (2)", then "coconut (3)". A download takes nothing over, and
 * the browser renames a clash, so a suggestion is for pickers only.
 */
const suggestion = async (env: Env, stem: string) => {
    const base = validName(stem)
    if (!platform.pickSaveFile) return base
    const known = await knownNames(env)
    const taken = (name: string) => known.has(`${name}.nxsp`.normalize('NFC').toLocaleLowerCase())
    let name = base
    while (taken(name)) name = nextCopyName(name)
    return name
}

/** The displayed name as a file name, or empty for the date fallback. */
const shownStem = (env: Env, state: State) =>
    prefillOf(displayName(namePartsOf(env.session.chain, state)))

/**
 * A copy's prefill: a bound file's stem numbered upward, "coconut (2)" after "coconut"; another name
 * ending in a copy number is a copy's own, "Coconut (2)" for a fork.
 */
const copyStem = (stem: string, ofFile: boolean) =>
    !stem || (!ofFile && hasCopyNumber(stem)) ? stem : nextCopyName(stem)

/** A file time for a name: "Oct 16, 2.41 PM" (no colon in a file name). */
const nameTime = (time: number) => formatDateTime(settings.locale, time).replaceAll(':', '.')

/** A disk state of an empty file: what a save picker leaves. */
const EMPTY_DISK: DiskState = { fingerprint: 'damaged:0:0', size: 0, lastModified: 0 }

/** The hash no state has: a pre-bound chain counts as changed. */
const NO_HASH = new Uint8Array(16)

type Revoked = { ok: boolean; revoked: boolean; preBound: boolean }

/** Takes a file over from another chain; a takeover storage can't record is refused. */
export const revoke = async (
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
        // Storage paused, full or in safe mode: another chain's binding can't be revoked, so its
        // file is refused; a file no chain is bound to goes on.
        return { ok: !owner, revoked: false, preBound: false }
    }
}

/** A takeover storage could not record: nothing is written. */
export const notTakenOver = (name: string): Outcome =>
    isSafeMode()
        ? { kind: 'refused', name, reason: 'safeMode' }
        : { kind: 'failed', error: new FileError('io', `${name} was not taken over`), name }

/**
 * The open session follows a pre-bind: its record, its `docId`, and a label bound to the
 * emptied file, which counts as changed until the write is recorded.
 */
const followPreBind = async (env: Env, reservation: SaveReservation, name: string) => {
    const read = await storedRead(env.worker, 'readChainRecord', env.chainId)
    // A failed read keeps today's outcome: the session follows the next read of its record.
    const record = read.storedRead === 'value' ? read.storedValue : undefined
    if (!record) return
    env.session.chain = record
    if (typeof record.docId === 'string') env.session.docId = record.docId
    if (currentSession.value.sessionId !== reservation.session.id) return
    const { copyOf: _copy, ...rest } = currentSession.value
    currentSession.value = { ...rest, docId: env.session.docId }
    bindFile({ name, event: 'saved', at: reservation.wall, hash: toHex(NO_HASH) })
}

/**
 * What every Save writes unless its Save dialog's ticks say otherwise: History, and the
 * head's BGM, its audio when held, else as metadata. Ticks apply to one write and are never kept.
 */
export const DEFAULT_OPTIONS = { history: true, bgm: true } as const

/** What a Save that picks wants written. */
type PickRequest = {
    dialog: SaveDialogKind | 'separate' | 'notFound'
    fileName: string
    history: boolean
    bgm: boolean
    /** `new` mints a `docId` (Save As…); `copy` keeps the chain's identity. */
    target: 'new' | 'copy'
    startIn?: FileSystemHandle
    /** The dialog's read of the chain's own file; else the session starts one. */
    read?: Promise<ReadResult>
    /** The size the Save dialog estimated for the options answered, in bytes. */
    estimated?: number
}

export type Outcome =
    | { kind: 'done' }
    | { kind: 'cancelled' }
    /** The attempt's commit forked the session: the Save dialog for the one now open. */
    | { kind: 'forked' }
    /** The chain's own file was damaged and the chain unlinked from it: Save As… follows. */
    | { kind: 'unlinked'; name: string }
    /** What the file held that was not put back was offered by the pick session. */
    | { kind: 'refused'; name: string; reason: RefusedReason }
    | { kind: 'conflict'; handle: FileSystemFileHandle; binding: Binding }
    | { kind: 'failed'; error: FileError; name: string }
    | { kind: 'error'; message: () => string }

/** A download whose build would likely outlast the tap: over 2 MB estimated, on a touch device. */
const largeDownload = (estimated: number | undefined): estimated is number =>
    !platform.pickSaveFile &&
    estimated !== undefined &&
    estimated > LARGE_BUILD_BYTES &&
    isTouchDevice()

/** What the pick session shows and does for the Save family (it loads in Node: no UI import). */
export const pickUi = {
    ...preparingUi,
    notPutBack: (name: string, emptied: boolean, downloadable: boolean, replaced: boolean) =>
        saveUi.notPutBack(name, emptied, downloadable, replaced),
    download: (name: string, bytes: Blob) => downloadBytes(name, bytes),
}

/** A browser without a save picker reads no file first. */
const NO_READ: Promise<ReadResult> = Promise.resolve({ kind: 'noAccess' })

/**
 * Saves through the picker, or downloads where there's none: one pick session for every picker
 * of the Save family. The file is built and verified first, then picked, identified
 * under `nse-bind` exclusive, written over the emptied file (its empty state the precondition)
 * and bound.
 */
const pickAndWrite = async (env: Env, request: PickRequest): Promise<Outcome> => {
    const ended = await withPickSession(
        {
            env,
            name: request.fileName,
            surface: 'save',
            purpose: 'save',
            commitFirst: true,
            read: platform.pickSaveFile ? (request.read ?? 'start') : NO_READ,
            // A large download on a touch device would outlast the tap: "Preparing…" opens at
            // once, with the estimated size.
            ...(largeDownload(request.estimated) ? { estimated: request.estimated } : {}),
            ui: pickUi,
        },
        (session) => saveBody(session, env, request),
    )
    return ended.kind === 'dismissed' ? { kind: 'cancelled' } : ended
}

const saveBody = async (
    session: PickSession,
    env: Env,
    request: PickRequest,
): Promise<Outcome | Dismissed> => {
    const reserved = await session.reserve()
    if (!reserved) return { kind: 'cancelled' }
    const { reservation, state } = reserved
    const binding = quickBinding(env)
    const docId = request.target === 'new' ? crypto.randomUUID() : binding.docId
    let built: BuiltSave
    try {
        built = await session.preparing(() =>
            runBuild(env, {
                target: request.target === 'new' ? { kind: 'new', docId } : { kind: 'copy' },
                history: request.history,
                bgm: request.bgm,
                fileName: request.fileName,
                save: {
                    time: reservation.wall,
                    operation: saveOperation(request.fileName, !platform.pickSaveFile),
                },
                state,
            }),
        )
    } catch (error) {
        if (error instanceof BuildRefused)
            return {
                kind: 'error',
                message: refusalText(error, request.fileName, binding.file?.name),
            }
        return { kind: 'failed', error: fileError(error), name: request.fileName }
    }
    session.checkpoint()
    if (!platform.pickSaveFile) return downloadBuilt(session, env, reserved, built, request)

    // The build found damage in storage that the carry test couldn't see: the chain's own
    // file is still whole until a picker empties it, so it's read now, and a pick of it appends.
    if (binding.file && (built.damaged.length > 0 || built.marked > 0)) await session.readAgain()

    const picked = await session.pick(
        projectPicker(request.startIn),
        request.fileName,
        (file) => projectPicked(session, env, reserved, built, request, binding, file),
        built.blob.size,
    )
    return withoutOffered(session, picked)
}

/**
 * An offer takes a refusal dialog's place, and the failure's when the file was emptied and its
 * bytes could not go back: the offer says what matters. Else the outcome follows it.
 */
const withoutOffered = <T extends Outcome | Dismissed>(session: PickSession, picked: T) => {
    const offer = session.offered
    if (offer && (picked.kind === 'refused' || (offer.emptied && picked.kind !== 'done')))
        return { kind: 'cancelled' } as const
    return picked
}

/** Downloads a built file (download browsers, a binding by name), binding it by name. */
const downloadBuilt = async (
    session: PickSession,
    env: Env,
    { reservation, state }: Reserved,
    built: BuiltSave,
    request: PickRequest,
): Promise<Outcome> => {
    let result: SaveResult
    try {
        result = await session.download({ suggestedName: request.fileName, blob: built.blob })
    } catch (error) {
        if (error instanceof Cancelled) throw error
        return { kind: 'failed', error: fileError(error), name: request.fileName }
    }
    if (result.status !== 'download-started') return { kind: 'cancelled' }
    const file = await bindingFile(built, reservation, {
        name: request.fileName,
        event: 'downloaded',
    })
    await bindWrite(env, session, reservation, built, state, file)
    forgetHandle(env.chainId)
    feedback(built, 'download', request.fileName)
    return { kind: 'done' }
}

const notBuilt = (name: string) => new FileError('io', `${name} was not built`)

/**
 * The Save family's pick, inside the session's hold on `nse-bind`: the write and the
 * binding. What the editor holds of a file that was not written is put back or offered by the
 * session once this returns.
 */
export const projectPicked = async (
    session: PickSession,
    env: Env,
    { reservation, state }: Reserved,
    /** Built before the picker; Export's pick of the chain's own file builds after it. */
    prebuilt: BuiltSave | undefined,
    request: PickRequest,
    binding: Binding,
    picked: PickedFile,
): Promise<Outcome> => {
    const { target, found, filled, identity, pre } = picked
    const { handle } = target
    const name = handle.name
    let built: BuiltSave | undefined = prebuilt
    let bound = binding
    switch (identity.kind) {
        case 'refused':
        case 'target':
            // Refused: the bytes held of it go back, or are offered, in the session.
            return {
                kind: 'refused',
                name,
                reason: identity.kind === 'refused' ? identity.reason : 'levelData',
            }
        case 'own': {
            // This chain's own file keeps the identity, appending to the bytes read first.
            if (filled) return { kind: 'conflict', handle, binding }
            // Not at the base: the version read goes back (the session, offered as a download when
            // it can't), and the conflict dialog shows it.
            if (pre && !pre.atBase) return { kind: 'conflict', handle, binding }
            // The dialog's ticks apply to this write, but history the file holds stays.
            const history = bindingHasHistory(binding.file) || request.history
            const rebuild = () =>
                runBuild(
                    env,
                    {
                        target: pre ? { kind: 'append', source: 'pre' } : { kind: 'copy' },
                        history,
                        bgm: request.bgm,
                        fileName: name,
                        save: { time: reservation.wall, operation: saveOperation(name, false) },
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
            try {
                built = await rebuild().catch(async (error: unknown) => {
                    // A refusal is the same on a second try; a worker that failed may not be.
                    if (error instanceof BuildRefused) throw error
                    recordError(error)
                    return rebuild()
                })
            } catch (error) {
                // Nothing read first: the emptied file gets what this rebuild would have written,
                // the chain's own identity, History and BGM. The build before the picker is that
                // only when it was made so: a Save (`copy`) with the same History. Else the file
                // stays empty, which the next Save fills from storage, and the bytes read, if any,
                // go back (the session).
                if (!pre && prebuilt && request.target === 'copy' && request.history === history) {
                    recordError(error)
                    break
                }
                if (error instanceof BuildRefused)
                    return { kind: 'error', message: refusalText(error, name) }
                return { kind: 'failed', error: fileError(error), name }
            }
            break
        }
        case 'other':
        case 'unknown': {
            // Only a Save that built before its picker meets these.
            if (!built) return { kind: 'failed', error: notBuilt(name), name }
            // Filled while this pick waited: taken over only when it's its owner's own last Save.
            const owners =
                identity.kind === 'other' ? await ownerDisk(env, identity.owner) : undefined
            const ownersOwn = filled && !!owners && sameContent(found, owners)
            if (filled && identity.kind === 'other' && !ownersOwn) return changedWhilePicked(name)
            // A picker that renamed the file: its own name goes into the build (`save` entry and
            // `revision.fileName`). Rebuilt only now, once the file is known to be written, so a
            // refused pick is put back as soon as it is known, and before anything is revoked. A
            // rebuild that fails leaves the first build, which differs only in that name.
            if (name !== request.fileName && !(filled && !ownersOwn)) {
                try {
                    built = await runBuild(env, {
                        target:
                            request.target === 'new'
                                ? { kind: 'new', docId: built.identity.docId }
                                : { kind: 'copy' },
                        history: request.history,
                        bgm: request.bgm,
                        fileName: name,
                        save: { time: reservation.wall, operation: saveOperation(name, false) },
                        state,
                    })
                } catch (error) {
                    // The first build is the same file under the typed name, and the picked file
                    // is empty: it is written, never left empty by a Save that ends here.
                    recordError(error)
                }
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
                },
                // Save As…'s new identity goes with its file (one unit).
                ...(request.target === 'new' ? { docId: built.identity.docId } : {}),
            }
            const done = await revoke(
                env,
                identity.kind === 'other' ? identity.owner : undefined,
                preBind,
            )
            if (!done.ok) return notTakenOver(name)
            const tookOver = done.revoked
            if (done.preBound) {
                await followPreBind(env, reservation, name)
                const reread = await readBinding(env)
                // A failed read keeps the binding the Save started from, as today.
                bound = reread.storedRead === 'value' ? reread.storedValue : binding
            }
            if (tookOver) broadcastUpdated()
            await savePoint('revoked')
            // A sync client's write after the pick: pre-bound, never written over.
            if (filled && !ownersOwn)
                return done.preBound
                    ? { kind: 'conflict', handle, binding: bound }
                    : changedWhilePicked(name)
            break
        }
    }

    if (!built) return { kind: 'failed', error: notBuilt(name), name }
    const file = await bindingFile(built, reservation, {
        name,
        event: 'saved',
        handle,
    })
    const written = built
    const parent = written.identity.revision.ancestors.length ? (bound.revision?.id ?? null) : null
    let result: SaveResult
    try {
        result = await picked.write({
            kind: 'nxsp',
            blob: written.blob,
            marker: () => markerOf(env, written, reservation, parent, file),
        })
    } catch (error) {
        const failure = fileError(error)
        if (failure.code === 'conflict') return { kind: 'conflict', handle, binding: bound }
        return { kind: 'failed', error: failure, name }
    }
    if (result.status !== 'saved') return { kind: 'cancelled' }
    await savePoint('closed')
    rememberHandle(env.chainId, handle)
    await bindWrite(env, session, reservation, written, state, {
        ...file,
        ...(result.disk ? { disk: result.disk } : {}),
    })
    feedback(written, 'saved', name)
    return { kind: 'done' }
}

/** The disk state another chain's binding records, for a file filled while a pick waited. */
const ownerDisk = async (env: Env, owner: HandleOwner) => {
    const read = await storedRead(env.worker, 'readChainRecord', owner.chainId)
    // A failed read keeps today's outcome: no disk state is known for the other chain's file.
    const record = read.storedRead === 'value' ? read.storedValue : undefined
    const file = isRow(record?.file) ? record.file : undefined
    return file && file.at === owner.at && isRow(file.disk) ? (file.disk as DiskState) : undefined
}

/** A picked file holding what nobody here wrote: nothing is written over it. */
const changedWhilePicked = (name: string): Outcome => ({
    kind: 'failed',
    error: new FileError('conflict', `${name} changed on disk`),
    name,
})

// The write-back.

/** What recognising our own completed Save found: recorded, a build-style `importing`, or not ours. */
type Recognised = 'recorded' | 'importing' | 'no'

/**
 * Our own completed Save: a file this chain wrote whose binding
 * wasn't recorded. After the file's checks against the marker kept before the write, its binding is
 * recorded alone (`recordOwnSave`): no entry is written, so the Save has no Saved row in the
 * Timeline. A chain that still imports is refused as the build refuses it, the marker kept.
 */
const ownCompletedSave = async (
    env: Env,
    binding: Binding,
    handle: FileSystemFileHandle,
    file: Blob,
    disk: DiskState,
): Promise<Recognised> => {
    const marker = readMarker(env.chainId)
    if (!marker) return 'no'
    const facts = await readDiskFacts(file).catch(() => undefined)
    const project = isRow(facts?.projectJson) ? facts.projectJson : undefined
    const revision = isRow(project?.revision) ? project.revision : undefined
    const device = isRow(revision?.device) ? revision.device : undefined
    const lineageId = project?.lineageId
    const last = facts?.last
    // The file holds this write: its revision, this browser, and its `save` entry last.
    if (
        revision?.id !== marker.entry.revisionId ||
        typeof lineageId !== 'string' ||
        device?.id !== ownDeviceId(lineageId) ||
        (revision.parent ?? null) !== marker.parent ||
        (marker.parent !== null && marker.parent !== binding.revision?.id) ||
        last?.kind !== 'save' ||
        last.revisionId !== marker.entry.revisionId
    )
        return 'no'
    const unit = markerUnit(marker)
    if (unit.file.name !== handle.name) return 'no'
    // The record as it is now, under `nse-bind`: the binding the Save started from is the one
    // the transaction checks it still holds.
    const read = await storedRead(env.worker, 'readChainRecord', env.chainId)
    // A failed read keeps today's outcome: the Save is not recognised, and its marker stays.
    const record = read.storedRead === 'value' ? read.storedValue : undefined
    if (!record) return 'no'
    const at = (field: unknown) =>
        isRow(field) && typeof field.at === 'number' ? field.at : undefined
    const fileAt = at(record.file)
    const replacedAt = at(record.replaced)
    // The handle the check used stays the binding's, so later Saves write back in place.
    const stored = await storableHandle(handle)
    const { session } = env
    const recorded = await env.worker
        .call('recordOwnSave', {
            chainId: env.chainId,
            writer: {
                sessionId: session.id,
                ...(session.continuation && session.parent ? { parentId: session.parent.id } : {}),
            },
            unit: {
                ...unit,
                file: { ...unit.file, ...(stored ? { handle: stored } : {}), disk, event: 'saved' },
                from: {
                    ...(fileAt === undefined ? {} : { fileAt }),
                    ...(replacedAt === undefined ? {} : { replacedAt }),
                },
            },
        })
        .catch(() => undefined)
    if (recorded === 'importing') return 'importing'
    if (recorded !== 'recorded') return 'no'
    if (unit.clearExport && currentSession.value.sessionId === env.session.id)
        clearExportDestination()
    removeMarker(env.chainId, marker.entry.revisionId)
    rememberHandle(env.chainId, handle)
    const after = await storedRead(env.worker, 'readChainRecord', env.chainId)
    // A failed read keeps today's outcome: the session keeps the record it had.
    if (after.storedRead === 'value' && after.storedValue) env.session.chain = after.storedValue
    if (currentSession.value.sessionId === env.session.id)
        bindFile({
            name: handle.name,
            event: 'saved',
            ...(typeof unit.file.at === 'number' ? { at: unit.file.at } : {}),
            hash: marker.unit.file.hash,
        })
    return 'recorded'
}

type CheckOutcome = Outcome | { kind: 'noChanges'; event: StoredFile['event'] }

/** The binding could not be read again: the Save writes nothing. */
const STORAGE_UNAVAILABLE: Outcome = {
    kind: 'error',
    message: () => i18n.value.save.storageUnavailable,
}

type Checked =
    | { kind: 'write'; binding: Binding; file: StoredFile; expected: DiskState }
    | { kind: 'outcome'; outcome: CheckOutcome }
    | { kind: 'revoked'; binding: Binding }

/**
 * Under `nse-bind` shared: the binding read again, and when nothing changed since its file
 * event, the check alone.
 */
const check = async (env: Env, handle: FileSystemFileHandle): Promise<Checked> => {
    const read = await readBinding(env)
    // A record that could not be read is no answer: nothing is written, and the Save says so.
    if (read.storedRead === 'failed') return { kind: 'outcome', outcome: STORAGE_UNAVAILABLE }
    const binding = read.storedValue
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
    // An empty file holds nothing to keep.
    if (disk.size === 0) return { kind: 'write', binding, file, expected: disk }
    return { kind: 'outcome', outcome: { kind: 'conflict', handle, binding } }
}

/**
 * The write-back, under `nse-bind` shared: the check pins the file; the writer appends to it; a
 * change before `close()` aborts; the read-back confirms; the binding follows.
 */
const writeBackLocked = async (
    attempt: SaveAttempt,
    env: Env,
    handle: FileSystemFileHandle,
): Promise<CheckOutcome | 'revoked'> => {
    for (let round = 0; round < 2; round++) {
        const checked = await check(env, handle)
        if (checked.kind === 'revoked') return 'revoked'
        if (checked.kind === 'outcome') {
            if (checked.outcome.kind !== 'conflict') return checked.outcome
            if (round === 0) {
                const recognised = await recognise(env, checked.outcome.binding, handle)
                if (recognised === 'importing') return importingOutcome(handle)
                if (recognised === 'recorded') continue
            }
            return checked.outcome
        }
        const outcome = await writeBack(
            attempt,
            env,
            handle,
            checked.binding,
            checked.file,
            checked.expected,
        )
        if (outcome.kind !== 'conflict' || round > 0) return outcome
        const recognised = await recognise(env, outcome.binding, handle)
        if (recognised === 'importing') return importingOutcome(handle)
        if (recognised !== 'recorded') return outcome
    }
    return { kind: 'cancelled' }
}

/** Our own completed Save, checked on the file as it is now. */
const recognise = async (
    env: Env,
    binding: Binding,
    handle: FileSystemFileHandle,
): Promise<Recognised> => {
    try {
        const file = await handle.getFile()
        const disk = await platform.inspect({ kind: 'handle', handle }, 'nxsp')
        if (disk === 'missing') return 'no'
        return await ownCompletedSave(env, binding, handle, file, disk)
    } catch {
        return 'no'
    }
}

/** An import of the chain still running after the Save's wait: refused as the build refuses it. */
const importingOutcome = (handle: FileSystemFileHandle): Outcome => ({
    kind: 'error',
    message: importingText(handle.name),
})

const writeBack = async (
    attempt: SaveAttempt,
    env: Env,
    handle: FileSystemFileHandle,
    binding: Binding,
    file: StoredFile,
    expected: DiskState,
    /** Replace: the revision of the version on disk, kept first. */
    replaces?: string,
): Promise<Outcome> => {
    // Inside the hold of `nse-bind`: a reservation another flow holds is not waited for.
    const reserved = await attempt.reserve(false)
    if (!reserved) return { kind: 'cancelled' }
    const { reservation, state } = reserved
    let built: BuiltSave | undefined
    let bound: Row = {}
    let result: SaveResult
    try {
        result = await attempt.write(
            {
                kind: 'nxsp',
                suggestedName: file.name,
                target: { kind: 'handle', handle },
                expected,
                // A target found empty holds nothing to keep: written, never a conflict.
                overEmpty: true,
                build: async (sources) => {
                    const source = replaces
                        ? undefined
                        : sources.find((each) => each.token === 'target')
                    const made = await runBuild(
                        env,
                        {
                            target: replaces
                                ? { kind: 'replace', replaces }
                                : source && binding.revision
                                  ? { kind: 'append', source: 'target' }
                                  : { kind: 'copy' },
                            ...DEFAULT_OPTIONS,
                            fileName: file.name,
                            save: {
                                time: reservation.wall,
                                operation: saveOperation(file.name, false),
                            },
                            state,
                        },
                        source ? [source] : [],
                    )
                    built = made
                    bound = await bindingFile(made, reservation, {
                        name: file.name,
                        event: 'saved',
                        handle,
                    })
                    return { kind: 'blob', blob: made.blob }
                },
            },
            () => built && markerOf(env, built, reservation, binding.revision?.id ?? null, bound),
        )
    } catch (error) {
        if (error instanceof Cancelled) throw error
        if (error instanceof BuildRefused) {
            if (error.refusal.refused === 'damagedSource') return unlinkAndSaveAs(env, file.name)
            return { kind: 'error', message: refusalText(error, file.name) }
        }
        const failure = fileError(error)
        if (failure.code === 'conflict') return { kind: 'conflict', handle, binding }
        return { kind: 'failed', error: failure, name: file.name }
    }
    if (result.status !== 'saved' || !built) return { kind: 'cancelled' }
    await savePoint('closed')
    const done = built
    await bindWrite(env, attempt, reservation, done, state, {
        ...bound,
        ...(result.disk ? { disk: result.disk } : {}),
    })
    rememberHandle(env.chainId, handle)
    feedback(done, 'saved', file.name)
    return { kind: 'done' }
}

/** An append that met damage in the chain's own file: the chain unlinks, and Save As… follows. */
const unlinkAndSaveAs = async (env: Env, name: string): Promise<Outcome> => {
    await unlinkSession(env, name)
    return { kind: 'unlinked', name }
}

// The follow-up dialogs.

/** The conflict dialog's facts, and the `File` and disk state Replace keeps and writes over. */
const conflictInput = async (env: Env, binding: Binding, handle: FileSystemFileHandle) => {
    let facts: DiskFacts = { version: { kind: 'unknown' } }
    let replaceDisabled: (() => string) | undefined
    let pinned: { file: File; disk: DiskState } | undefined
    let relation: string | undefined
    let guarded: { projectJson: unknown; fingerprint: string } | undefined
    try {
        const file = await handle.getFile()
        const disk = await platform.inspect({ kind: 'handle', handle }, 'nxsp')
        facts = await readDiskFacts(file)
        if (disk !== 'missing') pinned = { file, disk }
        if (disk !== 'missing' && facts.projectJson !== undefined)
            guarded = { projectJson: facts.projectJson, fingerprint: disk.fingerprint }
    } catch {
        // What is on disk cannot be read: the title and body say enough.
    }
    if (guarded) {
        const read = await storedRead(env.worker, 'replaceDecision', {
            chainId: env.chainId,
            ...guarded,
        })
        const decision = read.storedRead === 'value' ? read.storedValue : undefined
        relation = decision?.relation
        // Replace needs its guard (invariant 6): a failed read, or no decision, never leaves it
        // enabled. It gives the uncertain reason, unless a reason of the dialog's own applies.
        if (!decision)
            replaceDisabled =
                replaceUnavailable(facts, pinned?.disk) ??
                (() => i18n.value.conflict.replaceMayHoldEarlier)
        else if (decision.holdsBase === 'missing')
            replaceDisabled = () => i18n.value.conflict.replaceHoldsEarlier
        else if (decision.holdsBase === 'unproven')
            replaceDisabled = () => i18n.value.conflict.replaceMayHoldEarlier
    }
    // Another project by its `id`; ours gone back, by the relation; else what `project.json` says.
    const version: DiskVersion =
        otherProject(facts, binding.docId) ??
        (relation === 'older' && facts.version.kind === 'saved'
            ? { kind: 'notDescendant', savedAt: facts.version.savedAt }
            : facts.version)
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
 * Why Replace cannot keep the version on disk first: a file this build cannot import
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
    // The version on disk read first, in case Save as a Separate File's picker returns it.
    const read = platform.pickSaveFile ? readOwnFile(env, binding) : undefined
    const { input, pinned, newer } = await conflictInput(env, binding, handle)
    setDiskFinding(newer ? 'newer' : 'changed')
    const choice: ConflictChoice | undefined = await saveUi.conflict(input)
    switch (choice) {
        case 'separate':
            await separateFile(env, binding, handle, read)
            return
        case 'openOther':
            await openOther(handle, handle.name)
            return
        case 'replace':
            if (pinned) await replace(env, handle, pinned)
            return
        case undefined:
            return
    }
}

/**
 * Replace: the version on disk is kept first, as an ordinary session in
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
    await savePoint('kept')
    if (kept !== 'kept') {
        // The file changed while it was being kept: the dialog again, over what's there now.
        const now = await platform
            .inspect({ kind: 'handle', handle }, 'nxsp')
            .catch(() => undefined)
        const changed = now && (now === 'missing' || !sameContent(now, pinned.disk))
        const reread = changed ? await readBinding(env) : undefined
        // A failed read shows the bar's error below, as today.
        const binding = reread?.storedRead === 'value' ? reread.storedValue : undefined
        if (kept === 'failed' && now === 'missing') {
            await afterOutcome(env, {
                kind: 'failed',
                error: new FileError('not-found', 'Not found'),
                name: handle.name,
            })
            return
        }
        if (kept === 'failed' && binding) {
            await afterOutcome(env, { kind: 'conflict', handle, binding })
            return
        }
        saveUi.error(
            kept === 'newer'
                ? replaceNewerLine
                : kept === 'damaged'
                  ? () => i18n.value.open.damaged
                  : () => i18n.value.notSaving.bar,
        )
        return
    }
    // One attempt, as the write-back's: it commits a continuation's first row and waits for the
    // chain's imports before it writes over the file.
    const outcome = await withSaveAttempt(
        {
            env,
            name: handle.name,
            surface: 'save',
            ui: preparingUi,
            commitFirst: true,
            importWait: 'chain',
        },
        (attempt): Promise<Outcome> => {
            if (attempt.imported === 'unlinked')
                return Promise.resolve({ kind: 'unlinked', name: handle.name })
            return withBind('shared', async (): Promise<Outcome> => {
                const read = await readBinding(env)
                if (read.storedRead === 'failed') return STORAGE_UNAVAILABLE
                const binding = read.storedValue
                const file = binding.file
                if (!file || binding.replaced || file.name !== handle.name)
                    return { kind: 'cancelled' }
                return writeBack(attempt, env, handle, binding, file, pinned.disk, replaces)
            })
        },
    )
    await afterOutcome(env, outcome)
}

/** Save as a Separate File: keeps the `docId`, in the original's folder. */
const separateFile = async (
    env: Env,
    binding: Binding,
    handle: FileSystemFileHandle,
    /** The conflict dialog's read; a Choose Another… starts one before its picker. */
    read?: Promise<ReadResult>,
) => {
    const stem = stemOf(handle.name)
    const engine = deviceLabel().replace(/^Web \((.*)\)$/, '$1')
    const name = await suggestion(env, `${stem} (${engine}, ${nameTime(Date.now())})`)
    await afterOutcome(
        env,
        await pickAndWrite(env, {
            dialog: 'separate',
            fileName: `${name}.nxsp`,
            ...DEFAULT_OPTIONS,
            target: 'copy',
            startIn: handle,
            ...(read ? { read } : {}),
        }),
        () => separateFile(env, quickBinding(env), handle),
    )
}

/**
 * Shows what an outcome needs: a follow-up dialog, or nothing. `again` is a refusal's Choose
 * Another…: the same Save once more, with its own read of the chain's file first; without
 * it, the Save dialog.
 */
export const afterOutcome = async (
    env: Env,
    outcome: Outcome | { kind: 'noChanges' },
    again: () => Promise<void> = () => dialogSave(env, 'save'),
): Promise<void> => {
    switch (outcome.kind) {
        case 'done':
        case 'cancelled':
        case 'noChanges':
            return
        case 'forked': {
            // Nothing was written: the Save dialog for the session that is open now.
            const now = environment()
            if (now) await dialogSave(now, 'save')
            return
        }
        case 'unlinked':
            await dialogSave(
                env,
                'saveAs',
                [interpolate(() => i18n.value.open.damagedHistory, outcome.name)],
                true,
            )
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
            const choice = await saveUi.refused(outcome.name, outcome.reason)
            if (choice === 'chooseAnother') await again()
            else if (choice === 'export') {
                await openExport()
            }
            return
        }
        case 'failed': {
            const { error, name } = outcome
            recordError(error)
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

/** Export Level Data… (the Save dialog's Export line, its refusal), as its command runs. */
const openExport = async () => {
    const { commands } = await import('../commands')
    const { runCommand } = await import('../commands/runCommand')
    await runCommand(commands.exportLevel)
}

/** Downloads the bytes of an offer: the file the Save could not put back. */
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
                stepsLine: 'none' as const,
                tooLarge: [],
            })
    } catch {
        saveUi.error(interpolate(() => i18n.value.save.downloadFailed, name))
    }
}

/** The not-found dialog's Save As…: keeps the identity and Export target, writes a new file. */
const notFoundSaveAs = async (env: Env) => {
    const binding = quickBinding(env)
    const stem = binding.file
        ? copyStem(stemOf(binding.file.name), true)
        : copyStem(shownStem(env, savedState()), false)
    const name = await suggestion(env, stem)
    const input = await dialogInput(env, 'saveAs', name, [])
    const result = await saveUi.saveDialog(input)
    if (result?.action !== 'save') return
    await afterOutcome(
        env,
        await pickAndWrite(env, {
            dialog: 'notFound',
            fileName: result.fileName,
            ...answered(input, result),
            ...estimateOf(input, result),
            target: 'copy',
        }),
        () => notFoundSaveAs(env),
    )
}

/** How long the Save dialog waits to learn whether storage holds the head's BGM. */
const BGM_HELD_WAIT_MS = 1000

/**
 * Whether the head's BGM is held: its bytes are in this tab's memory or
 * in the media store. A read that fails counts as not held, the side that claims less.
 */
const bgmHeld = async (env: Env, state: State) => {
    const { meta, source } = state.bgm
    if (!meta) return false
    if (source) return true
    // One key read; a worker that doesn't answer soon counts as not held, so the dialog opens.
    let timer: ReturnType<typeof setTimeout> | undefined
    const held = await Promise.race([
        env.worker.call('mediaHeld', [meta.hash]).catch(() => undefined),
        new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
                resolve(undefined)
            }, BGM_HELD_WAIT_MS)
        }),
    ])
    clearTimeout(timer)
    return !!held?.includes(meta.hash)
}

/** The estimate with the BGM this tab holds counted when storage doesn't have it yet. */
const withHeldBgm = (estimate: SaveSizeEstimate, state: State): SaveSizeEstimate => {
    const source = state.bgm.source
    return estimate.bgm === undefined && source ? { ...estimate, bgm: source.byteLength } : estimate
}

/** The storage line's first sentence for the first Save in this browser, where it applies. */
const storageLineOf = async () => {
    if (firstSaveDone.value) return
    const storageLine = await storageNote()
    return storageLine ? { storageLine } : undefined
}

/**
 * The BGM row of a session that isn't open (Recent Sessions' Save…), from what storage holds of its head: a
 * stored BGM is held, a head media item storage lacks is "not loaded", and none is "No BGM". With
 * no estimate to tell, the row stays ticked, which never strips a BGM.
 */
const sessionBgmRow = (estimate: SaveSizeEstimate | undefined): BgmRow => {
    if (!estimate) return { kind: 'held', name: 'BGM', ticked: true }
    if (estimate.bgm !== undefined)
        return { kind: 'held', name: estimate.bgmName ?? 'BGM', ticked: true }
    return estimate.mediaMissing ? { kind: 'notLoaded' } : { kind: 'none' }
}

const dialogInput = async (
    env: Env,
    kind: SaveDialogKind,
    name: string,
    lines: (() => string)[],
): Promise<SaveDialogInput> => {
    const state = savedState()
    const binding = quickBinding(env)
    const meta = state.bgm.meta
    const held = await bgmHeld(env, state)
    // A first Save after an open by name writes that file again: its history stays.
    // Every other row opens ticked (the defaults): a tick applies to this write only.
    const kept =
        kind === 'save' && binding.file?.event === 'opened' && bindingHasHistory(binding.file)
    const hash = meta?.hash
    const key = () => estimateKey(env.session, hash)
    const cached = knownEstimate(env.chainId, key())
    const input: SaveDialogInput = {
        kind,
        name,
        lines,
        // Hashing needs a secure context: elsewhere a file holds no history.
        history: globalThis.isSecureContext
            ? {
                  kind: 'available',
                  ticked: true,
                  locked: kept,
                  ...(kept && binding.file ? { keptIn: binding.file.name } : {}),
              }
            : { kind: 'insecure' },
        bgm: meta
            ? held
                ? {
                      kind: 'held',
                      name: meta.filename || (state.bgm.filename ?? 'BGM'),
                      ticked: true,
                  }
                : { kind: 'notLoaded' }
            : { kind: 'none' },
        exportLine:
            exportMemory.target !== undefined ||
            exportMemory.sourceName !== undefined ||
            (launch.isExistingUser && !exportUsed.value),
        ...(await storageLineOf()),
        peeking: isPeeking.value,
        estimate: {
            ...(cached ? { cached: withHeldBgm(cached, state) } : {}),
            // The worker counts what storage holds: this tab's pending entries go first, so the
            // steps are the ones the file will carry (a flush never rejects).
            load: async (signal) => {
                let before = key()
                const counted = { fromCache: false }
                // Counted during an open's import, it shows no count ("Estimating size…") until
                // the import ends, then counts again (`countedWhole`).
                const loaded = await countedWhole(
                    env.session.id,
                    async () => {
                        before = key()
                        const again = knownEstimate(env.chainId, before)
                        counted.fromCache = !!again
                        if (again) return again
                        await env.flusher.flush()
                        return env.worker
                            .call('estimateSaveSize', {
                                chainId: env.chainId,
                                ...(hash ? { bgm: hash } : {}),
                            })
                            .catch(failedEstimate)
                    },
                    signal,
                )
                if (!loaded) return
                // Kept only when it counted every entry: a flush that left some pending
                // (storage paused) counted fewer than `nextSeq` says.
                if (!counted.fromCache && !env.flusher.hasPending)
                    rememberEstimate(env.chainId, before, loaded)
                const estimate = withHeldBgm(loaded, state)
                noteLoaded(input, estimate)
                return estimate
            },
        },
    }
    return input
}

/** A size estimate that failed shows no sizes and is logged in the diagnostics ring. */
const failedEstimate = (error: unknown) => {
    recordError(error)
    return undefined
}

/**
 * The options a dialog's answer sets for its one write: only a user's untick leaves the
 * BGM out, so a row that isn't shown or isn't loaded includes it; with no hashing, no history.
 */
const answered = (input: SaveDialogInput, result: { history: boolean; bgm: boolean }) => ({
    history: input.history.kind === 'available' && result.history,
    bgm: input.bgm.kind === 'held' ? result.bgm : true,
})

/** The size the dialog estimated for the options a Save will use, once an estimate loaded. */
const estimateOf = (input: SaveDialogInput, result: { history: boolean; bgm: boolean }) => {
    const estimated = estimatedTotal(input, answered(input, result))
    return estimated === undefined ? {} : { estimated }
}

/** The Save dialog, then the picker or a download. */
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
    const name = await suggestion(env, copy ? copyStem(stem, !!binding.file) : stem)
    const replaced = binding.replaced
    const replacedLine = replaced
        ? [interpolate(() => i18n.value.file.replacedElsewhere, replaced.name)]
        : []
    // This chain's own file read first, when it may hold what storage lacks: for every kind,
    // since any picker may return it.
    const read = binding.file && platform.pickSaveFile ? readOwnFile(env, binding) : undefined
    const input = await dialogInput(env, kind, name, [...lines, ...replacedLine])
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
            ...answered(input, result),
            ...estimateOf(input, result),
            // Save As… gives a new `docId`; a first Save, a fork's and a taken-over chain's keep it.
            target: kind === 'saveAs' && !unlinked ? 'new' : 'copy',
            ...(read ? { read } : {}),
        }),
        // Choose Another… is this Save again, Save As… staying Save As… (a new `docId`).
        () => dialogSave(env, kind, lines, unlinked),
    )
}

/** A Save bound by name (a download, or a file opened without a handle). */
const downloadAgain = async (env: Env, file: StoredFile) => {
    const outcome = await withSaveAttempt(
        {
            env,
            name: file.name,
            surface: 'save',
            ui: preparingUi,
            commitFirst: true,
            importWait: 'chain',
        },
        async (attempt): Promise<Outcome> => {
            if (attempt.imported === 'unlinked') return { kind: 'unlinked', name: file.name }
            // Another flow's reservation (Export's own pick) is waited for: nothing is held here.
            const reserved = await attempt.reserve()
            if (!reserved) return { kind: 'cancelled' }
            const { reservation, state } = reserved
            let built: BuiltSave
            try {
                built = await attempt.preparing(() =>
                    runBuild(env, {
                        target: { kind: 'copy' },
                        ...DEFAULT_OPTIONS,
                        fileName: file.name,
                        save: { time: reservation.wall, operation: saveOperation(file.name, true) },
                        state,
                    }),
                )
            } catch (error) {
                if (error instanceof BuildRefused)
                    return { kind: 'error', message: refusalText(error, file.name) }
                return { kind: 'failed', error: fileError(error), name: file.name }
            }
            attempt.checkpoint()
            let result: SaveResult
            try {
                result = await attempt.write({
                    kind: 'nxsp',
                    suggestedName: file.name,
                    build: () => Promise.resolve({ kind: 'blob', blob: built.blob }),
                })
            } catch (error) {
                if (error instanceof Cancelled) throw error
                return { kind: 'failed', error: fileError(error), name: file.name }
            }
            if (result.status !== 'download-started') return { kind: 'cancelled' }
            const record = await bindingFile(built, reservation, {
                name: file.name,
                event: 'downloaded',
            })
            await bindWrite(env, attempt, reservation, built, state, record)
            forgetHandle(env.chainId)
            feedback(built, 'download', file.name)
            return { kind: 'done' }
        },
    )
    await afterOutcome(env, outcome)
}

/** Tells one "Download Again" notice from another: a second press of one joins its queued press. */
let noticeToken = 0

/** Save: write-back, a download by name, or the Save dialog. */
export const save = () =>
    exclusive('save', async () => {
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
    const read = platform.pickSaveFile ? await bindingHandle(env, file) : readValue(undefined)
    if (read.storedRead === 'failed') {
        // Not saved, bound or forgotten: a handle that could not be read is not a missing one, so
        // the file stays bound as it is and the next press reads again.
        saveUi.error(() => i18n.value.save.storageUnavailable)
        return
    }
    const handle = read.storedValue
    if (!handle) {
        // By name: the first Save after an open shows the dialog; an unchanged download asks.
        if (file.event === 'opened') {
            await dialogSave(env, 'save')
            return
        }
        if (rootOf(savedState()) === toHex(file.hash)) {
            const token = ++noticeToken
            saveUi.noChanges(file.name, 'downloaded', () => {
                void exclusive(`downloadAgain:${token}`, async () => {
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
    // The gesture's first call.
    const permission = requestWrite(handle)
    permission.catch(() => undefined)
    // The commit of a continuation's first row, the permission and the wait for the chain's
    // imports are the attempt's; the check and the write follow under `nse-bind` shared.
    const outcome = await withSaveAttempt(
        {
            env,
            name: file.name,
            surface: 'save',
            ui: preparingUi,
            commitFirst: true,
            importWait: 'chain',
            permission,
        },
        (attempt): Promise<CheckOutcome | 'revoked'> =>
            attempt.imported === 'unlinked'
                ? Promise.resolve({ kind: 'unlinked', name: file.name })
                : withBind('shared', () => writeBackLocked(attempt, env, handle)),
    )
    if (outcome === 'revoked') {
        // Taken over: the label goes, and the dialog says why.
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

/** Save As…: always the dialog, a new `docId`. */
export const saveAs = () =>
    exclusive('saveAs', async () => {
        const env = environment()
        if (!env) {
            saveUi.error(() => i18n.value.save.unavailable)
            return
        }
        await dialogSave(env, 'saveAs')
    })

// Recent Sessions' Save… (⋯): Save As for a session that isn't open.

/**
 * Recent Sessions' Save…: the session's pending journal applied first under its lock, its head with its
 * history written as a new `.nxsp` with a new `docId`, binding nothing. Its picker follows the
 * rules above: a file a chain is bound to is taken from it. A session open in another
 * tab is written as storage holds it, and the feedback says so. Recent Sessions' ⋯ menu is its
 * entry point.
 */
export const saveToFile = (sessionId: string) =>
    exclusive(`saveToFile:${sessionId}`, async () => {
        const env = environment()
        if (!env) {
            saveUi.error(() => i18n.value.save.unavailable)
            return
        }
        await saveToFileNow(env, sessionId)
    })

const applyPending = async (sessionId: string) => {
    const { applyPendingJournal } = await import('../../local/startup/api')
    return applyPendingJournal(sessionId).catch(() => undefined)
}

const saveToFileNow = async (env: Env, sessionId: string) => {
    // Safe mode only reads: applying a journal is a write, so the session is saved as stored.
    const applied = isSafeMode() ? undefined : await applyPending(sessionId)
    let read
    try {
        read = await env.worker.call('readSession', sessionId)
    } catch (error) {
        // Storage could not be read: that is not a missing session (invariant 12). Not
        // `save.storageUnavailable`: its "use Save As…" would save the open session, not this one.
        recordError(error)
        saveUi.error(() => i18n.value.notice.storageUnavailable)
        return
    }
    if (read.kind !== 'open') {
        saveUi.error(() => i18n.value.save.unavailable)
        return
    }
    const chainId = read.session.chainId as string
    const stem = prefillOf(displayName(namePartsOf(read.chain)))
    const updatedAt =
        typeof read.session.updatedAt === 'number' ? read.session.updatedAt : Date.now()
    const name = await suggestion(
        env,
        stem ? interpolateRaw(i18n.value.save.restoredName, stem, formatDate(updatedAt)) : '',
    )
    // The session's own head, as storage holds it: its BGM row is what a build would write.
    const estimate = await env.worker
        .call('estimateSaveSize', { chainId, sessionId })
        .catch(failedEstimate)
    const input: SaveDialogInput = {
        kind: 'saveToFile',
        name,
        lines: [],
        history: globalThis.isSecureContext
            ? { kind: 'available', ticked: true, locked: false }
            : { kind: 'insecure' },
        bgm: sessionBgmRow(estimate),
        exportLine: false,
        ...(await storageLineOf()),
        peeking: false,
        estimate: {
            // One counted during an open's import is low: never shown.
            ...(estimate && !estimate.importing ? { cached: estimate } : {}),
            load: async (signal) => {
                const loaded = await countedWhole(
                    sessionId,
                    () =>
                        env.worker
                            .call('estimateSaveSize', { chainId, sessionId })
                            .catch(failedEstimate),
                    signal,
                )
                if (loaded) noteLoaded(input, loaded)
                return loaded
            },
        },
    }
    // The open chain's own file is read while the dialog is open; a pick of it takes it.
    const ownRead = platform.pickSaveFile
        ? readOwnFile(env, quickBinding(env), { prompt: false })
        : undefined
    const result = await saveUi.saveDialog(input)
    if (result?.action !== 'save') return
    const options = answered(input, result)
    const estimated = estimatedTotal(input, options)
    // Its session hold before the build, so Delete Sessions… skips it. Released
    // before what follows, so Choose Another… holds it again for its own write.
    const outcome = await withSessionHold(sessionId, () =>
        writeSessionFile(env, {
            chainId,
            sessionId,
            fileName: result.fileName,
            ...options,
            ...(estimated === undefined ? {} : { estimated }),
            committed: applied === 'held',
            ...(ownRead ? { read: ownRead } : {}),
        }),
    )
    // Choose Another… is Recent Sessions' Save… for this session again, never the open one's Save.
    await afterOutcome(env, outcome, () => saveToFileNow(env, sessionId))
}

/** Holds a session's lock shared while it's written, when no tab holds it exclusively. */
const withSessionHold = async <T>(sessionId: string, run: () => Promise<T>) => {
    const { holdShared } = await import('../../local/startup/open')
    const held = await holdShared(platform.locks, sessionId).catch(() => undefined)
    try {
        return await run()
    } finally {
        held?.release()
    }
}

/** What Recent Sessions' Save… writes: another session, as a new file. */
type SessionFileRequest = {
    chainId: string
    sessionId: string
    fileName: string
    history: boolean
    bgm: boolean
    estimated?: number
    committed: boolean
    /** The open chain's own file, read when the dialog opened; else the session starts one. */
    read?: Promise<ReadResult>
}

/**
 * Builds a session that isn't open as a new file and writes it, binding nothing: one pick session
 * with no reservation. Its read is of the open chain's own file, which a pick of
 * it takes from this chain.
 */
const writeSessionFile = async (env: Env, request: SessionFileRequest): Promise<Outcome> => {
    const ended = await withPickSession(
        {
            env,
            name: request.fileName,
            surface: 'save',
            purpose: 'saveToFile',
            commitFirst: false,
            // The written session's imports are waited for; the pick's own last check covers any
            // this tab runs.
            importChain: request.chainId,
            read: platform.pickSaveFile ? (request.read ?? 'start') : NO_READ,
            ...(largeDownload(request.estimated) ? { estimated: request.estimated } : {}),
            ui: pickUi,
        },
        (session) => sessionFileBody(session, env, request),
    )
    return ended.kind === 'dismissed' ? { kind: 'cancelled' } : ended
}

const sessionFileBody = async (
    session: PickSession,
    env: Env,
    request: SessionFileRequest,
): Promise<Outcome | Dismissed> => {
    const built = await session
        .preparing(() =>
            env.worker.call(
                'buildSave',
                {
                    chainId: request.chainId,
                    target: {
                        kind: 'new',
                        docId: crypto.randomUUID(),
                        sessionId: request.sessionId,
                    },
                    options: {
                        history: request.history,
                        bgm: request.bgm,
                        fileName: request.fileName,
                        save: {
                            time: Date.now(),
                            operation: saveOperation(request.fileName, !platform.pickSaveFile),
                        },
                        context: {
                            now: Date.now(),
                            device: deviceSource(),
                            appVersion: appVersion().appVersion,
                        },
                        sessionId: request.sessionId,
                    },
                },
                { timeoutMs: 10 * 60_000 },
            ),
        )
        .catch((error: unknown) => fileError(error))
    session.checkpoint()
    if (built instanceof FileError) return { kind: 'failed', error: built, name: request.fileName }
    if ('refused' in built)
        return {
            kind: 'error',
            message: refusalText(new BuildRefused(built), request.fileName),
        }
    if (!platform.pickSaveFile) {
        let result: SaveResult
        try {
            result = await session.download({ suggestedName: request.fileName, blob: built.blob })
        } catch (error) {
            if (error instanceof Cancelled) throw error
            return { kind: 'failed', error: fileError(error), name: request.fileName }
        }
        if (result.status !== 'download-started') return { kind: 'cancelled' }
        saveUi.saved({
            ...savedOf(built, 'download', request.fileName),
            committedState: request.committed,
        })
        markFirstSaveDone()
        return { kind: 'done' }
    }
    const picked = await session.pick(
        projectPicker(),
        request.fileName,
        (file) => sessionFilePicked(env, request, built, file),
        built.blob.size,
    )
    return withoutOffered(session, picked)
}

/** The pick, inside the session's hold, for a file that binds nothing. */
const sessionFilePicked = async (
    env: Env,
    request: SessionFileRequest,
    built: BuiltSave,
    picked: PickedFile,
): Promise<Outcome> => {
    const { target, filled, identity } = picked
    const name = target.handle.name
    // Refused: what the editor holds of it goes back, or is offered, in the session.
    if (identity.kind === 'refused' || identity.kind === 'target')
        return {
            kind: 'refused',
            name,
            reason: identity.kind === 'refused' ? identity.reason : 'levelData',
        }
    // Written since the pick (a sync client): never written over unseen.
    if (filled)
        return {
            kind: 'failed',
            error: new FileError('conflict', `${name} changed`),
            name,
        }
    let tookOver = false
    if (identity.kind !== 'unknown') {
        // It binds nothing: the chain bound to the file loses it.
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
        if (!done.ok) return notTakenOver(name)
        tookOver = done.revoked
        if (identity.kind === 'own' && done.revoked) {
            forgetHandle(env.chainId)
            void refreshOwn(env)
        }
    }
    try {
        await picked.write({ kind: 'nxsp', blob: built.blob })
    } catch (error) {
        return { kind: 'failed', error: fileError(error), name }
    }
    if (tookOver) broadcastUpdated()
    saveUi.saved({
        ...savedOf(built, 'saved', name),
        committedState: request.committed,
    })
    markFirstSaveDone()
    return { kind: 'done' }
}

/** The open chain lost its file to this tab's own Recent Sessions' Save…: its label follows. */
const refreshOwn = (env: Env) => refreshBinding(env.worker, env.flusher)

/** A destination never registered here still cannot write over another known owner. */
export const exportTargetAvailable = async (handle: FileSystemFileHandle) => {
    const env = environment()
    if (!env) return true
    return knownTargetAvailable(env.worker, env.chainId, handle)
}

// The file state's actions (`src/editor/file`): its chip dialogs and notices run these.

/** The not-found chip's Save As…: keeps the chain's identity. */
export const fileSaveAs = () =>
    exclusive('fileSaveAs', async () => {
        const env = environment()
        if (env) await notFoundSaveAs(env)
    })

/** Download Again: builds and downloads the bound file once more. */
export const fileDownloadAgain = () =>
    exclusive('fileDownloadAgain', async () => {
        const env = environment()
        const file = env && quickBinding(env).file
        if (env && file) await downloadAgain(env, file)
    })

/**
 * Open the Other Version: the file on disk as a new session in place of this one, which
 * keeps its changes. A file that can't be read says so.
 */
const openOther = (
    handle: FileSystemFileHandle | undefined,
    name: string,
    supplied?: SwitchRequest,
) =>
    withSwitchRequest(supplied, async (request) => {
        try {
            const opened = await handle?.getFile().catch(() => undefined)
            if (!request.isCurrent()) return
            if (!handle || !opened) {
                saveUi.error(interpolate(() => i18n.value.save.readFailed, name))
                return
            }
            const { openProject } = await import('../commands/open/project')
            if (request.isCurrent()) await openProject(opened, handle, request)
        } catch (error) {
            if (request.isCurrent()) throw error
        }
    })

/** Reads the bound file's stored handle ahead of a Save, once the session is edited (n5). */
export const prefetchHandle = async () => {
    const env = environment()
    const file = env && quickBinding(env).file
    if (!env || !file || !platform.pickSaveFile || heldHandle(env.chainId, file.name)) return
    const read = await bindingHandle(env, file)
    // A failed read remembers nothing: a hint only, and the Save reads again.
    const handle = read.storedRead === 'value' ? read.storedValue : undefined
    if (handle && quickBinding(env).file?.name === handle.name) rememberHandle(env.chainId, handle)
}

/** The chip's Open the Other Version: the bound file on disk. */
export const openOtherVersion = (supplied?: SwitchRequest) =>
    withSwitchRequest(supplied, async (request) => {
        try {
            const env = environment()
            const file = env && quickBinding(env).file
            if (!env || !file || !request.isCurrent()) return
            const read = await bindingHandle(env, file)
            if (!request.isCurrent()) return
            if (read.storedRead === 'failed') {
                // The handle could not be read, which is not the file being unreadable.
                saveUi.error(() => i18n.value.notice.storageUnavailable)
                return
            }
            await openOther(read.storedValue, file.name, request)
        } catch (error) {
            if (request.isCurrent()) throw error
        }
    })

/** I Have the File: `file.confirmed` stored on the chain record. */
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

// Broadcasts: a takeover tells other tabs to read their record again.

let channel: BroadcastChannel | undefined

export const broadcastUpdated = () => {
    try {
        channel ??= new BroadcastChannel('nse-local-data')
        channel.postMessage({ type: 'sessionUpdated' })
    } catch {
        // A hint only: the other tab's next write reads its binding again.
    }
}
