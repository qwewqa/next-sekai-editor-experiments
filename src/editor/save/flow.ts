import { recordError } from '../../diagnostics'
import { createHistoryOperation } from '../../history/createHistoryOperation'
import { captureName, entryOperation as operationOfEntry } from '../../history/operations'
import { session as currentSession } from '../../history/session'
import { isPeeking } from '../../history/stack'
import { i18n } from '../../i18n'
import { formatDateTime } from '../../i18n/dateTime'
import { formatDate } from '../../i18n/when'
import type { SaveReservation } from '../../local/flush'
import { handleOf, storableHandle } from '../../local/handles'
import { toHex } from '../../local/hash'
import {
    displayName,
    hasCopyNumber,
    namePartsOf,
    nextCopyName,
    prefillOf,
    stemOf,
} from '../../local/names'
import { NXSP_CAPS } from '../../local/nxsp/read'
import { scpSilenceSecondsFromState, scpSilentMp3Size } from '../../local/nxsp/scpMedia'
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
import { inlineName } from '../../utils/inlineName'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { fileError } from '../commands/exportLevel/errorText'
import { nameKey, validName } from '../commands/exportLevel/fileName'
import {
    clearExportDestination,
    clearExportTarget,
    exportMemory,
    sameEntry,
} from '../commands/exportLevel/memory'
import { knownTargetAvailable } from '../commands/exportLevel/ownership'
import { fileErrorText } from '../commands/exportLevel/ui'
import { bindFile } from '../file'
import { firstSaveDone, markFirstSaveDone } from '../file/flags'
import { setDiskFinding } from '../file/state'
import { loadForAction } from '../loadFailure'
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
    withPickSession,
    type Dismissed,
    type PickedFile,
    type PickSession,
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
import { builtIn, finishSave, savedSize, startSave, startWrite, tracked } from './report'
import {
    Cancelled,
    commitFirst,
    withSaveAttempt,
    type Reserved,
    type SaveAttempt,
} from './saveAttempt'
import { unlinkSession } from './unlink'
import { applyRevoked, refreshBinding } from './watch'

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

const savedOf = (built: BuiltSave, kind: 'saved' | 'download', name: string) => {
    // Every write that succeeds builds its feedback here, so the usage statistics take its size.
    savedSize(built.blob.size)
    return {
        kind,
        name,
        size: built.blob.size,
        stepsLine: built.stepsLine,
        tooLarge: built.tooLarge,
    }
}

const feedback = (built: BuiltSave, kind: 'saved' | 'download', name: string) => {
    saveUi.saved(savedOf(built, kind, name))
}

/**
 * The line for a Save refused while an import is pending. While storing is paused full, the import
 * cannot store until the user frees space, and the line says so. After any other storage failure
 * the file was read, so the line says only that it could not be prepared. Otherwise it says that
 * the file could not be read completely.
 */
const importingText = (source: string) => {
    const status = storageStatus.value
    if (status?.mode === 'stored' && status.reason === 'full')
        return () => i18n.value.save.notKeptFull
    if (status?.reason === 'failed')
        return interpolate(() => i18n.value.save.buildFailed, inlineName(source))
    return interpolate(() => i18n.value.save.notKept, inlineName(source))
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
    if (refused === 'unreadableHead')
        return interpolate(() => i18n.value.save.unreadable, inlineName(name))
    if (refused === 'plan' && 'limit' in refusal.refusal && refusal.refusal.limit)
        return () => i18n.value.save.tooLarge
    // A bug, logged by the writer: the file could not be prepared.
    return interpolate(() => i18n.value.save.buildFailed, inlineName(name))
}

// Suggestions that never name a known file.

const knownNames = async (env: Env) => {
    const read = await storedRead(env.worker, 'listHandleOwners', undefined)
    // A failed list suggests as if no file were known: the name is only a suggestion,
    // and the picker or the write still checks the file.
    if (read.storedRead === 'failed') return new Set<string>()
    return new Set(read.storedValue.map((owner) => nameKey(owner.name)))
}

/**
 * Suggestions made valid and, where a save picker suggests them and a stored binding or target has
 * the name, numbered upward: "coconut (2)", then "coconut (3)". A download takes nothing over, and
 * the browser renames a clash, so a suggestion is for pickers only. An empty one stays empty.
 */
const suggestions = async (env: Env, stems: string[]) => {
    const known = platform.pickSaveFile ? await knownNames(env) : new Set<string>()
    const taken = (name: string) => known.has(nameKey(`${name}.nxsp`))
    return stems.map((stem) => {
        let name = validName(stem)
        while (name && taken(name)) name = nextCopyName(name)
        return name
    })
}

const suggestion = async (env: Env, stem: string) => (await suggestions(env, [stem]))[0] ?? ''

/**
 * File Name's prefill and its placeholder. An empty field saves the placeholder, so it is a
 * suggestion too, numbered as a name is.
 */
const fieldNames = async (env: Env, stem: string) => {
    const [name = '', placeholder = ''] = await suggestions(env, [
        stem,
        i18n.value.save.placeholder,
    ])
    return { name, placeholder }
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

/** Revokes a matching stored association. Exports still use the failure result. */
export const revoke = async (env: Env, owner: HandleOwner | undefined) => {
    const at = Date.now()
    try {
        const done = await env.worker.call('takeOver', {
            ...(owner ? { owner } : {}),
            by: env.chainId,
            at,
        })
        return { ok: true as const, ...done, at }
    } catch {
        return { ok: false as const, revoked: false }
    }
}

/** An export takeover that storage could not record. Nothing is written. */
export const notTakenOver = (name: string): Outcome =>
    isSafeMode()
        ? { kind: 'refused', name, reason: 'safeMode' }
        : { kind: 'failed', error: new FileError('io', name + ' was not taken over'), name }

/** Revokes every matching association before a picked Save, as far as storage allows. */
const revokePicked = async (env: Env, handle: FileSystemFileHandle, revokeOwn: boolean) => {
    const matches = async (stored: FileSystemFileHandle | undefined) =>
        !!stored && ((await sameEntry(handle, stored)) || (await sameEntry(stored, handle)))
    const binding = quickBinding(env).file
    const ownHandle = binding && (await bindingHandle(env, binding))
    const pickedOwn = ownHandle?.storedRead === 'value' && (await matches(ownHandle.storedValue))
    if (pickedOwn) setDiskFinding('changed')
    const list = await storedRead(env.worker, 'listHandleOwners', undefined)
    // A failed lookup finds no association; the writer still checks the file.
    const owners = list.storedRead === 'value' ? list.storedValue : []
    let revoked = false
    let replaced: Binding['replaced']
    for (const owner of owners) {
        if (
            owner.role === 'kept' ||
            (!revokeOwn && owner.role === 'file' && owner.chainId === env.chainId)
        )
            continue
        const read = await handleOf(env.worker, owner.chainId, owner.role)
        if (read.storedRead !== 'value' || !(await matches(read.storedValue))) continue
        const done = await revoke(env, owner)
        revoked ||= done.revoked
        if (done.ok && done.revoked && owner.role === 'file' && owner.chainId === env.chainId)
            replaced = { by: env.chainId, at: done.at, name: owner.name }
    }
    if (await matches(exportMemory.target?.handle)) clearExportTarget()
    // Only a stored revocation changes the record's preconditions.
    if (revokeOwn && pickedOwn && replaced) {
        applyRevoked(env.session, env.session.chain ?? {}, replaced, replaced.name)
        forgetHandle(env.chainId)
    }
    if (revoked) broadcastUpdated()
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
    /** An export takeover that storage could not record. */
    | { kind: 'refused'; name: string; reason: 'safeMode' }
    | { kind: 'conflict'; handle: FileSystemFileHandle; binding: Binding }
    | {
          kind: 'failed'
          error: FileError
          name: string
          reported?: true
          retry?: () => Promise<Outcome>
      }
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
    notPutBack: (name: string, emptied: boolean, downloadable: boolean, own: boolean) =>
        saveUi.notPutBack(name, emptied, downloadable, own),
    download: (name: string, bytes: Blob) => downloadBytes(name, bytes),
}

/** Keeps a picked failure's outcome after the empty-file warning has reported it. */
const projectPick = async (
    session: PickSession,
    picker: Parameters<PickSession['pick']>[0],
    name: string,
    inLock: (picked: PickedFile) => Promise<Outcome>,
    size: number,
): Promise<Outcome | Dismissed> => {
    let outcome: Outcome | Dismissed
    try {
        outcome = await session.pick(picker, name, inLock, size)
    } catch (error) {
        if (!session.offered?.emptied) throw error
        const failure = fileError(error)
        outcome = { kind: 'failed', error: failure, name: failure.fileName ?? name }
    }
    return outcome.kind === 'failed' && session.offered?.emptied
        ? { ...outcome, reported: true }
        : outcome
}

/** The document identity and destination retained by Try Again. */
type PickRetry = { docId: string; target?: PickedFile['target'] }

/**
 * Saves through the picker, or downloads where there's none: one pick session for every picker
 * of the Save family. The file is built and verified first, then picked, checked
 * under `nse-bind` exclusive, written over the emptied file (its empty state the precondition)
 * and bound.
 */
const pickAndWrite = async (
    env: Env,
    request: PickRequest,
    retry: PickRetry = { docId: crypto.randomUUID() },
): Promise<Outcome> => {
    const ended = await withPickSession(
        {
            env,
            name: retry.target?.handle.name ?? request.fileName,
            surface: 'save',
            purpose: 'save',
            commitFirst: true,
            ...(retry.target
                ? { target: retry.target, permission: requestWrite(retry.target.handle) }
                : {}),
            committed: (target) => {
                retry.target = target
            },
            // A large download on a touch device would outlast the tap: "Preparing…" opens at
            // once, with the estimated size.
            ...(largeDownload(request.estimated) ? { estimated: request.estimated } : {}),
            ui: pickUi,
        },
        (session) => saveBody(session, env, request, retry.docId),
    )
    if (ended.kind === 'failed') return { ...ended, retry: () => pickAndWrite(env, request, retry) }
    return ended.kind === 'dismissed' ? { kind: 'cancelled' } : ended
}

const saveBody = async (
    session: PickSession,
    env: Env,
    request: PickRequest,
    newDocId: string,
): Promise<Outcome | Dismissed> => {
    const reserved = await session.reserve()
    if (!reserved) return { kind: 'cancelled' }
    const { reservation, state } = reserved
    const binding = quickBinding(env)
    const docId = request.target === 'new' ? newDocId : binding.docId
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

    return projectPick(
        session,
        projectPicker(request.startIn),
        request.fileName,
        (file) => projectPicked(session, env, reserved, built, request, binding, file),
        built.blob.size,
    )
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
    startWrite('download')
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

/** Writes the prepared project to any empty pick, then records its binding. */
const projectPicked = async (
    session: PickSession,
    env: Env,
    { reservation, state }: Reserved,
    first: BuiltSave,
    request: PickRequest,
    binding: Binding,
    picked: PickedFile,
): Promise<Outcome> => {
    const { target, filled } = picked
    const { handle } = target
    const name = handle.name
    startWrite('picker')
    if (filled) return changedWhilePicked(name)
    let built = first
    if (name !== request.fileName) {
        try {
            built = await runBuild(env, {
                target:
                    request.target === 'new'
                        ? { kind: 'new', docId: first.identity.docId }
                        : { kind: 'copy' },
                history: request.history,
                bgm: request.bgm,
                fileName: name,
                save: { time: reservation.wall, operation: saveOperation(name, false) },
                state,
            })
        } catch (error) {
            // The verified first build differs only in its recorded filename.
            recordError(error)
        }
    }
    await revokePicked(env, handle, false)
    await savePoint('revoked')
    return writePickedProject(session, env, { reservation, state }, built, binding, picked)
}

/** Rewrites the open project's file when an export picks it. */
export const rewriteOwnProject = async (
    session: PickSession,
    env: Env,
    { reservation, state }: Reserved,
    request: PickRequest,
    binding: Binding,
    picked: PickedFile,
): Promise<Outcome> => {
    const { target, filled, pre } = picked
    const { handle } = target
    const name = handle.name
    startWrite('picker')
    let built: BuiltSave
    // This chain's own file keeps the identity, appending to the bytes read first.
    if (filled) return { kind: 'conflict', handle, binding }
    // Not at the base: the version read goes back (the session, offered as a download when
    // it can't), and the conflict dialog shows it.
    if (pre && !pre.atBase) return { kind: 'conflict', handle, binding }
    // The export rewrite uses the default options and keeps the file's history.
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
            // Retry a worker failure once. A build refusal will not change on retry.
            if (error instanceof BuildRefused) throw error
            recordError(error)
            return rebuild()
        })
    } catch (error) {
        if (error instanceof BuildRefused)
            return { kind: 'error', message: refusalText(error, name) }
        return { kind: 'failed', error: fileError(error), name }
    }
    const outcome = await writePickedProject(
        session,
        env,
        { reservation, state },
        built,
        binding,
        picked,
    )
    return outcome.kind === 'failed' && outcome.error.code === 'conflict'
        ? { kind: 'conflict', handle, binding }
        : outcome
}

/** Records one verified project write and its Save entry. */
const writePickedProject = async (
    session: PickSession,
    env: Env,
    { reservation, state }: Reserved,
    built: BuiltSave,
    binding: Binding,
    picked: PickedFile,
): Promise<Outcome> => {
    const handle = picked.target.handle
    const name = handle.name
    const file = await bindingFile(built, reservation, {
        name,
        event: 'saved',
        handle,
    })
    const parent = built.identity.revision.ancestors.length ? (binding.revision?.id ?? null) : null
    let result: SaveResult
    try {
        result = await picked.write({
            kind: 'nxsp',
            blob: built.blob,
            marker: () => markerOf(env, built, reservation, parent, file),
        })
    } catch (error) {
        const failure = fileError(error)
        return { kind: 'failed', error: failure, name }
    }
    if (result.status !== 'saved') return { kind: 'cancelled' }
    await savePoint('closed')
    rememberHandle(env.chainId, handle)
    await bindWrite(env, session, reservation, built, state, {
        ...file,
        ...(result.disk ? { disk: result.disk } : {}),
    })
    feedback(built, 'saved', name)
    return { kind: 'done' }
}

/** A picked file holding what nobody here wrote: nothing is written over it. */
const changedWhilePicked = (name: string): Outcome => ({
    kind: 'failed',
    error: new FileError('conflict', `${name} changed on disk`, undefined, 'check'),
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
    // After a failed read, the Save is not recognised, and its marker stays.
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
    // After a failed read, the session keeps the record it had.
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
    // A continuation not stored yet tries to commit its first row here, before the reservation, the
    // build and the write. A Save that ends earlier (no changes, a conflict, a missing file) leaves
    // the visit unstored; one that ends later can leave it stored.
    if (!(await commitFirst(env))) return { kind: 'forked' }
    // Inside the hold of `nse-bind`: a reservation another flow holds is not waited for.
    const reserved = await attempt.reserve(false)
    if (!reserved) return { kind: 'cancelled' }
    const { reservation, state } = reserved
    startWrite('writeBack')
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
        // Replace needs its guard: a failed read, or no decision, never leaves it
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
    if (!disk?.revisionId || !project) return () => i18n.value.conflict.replaceDamaged
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
    const { input, pinned, newer } = await conflictInput(env, binding, handle)
    setDiskFinding(newer ? 'newer' : 'changed')
    const choice: ConflictChoice | undefined = await saveUi.conflict(input)
    switch (choice) {
        case 'separate':
            await separateFile(env, binding, handle)
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
    // Without the code that keeps the version on disk, nothing is written and the card says so.
    const project = await loadForAction(() => import('../commands/open/project'))
    if (!project) return
    const { keepReplaced } = project
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
        // A failed read shows the bar's error below.
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
                  ? () => i18n.value.conflict.replaceDamaged
                  : () => i18n.value.notSaving.bar,
        )
        return
    }
    // One attempt, as for the write-back. It waits for the chain's imports before it writes over
    // the file, and `writeBack` tries to commit a continuation's first row before the write.
    const outcome = await withSaveAttempt(
        {
            env,
            name: handle.name,
            surface: 'save',
            ui: preparingUi,
            commitFirst: false,
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

/** Save as a Separate File…: keeps the `docId`, in the original's folder. */
const separateFile = async (env: Env, binding: Binding, handle: FileSystemFileHandle) => {
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
        }),
        () => separateFile(env, quickBinding(env), handle),
    )
}

/**
 * Shows a follow-up dialog. Recent Sessions' retries repeat the selected session's Save.
 */
export const afterOutcome = async (
    env: Env,
    outcome: Outcome | { kind: 'noChanges' },
    again: () => Promise<void> = () => dialogSave(env, 'save'),
    of: 'open' | 'stored' = 'open',
): Promise<void> => {
    finishSave(outcome)
    const stored = of === 'stored'
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
                [interpolate(() => i18n.value.open.damagedHistory, inlineName(outcome.name))],
                true,
            )
            return
        case 'error':
            saveUi.error(outcome.message)
            return
        case 'conflict':
            // Only a binding of this very file has a conflict dialog: anything else changed.
            if (outcome.binding.file?.name !== outcome.handle.name) {
                await afterOutcome(env, changedWhilePicked(outcome.handle.name))
                return
            }
            await conflictFlow(env, outcome.binding, outcome.handle)
            return
        case 'refused': {
            const choice = await saveUi.refused(outcome.name, outcome.reason)
            if (choice === 'chooseAnother') await again()
            return
        }
        case 'failed': {
            const { error, name } = outcome
            recordError(error)
            console.warn('A Save failed', error)
            if (outcome.reported) return
            const writable = !!platform.pickSaveFile
            const saveAs = stored ? again : () => dialogSave(env, 'saveAs')
            let choice: 'saveAs' | 'tryAgain' | undefined
            switch (error.code) {
                case 'not-found':
                    // Only the file the session is bound to now is marked, never a pick that the
                    // binding did not move to or a stored session's pick.
                    if (!stored && quickBinding(env).file?.name === name) setDiskFinding('missing')
                    choice = await saveUi.notFound(name)
                    if (choice === 'saveAs') await (stored ? again() : notFoundSaveAs(env))
                    return
                case 'denied':
                    choice = await saveUi.denied(name)
                    // Try Again asks for permission again, on this press.
                    if (choice === 'tryAgain') {
                        if (outcome.retry) await afterOutcome(env, await outcome.retry(), again, of)
                        else await (stored ? again() : saveNow(env))
                    } else if (choice === 'saveAs') await saveAs()
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
            if (choice === 'saveAs') await saveAs()
            return
        }
    }
}

/** Export Level Data (the Save dialog's Export line), as its command runs. */
const openExport = async () => {
    const { commands } = await import('../commands')
    const { runCommand } = await import('../commands/runCommand')
    await runCommand(commands.exportLevel, 'button')
}

/** Downloads held bytes that an export could not restore. */
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
    const input = await dialogInput(env, 'saveAs', await fieldNames(env, stem), [])
    const result = await saveUi.saveDialog(input)
    if (result?.action === 'export') {
        await openExport()
        return
    }
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
    let fallbackBgm: number | undefined
    try {
        fallbackBgm = scpSilentMp3Size(scpSilenceSecondsFromState(state), NXSP_CAPS.media)
    } catch {
        // A duration past the writer's cap leaves the total unknown.
    }
    return {
        ...estimate,
        fallbackBgm,
        ...(estimate.bgm === undefined && source ? { bgm: source.byteLength } : {}),
    }
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
    names: { name: string; placeholder: string },
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
        ...names,
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
    const names = await fieldNames(env, copy ? copyStem(stem, !!binding.file) : stem)
    const replaced = binding.replaced
    const replacedLine = replaced
        ? [interpolate(() => i18n.value.file.replacedElsewhere, inlineName(replaced.name))]
        : []
    const input = await dialogInput(env, kind, names, [...lines, ...replacedLine])
    const result = await saveUi.saveDialog(input)
    if (!result) return
    if (result.action === 'export') {
        await openExport()
        return
    }
    startSave(kind, answered(input, result))
    await afterOutcome(
        env,
        await pickAndWrite(env, {
            dialog: kind,
            fileName: result.fileName,
            ...answered(input, result),
            ...estimateOf(input, result),
            // Save As… gives a new `docId`; a first Save, a fork's and a taken-over chain's keep it.
            target: kind === 'saveAs' && !unlinked ? 'new' : 'copy',
        }),
        // Choose Another… is this Save again, Save As… staying Save As… (a new `docId`).
        () => dialogSave(env, kind, lines, unlinked),
    )
}

/** A Save bound by name (a download, or a file opened without a handle). */
const downloadAgain = async (env: Env, file: StoredFile) => {
    startSave('downloadAgain')
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
            startWrite('download')
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
        await tracked('save', () => saveNow(env))
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
    // The attempt waits for the permission and for the chain's imports. The check, the attempted
    // commit of a continuation's first row and the write then run with `nse-bind` held shared.
    const outcome = await withSaveAttempt(
        {
            env,
            name: file.name,
            surface: 'save',
            ui: preparingUi,
            commitFirst: false,
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
        await refreshBinding(env.worker, env.flusher)
        await dialogSave(env, 'save')
        return
    }
    if (outcome.kind === 'noChanges') {
        finishSave(outcome)
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
        await tracked('saveAs', () => dialogSave(env, 'saveAs'))
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
            saveUi.error(() => i18n.value.save.sessionUnavailable)
            return
        }
        await tracked('saveToFile', () => saveToFileNow(env, sessionId))
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
        // Storage could not be read: that is not a missing session. Not
        // `save.storageUnavailable`: its "use Save As…" would save the open session, not this one.
        recordError(error)
        saveUi.error(() => i18n.value.notice.storageUnavailable)
        return
    }
    if (read.kind !== 'open') {
        saveUi.error(() => i18n.value.save.sessionUnavailable)
        return
    }
    const chainId = read.session.chainId as string
    const stem = prefillOf(displayName(namePartsOf(read.chain)))
    const updatedAt =
        typeof read.session.updatedAt === 'number' ? read.session.updatedAt : Date.now()
    const names = await fieldNames(
        env,
        stem ? interpolateRaw(i18n.value.save.restoredName, stem, formatDate(updatedAt)) : '',
    )
    // The session's own head, as storage holds it: its BGM row is what a build would write.
    const estimate = await env.worker
        .call('estimateSaveSize', { chainId, sessionId })
        .catch(failedEstimate)
    const input: SaveDialogInput = {
        kind: 'saveToFile',
        ...names,
        lines: [],
        history: globalThis.isSecureContext
            ? { kind: 'available', ticked: true, locked: false }
            : { kind: 'insecure' },
        bgm: sessionBgmRow(estimate),
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
    const result = await saveUi.saveDialog(input)
    if (result?.action !== 'save') return
    const options = answered(input, result)
    startSave('saveToFile', options)
    const estimated = estimatedTotal(input, options)
    // Its session hold before the build, so Delete Sessions… skips it. Released
    // before what follows, so Choose Another… holds it again for its own write.
    const outcome = await writeSessionFile(env, {
        chainId,
        sessionId,
        fileName: result.fileName,
        ...options,
        ...(estimated === undefined ? {} : { estimated }),
        committed: applied === 'held',
    })
    // Choose Another, Try Again and Save As are Recent Sessions' Save for this session again,
    // never the open one's Save.
    await afterOutcome(env, outcome, () => saveToFileNow(env, sessionId), 'stored')
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
}

/** Builds a stored session as a new file, binding nothing and taking no reservation. */
const writeSessionFile = async (
    env: Env,
    request: SessionFileRequest,
    retry: PickRetry = { docId: crypto.randomUUID() },
): Promise<Outcome> => {
    const permission = retry.target ? requestWrite(retry.target.handle) : undefined
    permission?.catch(() => undefined)
    const ended = await withSessionHold(request.sessionId, () =>
        withPickSession(
            {
                env,
                name: retry.target?.handle.name ?? request.fileName,
                surface: 'save',
                purpose: 'saveToFile',
                commitFirst: false,
                ...(retry.target ? { target: retry.target } : {}),
                ...(permission ? { permission } : {}),
                committed: (target) => {
                    retry.target = target
                },
                // The written session's imports are waited for; the pick's own last check covers any
                // this tab runs.
                importChain: request.chainId,
                ...(largeDownload(request.estimated) ? { estimated: request.estimated } : {}),
                ui: pickUi,
            },
            (session) => sessionFileBody(session, env, request, retry.docId),
        ),
    )
    if (ended.kind === 'failed')
        return { ...ended, retry: () => writeSessionFile(env, request, retry) }
    return ended.kind === 'dismissed' ? { kind: 'cancelled' } : ended
}

/** The session as a new document `docId`, in a file named `fileName`. */
const buildSession = (env: Env, request: SessionFileRequest, docId: string, fileName: string) =>
    env.worker.call(
        'buildSave',
        {
            chainId: request.chainId,
            target: { kind: 'new', docId, sessionId: request.sessionId },
            options: {
                history: request.history,
                bgm: request.bgm,
                fileName,
                save: {
                    time: Date.now(),
                    operation: saveOperation(fileName, !platform.pickSaveFile),
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
    )

const sessionFileBody = async (
    session: PickSession,
    env: Env,
    request: SessionFileRequest,
    docId: string,
): Promise<Outcome | Dismissed> => {
    let began = 0
    const built = await session
        .preparing(() => {
            began = performance.now()
            return buildSession(env, request, docId, request.fileName)
        })
        .catch((error: unknown) => fileError(error))
    if (began) builtIn(performance.now() - began)
    session.checkpoint()
    if (built instanceof FileError) return { kind: 'failed', error: built, name: request.fileName }
    if ('refused' in built)
        return {
            kind: 'error',
            message: refusalText(new BuildRefused(built), request.fileName),
        }
    if (!platform.pickSaveFile) {
        let result: SaveResult
        startWrite('download')
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
            ofStored: true,
        })
        markFirstSaveDone()
        return { kind: 'done' }
    }
    return projectPick(
        session,
        projectPicker(),
        request.fileName,
        (file) => sessionFilePicked(env, request, built, file),
        built.blob.size,
    )
}

/**
 * The session built again for the same document, under the name the picker gave its file. When
 * the rebuild fails or is refused, the first build is written under the typed name, since the
 * picked file is already empty and that build was verified.
 */
const renamedBuild = async (
    env: Env,
    request: SessionFileRequest,
    first: BuiltSave,
    name: string,
) => {
    try {
        const built = await buildSession(env, request, first.identity.docId, name)
        if (!('refused' in built)) return built
        recordError(new BuildRefused(built))
    } catch (error) {
        recordError(error)
    }
    return first
}

/** The pick, inside the session's hold, for a file that binds nothing. */
const sessionFilePicked = async (
    env: Env,
    request: SessionFileRequest,
    first: BuiltSave,
    picked: PickedFile,
): Promise<Outcome> => {
    const { target, filled } = picked
    const name = target.handle.name
    startWrite('picker')
    // Written since the pick (a sync client): never written over unseen.
    if (filled)
        return {
            kind: 'failed',
            error: new FileError('conflict', `${name} changed`, undefined, 'check'),
            name,
        }
    // A picker that renamed the file: its own name goes into the `save` entry and
    // `revision.fileName`, as a Save's does. Rebuilt after the checks above and before anything
    // is revoked.
    const built = name === request.fileName ? first : await renamedBuild(env, request, first, name)
    await revokePicked(env, target.handle, true)
    try {
        await picked.write({ kind: 'nxsp', blob: built.blob })
    } catch (error) {
        return { kind: 'failed', error: fileError(error), name }
    }
    saveUi.saved({
        ...savedOf(built, 'saved', name),
        committedState: request.committed,
        ofStored: true,
    })
    markFirstSaveDone()
    return { kind: 'done' }
}

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

/**
 * Open the Other Version: the file on disk as a new session in place of this one, which
 * keeps its changes. It asks first when this session's work is not stored. A file that can't
 * be read says so.
 */
const openOther = (
    handle: FileSystemFileHandle | undefined,
    name: string,
    supplied?: SwitchRequest,
) =>
    withSwitchRequest(supplied, async (request) => {
        // Ask first, as every other switch does, when the switch would lose work held only in
        // memory. `../switch` is imported here because it pulls in the dialogs and the chip,
        // which Save's core does not need.
        const { confirmSwitch } = await import('../switch')
        if (!(await confirmSwitch()) || !request.isCurrent()) return
        try {
            const opened = await handle?.getFile().catch(() => undefined)
            if (!request.isCurrent()) return
            if (!handle || !opened) {
                saveUi.error(interpolate(() => i18n.value.save.readFailed, name))
                return
            }
            const project = await loadForAction(() => import('../commands/open/project'))
            if (project && request.isCurrent()) await project.openProject(opened, handle, request)
        } catch (error) {
            if (request.isCurrent()) throw error
        }
    })

/** Reads the bound file's stored handle ahead of a Save, once the session is edited. */
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
