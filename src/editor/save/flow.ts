import { session as currentSession } from '../../history/session'
import { isPeeking } from '../../history/stack'
import { i18n } from '../../i18n'
import { formatDateTime } from '../../i18n/dateTime'
import { formatDate } from '../../i18n/when'
import { launch } from '../../launch'
import type { Flusher, FlushSession, SaveReservation } from '../../local/flush'
import { handleOf, readableWithoutPrompt, storableHandle } from '../../local/handles'
import { toHex } from '../../local/hash'
import { displayName, namePartsOf, stemOf } from '../../local/names'
import { NXSP_MINOR, NXSP_VERSION } from '../../local/nxsp/version'
import { isImporting, whenImported } from '../../local/open/importLoop'
import type { HandleOwner } from '../../local/save/bind'
import type { IdentityUnit } from '../../local/save/commit'
import type { BuiltSave } from '../../local/save/execute'
import { sessionContext } from '../../local/startup/api'
import { storageStatus } from '../../local/startup/events'
import { journalWriter, flusher as storingFlusher } from '../../local/storing'
import {
    appVersion,
    FileError,
    platform,
    type DiskState,
    type FileTarget,
    type SaveResult,
} from '../../platform'
import { hasActivation, reportsActivation } from '../../platform/detect'
import { sameContent } from '../../platform/fingerprint'
import { requestWrite } from '../../platform/handover'
import { savePoint } from '../../platform/testPause'
import { PRODUCT_NAME } from '../../product'
import { isSafeMode } from '../../safe'
import { settings } from '../../settings'
import type { State } from '../../state'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { validName } from '../commands/exportLevel/fileName'
import { exportMemory, sameEntry } from '../commands/exportLevel/memory'
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
    readRevocation,
    rememberHandle,
    removeMarker,
    savedState,
    withBind,
    writeMarker,
    writeRevocation,
    type SaveMarker,
} from './env'

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
    const context = sessionContext()
    const flusher: Flusher | undefined = storingFlusher
    const session = flusher?.session
    if (!context || !flusher || !session) return
    return { worker: context.open.worker, flusher, session, chainId: session.chainId }
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
const readBinding = async (env: Env) => {
    const record = await env.worker.call('readChainRecord', env.chainId)
    const binding = bindingOf(record, env.session)
    const revoke = readRevocation(env.chainId)
    // A revocation of this binding kept while storage couldn't take it (R11).
    const fileAt = binding.file?.at
    if (revoke && typeof fileAt === 'number' && revoke.fileAt === fileAt && !env.session.identity)
        return {
            docId: binding.docId,
            ...(binding.revision ? { revision: binding.revision } : {}),
            replaced: { by: revoke.by, at: revoke.at, name: revoke.name },
        }
    return binding
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

const unitOf = (built: BuiltSave, file: Row): IdentityUnit => ({
    docId: built.identity.docId,
    revision: built.identity.revision,
    file,
    marks: built.identity.marks,
})

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
        unitOf(built, file),
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

const feedback = (built: BuiltSave, kind: 'saved' | 'download', name: string, tookOver = false) => {
    saveUi.saved({
        kind,
        name,
        size: built.blob.size,
        someStepsNotKept: built.someStepsNotKept,
        tookOver,
        without: built.without,
        tooLarge: built.tooLarge,
    })
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

/**
 * Reads the chain's own file before a save picker that may return it (R2): its tail always,
 * and whole only when it isn't at the base or the write wouldn't carry its `completeFrom`.
 * Only with read access already granted; resolves undefined otherwise.
 */
const preRead = async (env: Env, binding: Binding): Promise<PreRead | undefined> => {
    const file = binding.file
    if (!file) return
    const handle = await bindingHandle(env, file)
    if (!handle || !(await readableWithoutPrompt(handle))) return
    try {
        const disk = await platform.inspect({ kind: 'handle', handle }, 'nxsp')
        if (disk === 'missing' || disk.size === 0) return
        const atBase = !!file.disk && sameContent(disk, file.disk)
        const picked = await handle.getFile()
        if (atBase) {
            const facts = await readDiskFacts(picked, deviceId())
            const decision = await env.worker.call('replaceDecision', {
                chainId: env.chainId,
                projectJson: facts.projectJson,
                fingerprint: disk.fingerprint,
            })
            // Storage holds every row the file does: nothing to keep.
            if (!decision?.holdsBase) return
        }
        // Into memory: a picker empties the file under any `File` read before.
        const blob = new Blob([await picked.arrayBuffer()])
        return { blob, disk, atBase }
    } catch {
        return
    }
}

// The save picker (§1.4.7 R1–R12).

/** What a picked handle is (R3, R7). */
type Picked =
    | { kind: 'own' }
    | { kind: 'other'; owner: HandleOwner }
    | { kind: 'refused'; reason: RefusedReason; bytes?: ArrayBuffer }
    | { kind: 'unknown' }

/** Identifies a picked file under `nse-bind` (R3, R7), outside any transaction. */
const identify = async (env: Env, handle: FileSystemFileHandle): Promise<Picked> => {
    const { opened } = exportMemory
    if (opened && (await sameEntry(handle, opened.handle))) {
        if (!opened.project)
            return {
                kind: 'refused',
                reason: opened.levelData ? 'levelData' : 'notProject',
                ...(opened.kept ? { bytes: opened.kept } : {}),
            }
        if (opened.partial)
            return {
                kind: 'refused',
                reason: 'notKept',
                ...(opened.bytes ? { bytes: opened.bytes } : {}),
            }
    }
    const own = quickBinding(env).file
    const held = own && heldHandle(env.chainId, own.name)
    if (held && (await sameEntry(handle, held))) return { kind: 'own' }
    let owners: HandleOwner[] = []
    try {
        owners = await env.worker.call('listHandleOwners')
    } catch {
        // Storage unavailable: no other chain is known (R11), and the pick is R8's.
    }
    for (const owner of owners) {
        if (!owner.handle) continue
        const stored = await handleOf(env.worker, owner.chainId, owner.role)
        if (!stored || !(await sameEntry(handle, stored))) continue
        if (owner.role === 'exportTarget') return { kind: 'refused', reason: 'levelData' }
        return owner.chainId === env.chainId ? { kind: 'own' } : { kind: 'other', owner }
    }
    return { kind: 'unknown' }
}

/** Writes bytes back into a picked file while it's still empty (R4, R7); true when it holds them. */
const putBack = async (target: FileTarget, empty: DiskState, bytes: ArrayBuffer | Blob) => {
    try {
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

/** Takes a file over from another chain (R5), or keeps the revocation in localStorage (R11). */
const revoke = async (env: Env, owner: HandleOwner | undefined, preBind: Row | undefined) => {
    const at = Date.now()
    try {
        const done = await env.worker.call('takeOver', {
            ...(owner ? { owner } : {}),
            ...(preBind ? { preBind: { chainId: env.chainId, file: preBind } } : {}),
            by: env.chainId,
            at,
        })
        return { ok: true, revoked: done.revoked }
    } catch {
        // Storage paused or full: the revocation goes to localStorage first (R11).
        if (!owner) return { ok: true, revoked: false }
        if (isSafeMode() || owner.at === undefined) return { ok: false, revoked: false }
        const kept = writeRevocation(owner.chainId, {
            by: env.chainId,
            at,
            name: owner.name,
            fileAt: owner.at,
        })
        return { ok: kept, revoked: kept }
    }
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
    | { kind: 'refused'; name: string; reason: RefusedReason; emptied: boolean }
    | { kind: 'conflict'; handle: FileSystemFileHandle; binding: Binding }
    | { kind: 'failed'; error: FileError; name: string }
    | { kind: 'error'; message: () => string }

let busy = false

/** One Save at a time in a tab. */
const exclusive = async (run: () => Promise<void>) => {
    if (busy) return
    busy = true
    try {
        await run()
    } finally {
        busy = false
    }
}

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
    // A read that hasn't finished by now is dropped (R2).
    const pre = await Promise.race([
        request.pre ?? Promise.resolve(undefined),
        Promise.resolve(undefined),
    ])
    const picked = target
    await savePoint('picked')
    return withBind('exclusive', () =>
        afterPick(env, reservation, built, state, request, binding, picked, pre),
    )
}

/** After a pick, under `nse-bind` exclusive: R3–R9, the write, and the binding. */
const afterPick = async (
    env: Env,
    reservation: SaveReservation,
    prebuilt: BuiltSave,
    state: State,
    request: PickRequest,
    binding: Binding,
    target: FileTarget & { kind: 'handle' },
    pre: PreRead | undefined,
): Promise<Outcome> => {
    const { handle } = target
    const name = handle.name
    let empty: DiskState
    try {
        const found = await platform.inspect(target, 'nxsp')
        if (found === 'missing') throw new FileError('not-found', `${name} cannot be found`)
        empty = found
    } catch (error) {
        await env.flusher.endSave(reservation)
        return { kind: 'failed', error: fileError(error), name }
    }
    const picked = await identify(env, handle)
    let built = prebuilt
    let tookOver = false
    switch (picked.kind) {
        case 'refused': {
            // R7: refused, and the bytes kept at its open put back while it's still empty.
            await env.flusher.endSave(reservation)
            const back = picked.bytes ? await putBack(target, empty, picked.bytes) : false
            return { kind: 'refused', name, reason: picked.reason, emptied: !back }
        }
        case 'own': {
            // R4: this chain's own file keeps the identity, appending to the bytes read first.
            if (pre && !pre.atBase) {
                await env.flusher.endSave(reservation)
                await putBack(target, empty, pre.blob)
                return { kind: 'conflict', handle, binding }
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
            if (request.dialog === 'saveToFile') break
            const preBind = {
                name,
                handle: await storableHandle(handle),
                event: 'saved',
                at: reservation.wall,
                // A hash no state has: the pre-bound chain counts as changed (R9).
                hash: new Uint8Array(16),
                disk: empty,
                options: { history: request.history, bgm: request.bgm },
            }
            const done = await revoke(
                env,
                picked.kind === 'other' ? picked.owner : undefined,
                preBind,
            )
            if (!done.ok) {
                await env.flusher.endSave(reservation)
                return { kind: 'refused', name, reason: 'safeMode', emptied: true }
            }
            tookOver = done.revoked
            await savePoint('revoked')
            break
        }
    }
    if (request.dialog === 'saveToFile' && picked.kind === 'other') {
        const done = await revoke(env, picked.owner, undefined)
        tookOver = done.revoked
    }

    const file =
        request.dialog === 'saveToFile'
            ? undefined
            : await bindingFile(built, reservation, {
                  name,
                  event: 'saved',
                  handle,
                  options: {
                      history: !!built.identity.entry,
                      bgm:
                          picked.kind === 'own'
                              ? (binding.file?.options.bgm ?? request.bgm)
                              : request.bgm,
                  },
              })
    const written = await writeBuilt(env, reservation, built, target, empty, binding, file)
    if (written.kind !== 'saved') return written.outcome
    await savePoint('closed')
    rememberHandle(env.chainId, handle)
    if (tookOver) broadcastUpdated()
    if (file)
        await bindWrite(env, reservation, built, state, {
            ...file,
            ...(written.disk ? { disk: written.disk } : {}),
        })
    else await env.flusher.endSave(reservation)
    feedback(built, 'saved', name, tookOver)
    return { kind: 'done' }
}

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
        // The write may have landed (a failed read-back): its `seq` stays for the marker.
        await env.flusher.endSave(reservation, undefined, undefined, true)
        const failure = fileError(error)
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
const ownCompletedSave = async (env: Env, binding: Binding, file: Blob, disk: DiskState) => {
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
    const handle = heldHandle(env.chainId, String(unit.file.name))
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
        return await ownCompletedSave(env, binding, file, disk)
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
        await env.flusher.endSave(reservation, undefined, undefined, !!built)
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
    const { input, pinned, newer } = await conflictInput(env, binding, handle)
    setDiskFinding(newer ? 'newer' : 'changed')
    const choice: ConflictChoice | undefined = await saveUi.conflict(input)
    switch (choice) {
        case 'separate':
            await separateFile(env, binding, handle)
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
        if (!file || binding.replaced) return { kind: 'cancelled' }
        return writeBack(env, handle, binding, file, pinned.disk, replaces)
    })
    await afterOutcome(env, outcome)
}

/** Save as a Separate File (§1.4.7): keeps the `docId`, in the original's folder. */
const separateFile = async (env: Env, binding: Binding, handle: FileSystemFileHandle) => {
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
            await conflictFlow(env, outcome.binding, outcome.handle)
            return
        case 'refused': {
            if (outcome.emptied && outcome.reason !== 'safeMode') {
                await saveUi.notPutBack(outcome.name, true)
                return
            }
            const choice = await saveUi.refused(outcome.name, outcome.reason)
            if (choice === 'chooseAnother') await dialogSave(env, 'save')
            else if (choice === 'export') {
                const { exportLevel } = await import('../commands/exportLevel')
                await exportLevel.execute()
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
    const stem = shownStem(env, state)
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
        const { exportLevel } = await import('../commands/exportLevel')
        await exportLevel.execute()
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
                void exclusive(() => downloadAgain(env, file))
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
