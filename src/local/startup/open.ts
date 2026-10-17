import { restoreExportMemory } from '../../editor/commands/exportLevel/memory'
import { setVerticalScale } from '../../editor/navigation'
import { view } from '../../editor/view'
import { openStoredState } from '../../history'
import { createSessionDescriptor } from '../../history/session'
import type { RestoredSlot } from '../../history/stack'
import type { JournalFound, LockService } from '../../platform/types'
import type { State } from '../../state'
import type { FlushSession, StoredStack } from '../flush'
import { toHex } from '../hash'
import { hasWebLocks, sessionLock } from '../locks'
import { displayName, forkNameOf, namePartsOf } from '../names'
import { stateFromRecords } from '../records/records'
import { decodeSnapshot } from '../records/snapshot'
import type { HeldLock, TabClient } from '../sessions'
import type { StorageWorker } from '../worker/client'
import type { StorageStatus } from '../worker/core'
import type { LoadEvent, ShownName } from './events'
import { journalledSession } from './resume'
import { blankRequested, openingName, startsBlankForTests } from './state'
import type { SessionRead } from './stored'
import {
    claimSessionLock,
    MARKER_WAIT_MS,
    readMarker,
    readTabRecord,
    writeTabRecord,
    type TabRecord,
} from './tab'

// Which session a load opens (Part 1 §1.4.2), once the recovery order has run. A same-tab reload
// keeps its session, decided by the session lock; a Duplicate Tab forks; a new visit continues
// the most recent session, or starts blank when it's open in another tab, or forks when only its
// file is bound in another tab; a first visit starts blank.

/** What the tab found of its own session before the recovery order. */
export type Claim =
    /** Its session's lock was free (or came free): a reload, holding the lock now. */
    | { kind: 'reload'; record: TabRecord; lock: HeldLock }
    /** Another tab holds it: a Duplicate Tab (or a closed tab reopened while it's still held). */
    | { kind: 'duplicate'; record: TabRecord }
    | { kind: 'none' }

/** A lock held nowhere else: where there are no Web Locks, there's no other tab to keep out. */
const noLock = (sessionId: string): HeldLock => ({
    name: sessionLock(sessionId),
    granted: Promise.resolve(),
    release: () => undefined,
})

/**
 * Decides reload or Duplicate Tab by the session lock (Y2), before the recovery order, so this
 * tab's own journal is replayed under the lock it now holds. With the marker, a blocking request
 * of about 2 s lets the unloading page's late flush land first (§1.6.6).
 */
export const claimTab = async (locks: LockService): Promise<Claim> => {
    const record = readTabRecord()
    if (!record) return { kind: 'none' }
    if (!hasWebLocks()) return { kind: 'reload', record, lock: noLock(record.sessionId) }
    const marked = readMarker() === record.sessionId
    const lock = await claimSessionLock(locks, record.sessionId, marked ? MARKER_WAIT_MS : 0)
    return lock ? { kind: 'reload', record, lock } : { kind: 'duplicate', record }
}

/** What opening a session needs of the storing side (`storing.ts`). */
export type OpenDeps = {
    worker: StorageWorker
    status: StorageStatus
    locks: LockService
    client: TabClient
    safe: boolean
    /** The session the migration made at this load, if any. */
    migrated?: string
    /** This tab's own journal while storage is unavailable. */
    ownJournal?: JournalFound
    flusher: () => import('../flush').Flusher | undefined
    newId?: () => string
    labels: { continued: () => string; recoveredHead: () => string }
    events: (event: LoadEvent) => void
}

const shownOf = (read: SessionRead & { kind: 'open' }, state: State): ShownName => ({
    name: displayName(namePartsOf(read.chain, state)),
    at: typeof read.session.startedAt === 'number' ? read.session.startedAt : Date.now(),
})

const headState = async (worker: StorageWorker, head: Uint8Array) => {
    const parts = await worker.call('readSnapshot', toHex(head))
    if (parts.root === undefined) throw new Error(`The head ${toHex(head)} is not stored`)
    return stateFromRecords(
        decodeSnapshot(parts.root, {
            node: (hex) => parts.nodes[hex],
            chunk: (hex) => parts.chunks[hex],
        }),
    )
}

const storedStack = (read: SessionRead & { kind: 'open' }): StoredStack => ({
    first: read.stack.window.base,
    slots: read.stack.slots.map(({ snapshot, label }) => ({ hash: snapshot, label })),
    index: read.stack.window.index,
})

/** The view as the session last left it (§1.6.11.2's `view`). */
const restoreView = (stored: unknown, state: State) => {
    if (typeof stored !== 'object' || stored === null) return
    const { scroll, zoom, group, stage } = stored as Record<string, unknown>
    if (typeof scroll === 'number' && Number.isFinite(scroll)) view.time = Math.max(0, scroll)
    if (typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0) setVerticalScale(zoom)
    if (typeof group === 'number' && state.groups.has(group as never)) view.groupId = group as never
    if (typeof stage === 'number' && state.stages.has(stage as never)) view.stageId = stage as never
}

/** How a stored session opens: taken up again, continued in its chain, or as a fork. */
type How =
    | { mode: 'resume'; lock: HeldLock }
    | { mode: 'continue'; parentLock: HeldLock }
    | { mode: 'fork'; parentLock?: HeldLock; copyOf: { name: string; bound: boolean } }

/**
 * Opens a stored session in this tab: its stack restored with the head loaded, and the storing
 * side's session started. Resolves the head's state, or undefined when Start Blank was pressed
 * while it loaded.
 */
export const openStored = async (
    deps: OpenDeps,
    read: SessionRead & { kind: 'open' },
    how: How,
): Promise<State | undefined> => {
    const flusher = deps.flusher()
    const releaseAll = () => {
        if (how.mode === 'resume') how.lock.release()
        else how.parentLock?.release()
    }
    if (!flusher) {
        releaseAll()
        return
    }
    const state = await headState(deps.worker, read.head)
    if (blankRequested) {
        releaseAll()
        return
    }
    const { session, chain } = read
    const newId = deps.newId ?? (() => crypto.randomUUID())
    const edited = chain.edited === true
    const slots: RestoredSlot[] = read.stack.slots.map(({ snapshot, label }) => ({
        snapshot,
        label,
        isDirty: edited,
    }))
    const at = read.stack.window.index - read.stack.window.base
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
    const sourceName = text(chain.sourceName)
    const lineageId = text(chain.lineageId) ?? newId()
    const id = how.mode === 'resume' ? String(session.id) : newId()
    const fork = how.mode === 'fork'
    const forkName = fork ? forkNameOf(namePartsOf(chain, state)) : undefined
    const docId = fork ? newId() : (text(chain.docId) ?? newId())
    const name = fork ? forkName : text(chain.name)
    openStoredState(
        createSessionDescriptor({
            sessionId: id,
            docId,
            ...(name === undefined ? {} : { name }),
            ...(sourceName === undefined ? {} : { sourceName }),
            ...(how.mode === 'fork' ? { copyOf: how.copyOf } : {}),
        }),
        slots,
        at,
        state,
    )
    if (how.mode === 'resume') {
        flusher.resumeSession({
            id,
            chainId: String(chain.chainId),
            docId,
            lineageId,
            origin: (text(session.origin) ?? 'new') as FlushSession['origin'],
            startedAt: typeof session.startedAt === 'number' ? session.startedAt : Date.now(),
            ...(isParent(session.parent) ? { parent: session.parent } : {}),
            ...(sourceName === undefined ? {} : { sourceName }),
            lastSeq: typeof session.lastSeq === 'number' ? session.lastSeq : 0,
            chain,
            stack: {
                ...storedStack(read),
                window: read.stack.window,
                blocks: read.stack.blocks,
                at: read.at,
            },
            ready: Promise.resolve(),
            done: how.lock.release,
        })
    } else {
        const own = holdOwn(deps.locks, id)
        flusher.continueSession({
            id,
            chainId: fork ? newId() : String(chain.chainId),
            docId,
            lineageId,
            ...(sourceName === undefined ? {} : { sourceName }),
            parent: {
                id: String(session.id),
                uptoSeq: typeof session.lastSeq === 'number' ? session.lastSeq : 0,
            },
            stack: storedStack(read),
            chain,
            label: deps.labels.continued,
            dirty: edited,
            ...(fork
                ? { fork: { forkOf: String(chain.chainId), ...(forkName ? { forkName } : {}) } }
                : {}),
            ready: own.granted.catch(() => undefined),
            done: own.release,
            ...(how.parentLock ? { parentDone: how.parentLock.release } : {}),
        })
    }
    // Export's target and name are the chain's; a fork keeps only the partial flag (§1.4.8).
    restoreExportMemory(fork ? { partial: chain.partial } : chain)
    restoreView(session.view, state)
    writeTabRecord({
        sessionId: id,
        start: how.mode === 'resume' ? 'stored' : 'continuation',
        ...(how.mode === 'resume' ? {} : { parent: String(session.id) }),
        ...(how.mode === 'fork' ? { copyOf: how.copyOf } : {}),
    })
    if (state.bgm.meta && !state.bgm.buffer) deps.events({ kind: 'bgmNotLoaded' })
    return state
}

const isParent = (value: unknown): value is { id: string; uptoSeq: number } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { uptoSeq?: unknown }).uptoSeq === 'number'

/** This tab's lock on a session it starts, held while it might write it (§1.6.6). */
const holdOwn = (locks: LockService, sessionId: string): HeldLock => {
    if (!hasWebLocks()) return noLock(sessionId)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let grant!: () => void
    const granted = new Promise<void>((resolve) => {
        grant = resolve
    })
    const request = locks.request(sessionLock(sessionId), {}, async () => {
        grant()
        await held
    })
    return { name: sessionLock(sessionId), granted: Promise.race([granted, request]), release }
}

/** A shared hold on a session, as an unstored continuation keeps its parent (§1.3.6). */
const holdShared = async (locks: LockService, sessionId: string): Promise<HeldLock | undefined> => {
    if (!hasWebLocks()) return noLock(sessionId)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    return new Promise<HeldLock | undefined>((resolve) => {
        locks
            .request(
                sessionLock(sessionId),
                { mode: 'shared', ifAvailable: true },
                async (granted) => {
                    if (!granted) {
                        resolve(undefined)
                        return
                    }
                    resolve({ name: sessionLock(sessionId), granted: Promise.resolve(), release })
                    await held
                },
            )
            .catch(() => {
                resolve(undefined)
            })
    })
}

/** The file a session's chain is bound to, as its status label names it. */
const copyOfOf = (read: SessionRead & { kind: 'open' }, state?: State) => {
    const file = read.chain.file as { name?: unknown } | undefined
    if (typeof file?.name === 'string' && file.name) return { name: file.name, bound: true }
    const shown = displayName(namePartsOf(read.chain, state))
    return { name: shown.kind === 'date' ? '' : shown.text, bound: false }
}

/** Whether another tab's open session is bound to this chain's file (§1.3.2, `isSameEntry`). */
const boundElsewhere = async (deps: OpenDeps, read: SessionRead & { kind: 'open' }) => {
    const handle = (read.chain.file as { handle?: FileSystemFileHandle } | undefined)?.handle
    if (!handle || !hasWebLocks()) return false
    try {
        const own = await deps.client.id()
        const snapshot = await deps.locks.query()
        const others = snapshot.held
            .filter((lock) => lock.name.startsWith('nse-session:'))
            .filter((lock) => own === undefined || lock.clientId !== own)
            .map((lock) => lock.name.slice('nse-session:'.length))
            .filter((id) => id !== read.session.id)
        if (!others.length) return false
        const bindings = await deps.worker.call('readBindings', others)
        for (const { chainId, file } of bindings) {
            if (chainId === read.chain.chainId) continue
            const other = file.handle as FileSystemFileHandle | undefined
            if (other && (await other.isSameEntry(handle).catch(() => false))) return true
        }
    } catch {
        // Where the browser can't tell, the session continues; Save's own check guards the file.
    }
    return false
}

/** The new-visit rule (§1.4.2): continue the most recent session, or start blank, or fork. */
const newVisit = async (deps: OpenDeps): Promise<boolean> => {
    const read = await deps.worker.call('readNewestSession')
    if (!read || blankRequested) return false
    const name = displayName(namePartsOf(read.chain))
    if (name.kind !== 'date') openingName(name.text)
    const headId = String(read.session.id)
    if (hasWebLocks() && (await deps.client.heldElsewhere(sessionLock(headId)))) {
        const state = await headState(deps.worker, read.head)
        deps.events({ kind: 'openElsewhere', name: shownOf(read, state), sessionId: headId })
        return false
    }
    if (await boundElsewhere(deps, read)) return forked(deps, read, headId)
    const parentLock = await holdShared(deps.locks, headId)
    if (!parentLock) {
        const state = await headState(deps.worker, read.head)
        deps.events({ kind: 'openElsewhere', name: shownOf(read, state), sessionId: headId })
        return false
    }
    const state = await openStored(deps, read, { mode: 'continue', parentLock })
    // The migrated auto save's own line says it already (§1.4.3).
    if (state && deps.migrated !== headId)
        deps.events({
            kind: 'continued',
            name: shownOf(read, state),
            from: typeof read.session.updatedAt === 'number' ? read.session.updatedAt : 0,
        })
    return !!state
}

/** Opens a separate copy of a stored session, with its opening notice (§1.3.1). */
const forked = async (
    deps: OpenDeps,
    read: SessionRead & { kind: 'open' },
    parentId: string,
    held?: HeldLock,
    copyOf = copyOfOf(read),
): Promise<boolean> => {
    const parentLock = held ?? (await holdShared(deps.locks, parentId))
    const state = await openStored(deps, read, {
        mode: 'fork',
        ...(parentLock ? { parentLock } : {}),
        copyOf,
    })
    if (state) deps.events({ kind: 'separateCopy', of: copyOf })
    return !!state
}

/** A reload while storage is unavailable continues from its own journal (§1.6.7). */
const resumeFromJournal = (deps: OpenDeps, found: JournalFound, lock: HeldLock): boolean => {
    const flusher = deps.flusher()
    const journalled = journalledSession(found)
    if (!flusher || !journalled) return false
    const { name, sourceName, label, state, chain } = journalled
    openStoredState(
        createSessionDescriptor({
            sessionId: journalled.id,
            docId: journalled.docId,
            ...(name === undefined ? {} : { name }),
            ...(sourceName === undefined ? {} : { sourceName }),
        }),
        [{ label, isDirty: true }],
        0,
        state,
    )
    flusher.resumeJournalled({
        ...journalled,
        label: () => label || deps.labels.recoveredHead(),
        ready: Promise.resolve(),
        done: lock.release,
    })
    restoreExportMemory({ partial: chain.partial })
    writeTabRecord({ sessionId: journalled.id, start: 'stored' })
    return true
}

/** Opens the session this load continues; true when one opened, false for a blank start. */
export const openAtStart = async (deps: OpenDeps, claim: Claim): Promise<boolean> => {
    const releaseClaim = () => {
        if (claim.kind === 'reload') claim.lock.release()
    }
    // The fixture hook, Start Blank and safe mode open blank (§1.4.2).
    if (startsBlankForTests() || blankRequested || deps.safe) {
        releaseClaim()
        return false
    }
    // A newer database opens nothing to continue: this build can't store into it.
    if (deps.status.mode === 'readOnly') {
        releaseClaim()
        return false
    }
    if (deps.status.mode === 'memory') {
        if (claim.kind === 'reload' && deps.ownJournal)
            if (resumeFromJournal(deps, deps.ownJournal, claim.lock)) return true
        // Not loaded: a new session id, and the key stays in Local Data (§1.4.2).
        releaseClaim()
        return false
    }
    if (claim.kind === 'none') return newVisit(deps)
    const { record } = claim
    const read = await deps.worker.call('readSession', record.sessionId)
    if (claim.kind === 'reload') {
        if (read.kind === 'open' && read.isHead)
            return !!(await openStored(deps, read, { mode: 'resume', lock: claim.lock }))
        // Continued in another tab during the gap: a fork (§1.4.2).
        if (read.kind === 'open') return forked(deps, read, record.sessionId, claim.lock)
        releaseClaim()
        if (read.kind === 'deleted') {
            deps.events({ kind: 'deletedElsewhere' })
            return false
        }
        if (read.kind !== 'missing') return false
        // Never stored: a blank start reloads by the new-visit rule, an unstored continuation
        // continues its parent again, and a New reloads as blank.
        if (record.start === 'blank') return newVisit(deps)
        if (record.start === 'continuation' && record.parent) {
            const parent = await deps.worker.call('readSession', record.parent)
            if (parent.kind !== 'open') return false
            const parentLock = await holdShared(deps.locks, record.parent)
            if (parentLock && parent.isHead && !record.copyOf)
                return !!(await openStored(deps, parent, { mode: 'continue', parentLock }))
            return forked(deps, parent, record.parent, parentLock, record.copyOf)
        }
        return false
    }
    // A Duplicate Tab: a fork without the binding (§1.4.2).
    if (read.kind === 'open') return forked(deps, read, record.sessionId)
    if (record.start === 'blank') return newVisit(deps)
    return false
}
