import { i18n } from '../../i18n'
import { handleOf, readableWithoutPrompt, requestRead } from '../../local/handles'
import { importsRunning } from '../../local/open/importLoop'
import { copiesRunning, readKeptCopy, whenCopied } from '../../local/open/kept'
import type { HandleOwner } from '../../local/save/bind'
import { storedRead } from '../../local/storedRead'
import {
    diskStateOfBytes,
    FileError,
    platform,
    type DiskState,
    type FileTarget,
    type SavePicker,
    type SaveResult,
} from '../../platform'
import { hasActivation, reportsActivation } from '../../platform/detect'
import { nxspDiskState, sameContent } from '../../platform/fingerprint'
import { savePoint } from '../../platform/testPause'
import { exportMemory, sameEntry, type OpenedSource } from '../commands/exportLevel/memory'
import { bindingHandle, quickBinding, type Binding, type Env } from './binding'
import type { RefusedReason } from './dialogs'
import { heldHandle, savedState, withBind, type SaveMarker } from './env'
import { pause, PREPARING_MS } from './imports'
import {
    Cancelled,
    commitFirst,
    withSaveAttempt,
    type AttemptSpec,
    type Ending,
    type Reserved,
    type SaveAttempt,
} from './saveAttempt'

// The pick session: every save picker opens here, and nowhere else. It
// waits for imports, checks activation last and holds `nse-bind` exclusive after the pick.
// Save writes its prepared project. Exports still identify the file and restore or offer
// bytes when they refuse it. The flows own the output; the session owns the picker and hold.

// Reading the chain's own file before an export picker.

/** The chain's own file read before a picker: its bytes, and the handle they were read from. */
export type PreRead = { blob: Blob; disk: DiskState; atBase: boolean; handle: FileSystemFileHandle }

export type ReadResult =
    | { readonly kind: 'read'; readonly pre: PreRead }
    /** At the base, with storage holding all the base does (or an empty file): nothing to keep. */
    | { readonly kind: 'notNeeded' }
    /** No binding, no handle, or no grant. */
    | { readonly kind: 'noAccess' }
    /** The read threw, or storage's handle read failed: tried once more. */
    | { readonly kind: 'failed' }

/** The head's media whose bytes this tab doesn't hold, by hash: storage or the file may. */
const mediaNotHeld = (state: ReturnType<typeof savedState>) => {
    const { meta, source } = state.bgm
    const refs = [
        ...(meta && !source ? [meta] : []),
        ...(state.levelInfo.cover ? [state.levelInfo.cover] : []),
        ...(state.levelInfo.preview ? [state.levelInfo.preview] : []),
    ]
    return refs.map((ref) => ref.hash)
}

const readOwn = async (env: Env, binding: Binding, prompt: boolean): Promise<ReadResult> => {
    const file = binding.file
    if (!file || binding.replaced) return { kind: 'noAccess' }
    const read = await bindingHandle(env, file)
    if (read.storedRead === 'failed') return { kind: 'failed' }
    const handle = read.storedValue
    if (!handle) return { kind: 'noAccess' }
    const needs = await env.worker
        .call('saveNeeds', {
            chainId: env.chainId,
            media: mediaNotHeld(savedState()),
        })
        .catch(() => undefined)
    const short = !needs?.carries || needs.lacking.length > 0
    let readable = await readableWithoutPrompt(handle)
    if (!readable && short && prompt) readable = await requestRead(handle)
    if (!readable) return { kind: 'noAccess' }
    const found = await handle.getFile()
    const disk = await nxspDiskState(found, found.lastModified)
    if (disk.size === 0) return { kind: 'notNeeded' }
    const atBase = !!file.disk && sameContent(disk, file.disk)
    // At the base, with storage holding all it does: nothing to keep.
    if (atBase && !short) return { kind: 'notNeeded' }
    // Into memory: a picker empties the file under any `File` read before. Its time stays, so the
    // copy has the fingerprint read here.
    const blob = new File([await found.arrayBuffer()], found.name, {
        lastModified: found.lastModified,
    })
    return { kind: 'read', pre: { blob, disk, atBase, handle } }
}

/**
 * Reads the chain's own file before an export picker that may return it: whole, and only when it
 * isn't at the base, when storage lacks rows of its base (or knows of damage in them) or head
 * media it may hold. Read access is asked for only when storage lacks something; otherwise only a
 * grant already held reads. `prompt: false`: a
 * read just before a picker opens, on the same press, also only with a grant already held (a prompt
 * would spend the press the picker needs). Never rejects.
 */
export const readOwnFile = async (
    env: Env,
    binding: Binding,
    options: { prompt?: boolean } = {},
): Promise<ReadResult> => {
    try {
        return await readOwn(env, binding, options.prompt ?? true)
    } catch {
        return { kind: 'failed' }
    }
}

// What a picked file is.

/** What a picked handle is. */
export type Picked =
    | { kind: 'own' }
    | { kind: 'other'; owner: HandleOwner }
    /** An Export target: Export's picker writes it; Video refuses it. */
    | { kind: 'target'; owner: HandleOwner }
    /** `bytes`: those kept at its open, once kept. */
    | { kind: 'refused'; reason: RefusedReason; bytes?: Promise<Blob | undefined> }
    | { kind: 'unknown' }

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/**
 * Whether two handles name one file (`isSameEntry`), asked both ways: a handle read back from
 * storage may only compare from its own side (the specs' OPFS tokens).
 */
const same = async (a: FileSystemFileHandle, b: FileSystemFileHandle) =>
    (await sameEntry(a, b)) || sameEntry(b, a)

/** As `same`, and `unsure` when neither side can compare (`isSameEntry` throws both ways). */
const sameOrUnsure = async (
    a: FileSystemFileHandle,
    b: FileSystemFileHandle,
): Promise<'same' | 'different' | 'unsure'> => {
    if (a === b) return 'same'
    let answered = false
    for (const [x, y] of [
        [a, b],
        [b, a],
    ] as const)
        try {
            if (await x.isSameEntry(y)) return 'same'
            answered = true
        } catch {
            // This side can't compare: the other may.
        }
    return answered ? 'different' : 'unsure'
}

/**
 * A pick `identify` can't place (storage's owners unread, no handle held) that is the file the
 * bytes in hand were read from, or may be: the chain's own. So bytes read from what may be
 * the picked file are appended to or put back, never written over.
 */
const placed = async (
    picked: Picked,
    handle: FileSystemFileHandle,
    pre: PreRead | undefined,
): Promise<Picked> =>
    picked.kind === 'unknown' && pre && (await sameOrUnsure(handle, pre.handle)) !== 'different'
        ? { kind: 'own' }
        : picked

/** The bytes a partial open kept, in memory or as an OPFS copy. */
const kept = async (opened: OpenedSource) =>
    (await opened.keptCopy) ?? (opened.bytes && new Blob([opened.bytes]))

/**
 * Identifies a picked file under `nse-bind`, outside any transaction. Without storage
 * (`env` undefined) only the file this session was opened from is known. Export writes over the
 * level data it was opened from, whole; Video refuses it.
 */
const identify = async (
    env: Env | undefined,
    handle: FileSystemFileHandle,
    purpose: PickSpec['purpose'] = 'save',
): Promise<Picked> => {
    const { opened } = exportMemory
    if (opened && (await same(handle, opened.handle))) {
        if (!opened.project) {
            const bytes = opened.kept ?? opened.bytes
            if (!(purpose === 'export' && opened.levelData && !opened.partial))
                return {
                    kind: 'refused',
                    reason: opened.levelData ? 'levelData' : 'notProject',
                    ...(bytes ? { bytes: Promise.resolve(new Blob([bytes])) } : {}),
                }
        }
        // Its bytes are awaited before an export can restore them.
        else if (opened.partial) return { kind: 'refused', reason: 'notKept', bytes: kept(opened) }
    }
    if (!env) return { kind: 'unknown' }
    const own = quickBinding(env).file
    const held = own && heldHandle(env.chainId, own.name)
    if (held && (await same(handle, held))) return { kind: 'own' }
    const list = await storedRead(env.worker, 'listHandleOwners', undefined)
    // A failed list leaves the pick to the other facts, else `unknown`: no other
    // chain is known, and the pick is treated as an unplaced one.
    const owners: HandleOwner[] = list.storedRead === 'value' ? list.storedValue : []
    for (const owner of owners) {
        if (!owner.handle) continue
        const read = await handleOf(env.worker, owner.chainId, owner.role)
        // A failed read of one owner's handle leaves the pick to the other facts, else `unknown`.
        const stored = read.storedRead === 'value' ? read.storedValue : undefined
        if (!stored || !(await same(handle, stored))) continue
        if (owner.role === 'exportTarget') return { kind: 'target', owner }
        // A partial open's file, in this tab after a reload or in another tab.
        if (owner.role === 'kept')
            return { kind: 'refused', reason: 'notKept', bytes: readKeptCopy(owner.chainId) }
        return owner.chainId === env.chainId ? { kind: 'own' } : { kind: 'other', owner }
    }
    return { kind: 'unknown' }
}

/** The level-data builder, loaded before a hold so that nothing loads inside one. */
const levelBuilder = () => import('../commands/exportLevel/build')

/**
 * The bytes an Export target holds, re-exported from this chain's live state, with either
 * compression, when they hash to what the target last held; undefined for another chain's
 * target or any other state.
 */
const targetBytes = async (env: Env, owner: HandleOwner) => {
    if (owner.chainId !== env.chainId) return
    try {
        const read = await storedRead(env.worker, 'readChainRecord', env.chainId)
        // A failed read offers no bytes back for the picked file.
        if (read.storedRead === 'failed') return
        const record = read.storedValue
        const target = isRow(record?.exportTarget) ? record.exportTarget : undefined
        const disk = isRow(target?.disk) ? (target.disk as DiskState) : undefined
        if (!disk) return
        const { buildLevelDataVariants } = await levelBuilder()
        for (const built of await buildLevelDataVariants()) {
            const bytes = await built.arrayBuffer()
            if ((await diskStateOfBytes(bytes, 0)).fingerprint === disk.fingerprint)
                return new Blob([bytes])
        }
        return
    } catch {
        return
    }
}

/** Video's pick of an Export target: level data, refused and put back. */
const refusedTarget = (env: Env, picked: Picked): Exclude<Picked, { kind: 'target' }> =>
    picked.kind === 'target'
        ? { kind: 'refused', reason: 'levelData', bytes: targetBytes(env, picked.owner) }
        : picked

/** A file failure without a file name takes the picked file's, as a write's does. */
const named = (error: unknown, name: string) =>
    error instanceof FileError && error.fileName === undefined
        ? new FileError(error.code, error.message, error.disk, error.step, name)
        : error

/** Writes bytes back into a picked file while it's still empty; true when it holds them. */
const putBack = async (target: FileTarget, bytes: ArrayBuffer | Blob) => {
    try {
        // Its size first: a filled file is never read and hashed whole only to learn that.
        if ((await platform.read(target)).size !== 0) return false
        // Its precondition is the empty file as this write's kind measures it.
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

/** Whether the file now begins with `bytes`: it holds what the editor held of it. */
const beginsWith = async (target: FileTarget, bytes: Blob) => {
    try {
        const now = await platform.read(target)
        if (now.size < bytes.size) return false
        const [a, b] = await Promise.all([
            now.slice(0, bytes.size).arrayBuffer(),
            bytes.arrayBuffer(),
        ])
        const head = new Uint8Array(a)
        const wanted = new Uint8Array(b)
        return head.every((byte, i) => byte === wanted[i])
    } catch {
        return false
    }
}

// The session.

/** The project picker: one id, so the browser remembers where it was. */
export const projectPicker = (startIn: SavePicker['startIn'] = 'documents'): SavePicker => ({
    id: 'nse-project',
    types: [{ description: i18n.value.save.fileType, extension: '.nxsp' }],
    excludeAll: true,
    startIn,
})

export type PickSpec = Omit<AttemptSpec, 'importWait' | 'ui'> & {
    readonly purpose: 'save' | 'export' | 'saveToFile' | 'video'
    /** The dialog's read of the chain's own file, or `'start'`: one starting now, with a grant held. */
    readonly read?: Promise<ReadResult> | 'start'
    /** The chain whose imports are waited for, when it is not the environment's (Recent Sessions' Save…). */
    readonly importChain?: string
    /** Called at the commit point with the destination. */
    readonly committed?: (target: FileTarget & { kind: 'handle' }) => void
    /** A denied Save retries its picked file without opening another picker. */
    readonly target?: FileTarget & { kind: 'handle' }
    readonly ui: AttemptSpec['ui'] & {
        /** `own`: a failed write left a confirmed-empty file. */
        notPutBack(
            name: string,
            emptied: boolean,
            downloadable: boolean,
            own: boolean,
        ): Promise<'download' | undefined>
        /** Downloads the bytes of an offer, and says so. */
        download(name: string, bytes: Blob): Promise<void>
    }
}

export type Dismissed = { readonly kind: 'dismissed' }

export type PickedFile = {
    readonly target: FileTarget & { kind: 'handle' }
    /** Inspected inside the hold: the write's precondition. */
    readonly found: DiskState
    /** Written since the pick (a sync client, another tab): the file is not empty. */
    readonly filled: boolean
    /** What the pick is: own, other, target, refused or unknown (placed by the bytes in hand). */
    readonly identity: Picked
    /** The slot, when the pick is the file it was read from. */
    readonly pre: PreRead | undefined
    /**
     * Export's own pick, which rewrites the chain's project: tries to commit a continuation's
     * first row, then takes the reservation without waiting. Undefined when the commit forked the
     * session or a Save holds the reservation.
     */
    reserve(): Promise<Reserved | undefined>
    /** The one write to the picked file, over `found`. A failure is thrown. */
    write(request: {
        kind: 'nxsp' | 'nsld'
        blob: Blob
        marker?: () => SaveMarker | undefined
    }): Promise<SaveResult>
}

export type PickSession = Omit<SaveAttempt, 'write' | 'commit' | 'closePreparing'> & {
    /**
     * Opens the picker and runs `inLock` on its pick inside the hold. For an export that did not
     * write, restores or offers the held bytes before returning. A failed Save reports the file
     * here only when it is confirmed empty. `size` is the built file's, for a lapsed activation's press.
     */
    pick<T>(
        picker: SavePicker,
        suggestedName: string,
        inLock: (picked: PickedFile) => Promise<T>,
        size?: number,
    ): Promise<T | Dismissed | Ending>
    /** A download browser's: no picker here. */
    download(request: { suggestedName: string; blob: Blob }): Promise<SaveResult>
    /** The warning shown: `own` selects the confirmed-empty message. Exports report their failure afterwards. */
    readonly offered: { readonly emptied: boolean; readonly own?: true } | undefined
}

/** Rejects with `Cancelled` when `signal` aborts first. */
const unlessCancelled = <R>(promise: Promise<R>, signal: AbortSignal) =>
    new Promise<R>((resolve, reject) => {
        if (signal.aborted) {
            reject(new Cancelled())
            return
        }
        const abort = () => {
            reject(new Cancelled())
        }
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener('abort', abort)
                resolve(value)
            },
            (error: unknown) => {
                signal.removeEventListener('abort', abort)
                reject(error instanceof Error ? error : new Error(String(error)))
            },
        )
    })

/** How often a picker waiting for an import running in this tab looks again. */
const LOCAL_POLL_MS = 100

export const withPickSession = <T>(
    spec: PickSpec,
    body: (session: PickSession) => Promise<T | Dismissed | Ending>,
): Promise<T | Dismissed | Ending> => {
    const { env } = spec
    const saving = spec.purpose === 'save' || spec.purpose === 'saveToFile'
    // Exports start their read on the press, before the waits.
    const reading: Promise<ReadResult> = saving
        ? Promise.resolve({ kind: 'noAccess' })
        : spec.read === 'start' || !spec.read
          ? env
              ? readOwnFile(env, quickBinding(env), { prompt: false })
              : Promise.resolve({ kind: 'noAccess' })
          : spec.read
    let startedAt = performance.now()
    const attemptSpec: AttemptSpec = {
        env,
        name: spec.name,
        surface: spec.surface,
        ui: { preparing: spec.ui.preparing },
        commitFirst: spec.commitFirst,
        importWait: 'chain',
        ...(spec.importChain ? { importChain: spec.importChain } : {}),
        ...(spec.permission ? { permission: spec.permission } : {}),
        ...(spec.estimated === undefined ? {} : { estimated: spec.estimated }),
        ...(spec.signal ? { signal: spec.signal } : {}),
    }
    return withSaveAttempt(attemptSpec, async (attempt) => {
        /** The newest bytes read of the chain's own file: one slot for the session. */
        let slot: PreRead | undefined
        let offered: PickSession['offered']
        let settled: Promise<void> | undefined

        /** The read, awaited; one retry for a failed one, never for a genuine "no handle". */
        const settle = () =>
            (settled ??= attempt.preparing(async (signal) => {
                let result = await unlessCancelled(reading, signal)
                if (result.kind === 'failed' && env)
                    result = await unlessCancelled(
                        readOwnFile(env, quickBinding(env), { prompt: false }),
                        signal,
                    )
                if (result.kind === 'read') slot = result.pre
            }))

        /** Waits for what this tab runs and keeps: an import of any session, a copy being kept. */
        const quiet = () =>
            attempt.preparing(async (signal) => {
                while ((importsRunning() || copiesRunning()) && !signal.aborted) {
                    if (copiesRunning()) await whenCopied(signal)
                    else await pause(LOCAL_POLL_MS, signal)
                }
            })

        const lapsed = () =>
            reportsActivation() ? !hasActivation() : performance.now() - startedAt > PREPARING_MS

        /** Runs `inLock` under `nse-bind` exclusive, then reports emptiness or handles export restoration. */
        const hold = async <R>(
            target: FileTarget & { kind: 'handle' },
            inLock: (picked: PickedFile) => Promise<R>,
        ): Promise<R> => {
            const name = target.handle.name
            let result: R | undefined
            let failure: { error: unknown } | undefined
            let landed = false
            let offer: { emptied: boolean; bytes: Blob | undefined; own?: true } | undefined
            await withBind('exclusive', async () => {
                let found: DiskState | undefined
                let identity: Picked | undefined
                try {
                    const disk = await platform.inspect(target, 'nxsp')
                    if (disk === 'missing')
                        throw new FileError(
                            'not-found',
                            `${name} cannot be found`,
                            undefined,
                            undefined,
                            name,
                        )
                    found = disk
                } catch (error) {
                    failure = { error }
                }
                try {
                    const identified: Picked = saving
                        ? { kind: 'unknown' }
                        : await placed(
                              await identify(env, target.handle, spec.purpose),
                              target.handle,
                              slot,
                          )
                    // Video refuses an Export target.
                    identity =
                        saving || spec.purpose === 'export' || !env
                            ? identified
                            : refusedTarget(env, identified)
                } catch (error) {
                    failure ??= { error }
                }
                if (found && identity && !failure) {
                    const disk = found
                    const picked: PickedFile = {
                        target,
                        found: disk,
                        filled: disk.size !== 0,
                        identity,
                        pre: identity.kind === 'own' ? slot : undefined,
                        reserve: async () => {
                            // A fork leaves the session another one: nothing is written for it.
                            if (!env || !(await commitFirst(env))) return
                            return attempt.reserve(false)
                        },
                        write: async (request) => {
                            // The empty file as this write's kind measures it.
                            const expected =
                                request.kind === 'nxsp'
                                    ? disk
                                    : await platform.inspect(target, request.kind)
                            if (expected === 'missing')
                                throw new FileError(
                                    'not-found',
                                    `${name} cannot be found`,
                                    undefined,
                                    undefined,
                                    name,
                                )
                            // Every pick must still be empty, whatever output is being written.
                            if (expected.size !== 0)
                                throw new FileError(
                                    'conflict',
                                    `${name} changed`,
                                    expected,
                                    'check',
                                    name,
                                )
                            const written = await attempt.write(
                                {
                                    kind: request.kind,
                                    suggestedName: name,
                                    target,
                                    expected,
                                    build: () =>
                                        Promise.resolve({ kind: 'blob', blob: request.blob }),
                                },
                                request.marker,
                            )
                            if (written.status === 'saved') landed = true
                            return written
                        },
                    }
                    try {
                        result = await inLock(picked)
                    } catch (error) {
                        failure = { error }
                    }
                }
                if (landed) return
                if (saving) {
                    const now = await platform.read(target).catch(() => undefined)
                    if (now?.size === 0) offer = { emptied: true, bytes: undefined, own: true }
                    return
                }
                if (!identity) return
                // The bytes the editor holds of the file, which nothing of ours has written.
                const held =
                    identity.kind === 'own'
                        ? slot?.blob
                        : identity.kind === 'refused'
                          ? await Promise.resolve(identity.bytes).catch(() => undefined)
                          : undefined
                const bytes = held && held.size > 0 ? held : undefined
                const isEmpty = async (unreadableIsEmpty = true) => {
                    const now = await platform.inspect(target, 'nxsp').catch(() => undefined)
                    // Restoration treats an unreadable file as emptied because the picker emptied it.
                    // The own-file warning requires a confirmed size of zero.
                    return now === undefined
                        ? unreadableIsEmpty
                        : now !== 'missing' && now.size === 0
                }
                if (!bytes) {
                    // Emptied, with nothing readable to give back.
                    if (
                        (identity.kind === 'refused' || identity.kind === 'own') &&
                        (await isEmpty(identity.kind === 'refused'))
                    )
                        offer = {
                            emptied: true,
                            bytes: undefined,
                            ...(identity.kind === 'own' ? { own: true } : {}),
                        }
                    return
                }
                if ((await isEmpty()) && (await putBack(target, bytes))) return
                // Not empty now: a file that begins with the bytes holds them (a write of ours or a
                // put-back whose read-back failed); anything else lost them, and they are offered.
                const emptied = await isEmpty()
                if (!emptied && (await beginsWith(target, bytes))) return
                offer = { emptied, bytes }
            })
            if (offer) {
                // Right after the hold, before any other dialog: the bytes are in memory only.
                const choice = await spec.ui.notPutBack(
                    name,
                    offer.emptied,
                    offer.bytes !== undefined,
                    offer.own === true,
                )
                offered = { emptied: offer.emptied, ...(offer.own ? { own: true } : {}) }
                if (choice === 'download' && offer.bytes) await spec.ui.download(name, offer.bytes)
            }
            if (failure) throw named(failure.error, name)
            return result as R
        }

        const session: PickSession = {
            env,
            signal: attempt.signal,
            get imported() {
                return attempt.imported
            },
            get offered() {
                return offered
            },
            checkpoint: () => {
                attempt.checkpoint()
            },
            reserve: (wait) => attempt.reserve(wait),
            preparing: (work) => attempt.preparing(work),
            ready: (action, size) => attempt.ready(action, size),
            complete: (entry, unit) => attempt.complete(entry, unit),
            download: ({ suggestedName, blob }) =>
                attempt.write({
                    kind: 'nxsp',
                    suggestedName,
                    build: () => Promise.resolve({ kind: 'blob', blob }),
                }),
            pick: async (picker, suggestedName, inLock, size = 0) => {
                const open = platform.pickSaveFile
                if (!open) throw new FileError('io', 'There is no save picker')
                await settle()
                attempt.checkpoint()
                // Loaded here: nothing loads inside the hold.
                if (!saving) await levelBuilder().catch(() => undefined)
                // A press just answered is an activation: it is asked for once, and again only
                // after another wait.
                let pressed = false
                for (;;) {
                    attempt.checkpoint()
                    // An import this tab runs, or a copy it keeps, would be cut short by a file
                    // emptied under it: waited for, and the checks run again.
                    if (importsRunning() || copiesRunning()) {
                        await quiet()
                        pressed = false
                        continue
                    }
                    // A wait that outlasted the press asks for a new one.
                    if (!spec.target && !pressed && lapsed()) {
                        if (!(await attempt.ready('save', size))) throw new Cancelled()
                        startedAt = performance.now()
                        pressed = true
                        continue
                    }
                    break
                }
                // The activation check was the last step: only microtasks until the picker opens.
                attempt.closePreparing()
                const target = spec.target ?? (await open({ suggestedName, picker }))
                if (target?.kind !== 'handle') return { kind: 'dismissed' }
                // The commit point: no Cancel has any effect from here.
                attempt.commit()
                spec.committed?.(target)
                await savePoint('picked')
                const result = await hold(target, inLock)
                return result
            },
        }

        return body(session)
    })
}
