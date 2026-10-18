import { restoreExportMemory } from '../../editor/commands/exportLevel/memory'
import { createSessionDescriptor, type SessionDescriptor } from '../../history/session'
import type { RestoredSlot } from '../../history/stack'
import type { JournalFound, JournalStore, LockService } from '../../platform/types'
import { setOpeningName } from '../../startup/gate'
import type { State } from '../../state'
import type { FlushSession, StoredStack } from '../flush'
import { handleOf } from '../handles'
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
import { isBlankRequested, startsBlankForTests } from './state'
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
    const marked = readMarker() === record.sessionId
    // Without Web Locks only the marker tells: the page went away, so this is its reload. A
    // copy from a live tab (or a crash) leaves its journal to Local Data, never shared (§1.6.7).
    if (!hasWebLocks())
        return marked
            ? { kind: 'reload', record, lock: noLock(record.sessionId) }
            : { kind: 'duplicate', record }
    const lock = await claimSessionLock(locks, record.sessionId, marked ? MARKER_WAIT_MS : 0)
    return lock ? { kind: 'reload', record, lock } : { kind: 'duplicate', record }
}

/** What an opened session shows: its descriptor, its stack with the head loaded, its view. */
export type Shown = {
    descriptor: SessionDescriptor
    slots: RestoredSlot[]
    at: number
    state: State
    /** §1.6.11.2's `view`, as the session last left it. */
    view?: unknown
    /** The stored stack starts after the session's first slot: earlier steps are in History. */
    earlier?: true
}

/** What opening a session needs of the storing side (`storing.ts`). */
export type OpenDeps = {
    worker: Pick<StorageWorker, 'call'>
    status: StorageStatus
    locks: LockService
    client: Pick<TabClient, 'id' | 'heldElsewhere'>
    safe: boolean
    /** The page's journal store: a journal the reload loads becomes the page's to write. */
    journal?: Pick<JournalStore, 'adopt' | 'remove'>
    /** The session the migration made at this load, if any, and its name. */
    migrated?: { sessionId: string; name: ShownName }
    /** This tab's own journal while storage is unavailable. */
    ownJournal?: JournalFound
    /** Its own journal is still there after replay: never appended to (§1.6.4 step 2). */
    ownLeft?: boolean
    /** Its apply failed: said at load unless the reload shows that work. */
    ownFailed?: boolean
    /** The recovery session its own journal was kept as (§1.6.4 step 3). */
    ownRecovery?: string
    /** Journals offered in Local Data: the reload's own goes there when it can't load it. */
    keptForLocalData?: JournalFound[]
    flusher: () => import('../flush').Flusher | undefined
    /** A journal whose work a new session took over: the key goes once that session holds it. */
    retireJournal?: (found: JournalFound, by: string, seq: number, dropped?: () => void) => void
    /** Shows an opened session in the editor (`show.ts`): the stack, the head, the view. */
    show: (shown: Shown) => void
    /** A session this tab left by Reopen or Restore as a Copy, for Reopen to offer (§1.4.1). */
    onLeft?: (leaving: import('../flush').FlushSession, outgoing: Promise<boolean>) => void
    /** Shows a state as a new session (`show.ts`), as Local Data's Open does. */
    showState: (state: State, names: { name?: string; sourceName?: string }) => void
    /** Whether the tab still shows its own blank start, never edited or replaced. */
    untouched: () => boolean
    newId?: () => string
    labels: { continued: () => string; recoveredHead: () => string }
    events: (event: LoadEvent) => void
}

/** The chain's file binding for the status label (§1.3.2). */
const boundFileOf = (chain: Record<string, unknown>) => {
    const file = chain.file as Record<string, unknown> | undefined
    if (typeof file?.name !== 'string') return
    return {
        name: file.name,
        ...(typeof file.event === 'string' ? { event: file.event } : {}),
        ...(typeof file.at === 'number' ? { at: file.at } : {}),
    }
}

const shownOf = (read: SessionRead & { kind: 'open' }, state: State): ShownName => ({
    name: displayName(namePartsOf(read.chain, state)),
    at: typeof read.session.startedAt === 'number' ? read.session.startedAt : Date.now(),
})

const headState = async (worker: OpenDeps['worker'], head: Uint8Array) => {
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
    {
        replace = false,
        recovered,
    }: {
        /** An action of the user's (Reopen, Restore as a Copy): it replaces what's open. */
        replace?: boolean
        /**
         * A journal of the session that couldn't be applied but reads: a continuation or fork
         * starts from its state, an entry over the stored stack, so the newest work is on screen
         * and stored by its first write (§1.6.4).
         */
        recovered?: { found: JournalFound; state: State }
    } = {},
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
    // Start Blank, or a chart made meanwhile, keeps what's on screen.
    if (!replace && (isBlankRequested() || !deps.untouched())) {
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
    let at = read.stack.window.index - read.stack.window.base
    const taken = how.mode === 'resume' ? undefined : recovered
    if (taken) {
        slots.length = at + 1
        slots.push({ label: deps.labels.recoveredHead(), isDirty: true })
        at++
    }
    const shown = taken?.state ?? state
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
    const sourceName = text(chain.sourceName)
    const lineageId = text(chain.lineageId) ?? newId()
    const id = how.mode === 'resume' ? String(session.id) : newId()
    const fork = how.mode === 'fork'
    const forkName = fork ? forkNameOf(namePartsOf(chain, state)) : undefined
    const boundFile = boundFileOf(chain)
    const docId = fork ? newId() : (text(chain.docId) ?? newId())
    const name = fork ? forkName : text(chain.name)
    deps.show({
        descriptor: createSessionDescriptor({
            sessionId: id,
            docId,
            ...(name === undefined ? {} : { name }),
            ...(sourceName === undefined ? {} : { sourceName }),
            ...(how.mode === 'fork' ? { copyOf: how.copyOf } : {}),
            ...(typeof session.startedAt === 'number' ? { startedAt: session.startedAt } : {}),
            ...(boundFile && how.mode !== 'fork' ? { file: boundFile } : {}),
        }),
        slots,
        at,
        state: shown,
        view: session.view,
        ...(read.stack.window.base > 0 ? { earlier: true as const } : {}),
    })
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
        const continued = flusher.continueSession({
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
            // Starting from a journal, the parent stays held until its key goes, so no other
            // load keeps that key as a second copy meanwhile.
            done: taken
                ? () => {
                      own.release()
                      how.parentLock?.release()
                  }
                : own.release,
            ...(how.parentLock && !taken ? { parentDone: how.parentLock.release } : {}),
        })
        if (taken) {
            flusher.append('edit', deps.labels.recoveredHead, taken.state, true)
            deps.retireJournal?.(
                taken.found,
                continued.id,
                flusher.newestSeq(continued),
                how.parentLock?.release,
            )
        }
    }
    // Export's target and name are the chain's; a fork keeps only the partial flag (§1.4.8).
    restoreExportMemory(fork ? { partialImport: chain.partialImport } : chain)
    writeTabRecord({
        sessionId: id,
        start: how.mode === 'resume' ? 'stored' : 'continuation',
        ...(how.mode === 'resume' ? {} : { parent: String(session.id) }),
        ...(how.mode === 'fork' ? { copyOf: how.copyOf } : {}),
    })
    if (shown.bgm.meta && !shown.bgm.buffer) deps.events({ kind: 'bgmNotLoaded' })
    return shown
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
export const holdShared = async (
    locks: LockService,
    sessionId: string,
): Promise<HeldLock | undefined> => {
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
    const handle = handleOf((read.chain.file as { handle?: unknown } | undefined)?.handle)
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
            const other = handleOf(file.handle)
            if (other && (await other.isSameEntry(handle).catch(() => false))) return true
        }
    } catch {
        // Where the browser can't tell, the session continues; Save's own check guards the file.
    }
    return false
}

/** The new-visit rule (§1.4.2): continue the most recent session, or start blank, or fork. */
const newVisit = async (deps: OpenDeps): Promise<boolean> => {
    const { read, skipped } = await deps.worker.call('readNewestSession')
    // A newer chain this build can't open is passed over, never silently (§1.4.3).
    if (skipped) deps.events({ kind: 'notOpened', which: 'newest', why: skipped })
    if (!read || isBlankRequested()) return false
    const name = displayName(namePartsOf(read.chain))
    if (name.kind !== 'date') setOpeningName(name.text)
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
    if (state && deps.migrated?.sessionId !== headId)
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
    recovered?: { found: JournalFound; state: State },
): Promise<boolean> => {
    const parentLock = held ?? (await holdShared(deps.locks, parentId))
    const state = await openStored(
        deps,
        read,
        { mode: 'fork', ...(parentLock ? { parentLock } : {}), copyOf },
        recovered ? { recovered } : {},
    )
    if (state) deps.events({ kind: 'separateCopy', of: copyOf })
    return !!state
}

/** A reload while storage is unavailable continues from its own journal (§1.6.7). */
const resumeFromJournal = (deps: OpenDeps, found: JournalFound, lock: HeldLock): boolean => {
    const flusher = deps.flusher()
    const journalled = journalledSession(found)
    if (!flusher || !journalled) return false
    const { name, sourceName, label, state, chain } = journalled
    // Without Web Locks a copied tab can't be told from a reload, so the work goes on under a
    // new session id and its own key; the old key stays, offered in Local Data, since the tab it
    // came from may still be writing it (§1.6.7). With them, the page goes on writing this key,
    // which it loaded, and no other.
    const copy = !hasWebLocks()
    const id = copy ? (deps.newId ?? (() => crypto.randomUUID()))() : journalled.id
    if (!copy) deps.journal?.adopt(found)
    else if (!deps.keptForLocalData?.includes(found)) deps.keptForLocalData?.push(found)
    deps.show({
        descriptor: createSessionDescriptor({
            sessionId: id,
            docId: journalled.docId,
            ...(name === undefined ? {} : { name }),
            ...(sourceName === undefined ? {} : { sourceName }),
        }),
        slots: [{ label, isDirty: true }],
        at: 0,
        state,
    })
    flusher.resumeJournalled({
        ...journalled,
        id,
        label: () => label || deps.labels.recoveredHead(),
        ready: Promise.resolve(),
        done: lock.release,
    })
    restoreExportMemory({ partialImport: chain.partialImport })
    writeTabRecord({ sessionId: id, start: 'stored' })
    return true
}

/** Takes a journal out of Local Data's list: it's shown, or gone. */
const unlist = (deps: OpenDeps, found: JournalFound) => {
    const at = deps.keptForLocalData?.indexOf(found) ?? -1
    if (at !== -1) deps.keptForLocalData?.splice(at, 1)
}

/**
 * A same-tab reload's session, by its row (§1.4.2). Its own journal left by replay (§1.6.4 step
 * 2) is never appended to: the session continues in a new one. One that reads and is newer than
 * the stored session starts from the journal's state, as the user left it; one a flush covered
 * goes, as the apply would have found it (step 3). Says what became of that journal.
 */
const reloadOwn = async (
    deps: OpenDeps,
    claim: Claim & { kind: 'reload' },
    read: SessionRead,
    releaseClaim: () => void,
): Promise<{ opened: boolean; journal: 'none' | 'left' | 'shown' | 'covered' }> => {
    const { record } = claim
    const own = deps.ownLeft ? deps.ownJournal : undefined
    const journalled = own ? journalledSession(own) : undefined
    let recovered = own && journalled ? { found: own, state: journalled.state } : undefined
    let journal: 'none' | 'left' | 'shown' | 'covered' = own ? 'left' : 'none'
    const lastSeq =
        read.kind === 'open' && typeof read.session.lastSeq === 'number' ? read.session.lastSeq : 0
    if (own && journalled && read.kind === 'open' && journalled.seq <= lastSeq) {
        deps.journal?.remove(own)
        unlist(deps, own)
        recovered = undefined
        journal = 'covered'
    }
    // Shown: its key goes once the new session holds it, so Local Data doesn't offer it.
    const said = async (opening: Promise<State | undefined | boolean>) => {
        const opened = !!(await opening)
        if (opened && recovered && journalled) {
            journal = 'shown'
            unlist(deps, recovered.found)
            deps.events({
                kind: 'journalRecovered',
                name: {
                    name: displayName(namePartsOf(journalled.chain, journalled.state)),
                    at: journalled.startedAt,
                },
                sessionId: deps.flusher()?.session?.id ?? record.sessionId,
            })
        }
        return { opened, journal }
    }
    const taking = recovered ? { recovered } : {}
    if (read.kind === 'open' && read.isHead) {
        if (journal === 'left')
            return said(
                openStored(deps, read, { mode: 'continue', parentLock: claim.lock }, taking),
            )
        const opened = !!(await openStored(deps, read, { mode: 'resume', lock: claim.lock }))
        return { opened, journal }
    }
    // Continued in another tab during the gap: a fork (§1.4.2).
    if (read.kind === 'open')
        return said(forked(deps, read, record.sessionId, claim.lock, undefined, recovered))
    releaseClaim()
    if (read.kind === 'deleted') {
        deps.events({ kind: 'deletedElsewhere' })
        return { opened: false, journal }
    }
    if (read.kind === 'later' || read.kind === 'damaged') {
        deps.events({ kind: 'notOpened', which: 'reload', why: read.kind })
        return { opened: false, journal }
    }
    // Never stored: an unstored continuation continues its parent again, from its journal's
    // state when there is one; a blank start or a New with a journal opens that work in a new
    // session; without one, a blank start reloads by the new-visit rule, and a New as blank.
    if (record.start === 'continuation' && record.parent) {
        const parent = await deps.worker.call('readSession', record.parent)
        if (parent.kind !== 'open') return { opened: false, journal }
        const parentLock = await holdShared(deps.locks, record.parent)
        if (parentLock && parent.isHead && !record.copyOf)
            return said(openStored(deps, parent, { mode: 'continue', parentLock }, taking))
        return said(forked(deps, parent, record.parent, parentLock, record.copyOf, recovered))
    }
    if (recovered && journalled) {
        const flusher = deps.flusher()
        deps.showState(recovered.state, {
            ...(journalled.name === undefined ? {} : { name: journalled.name }),
            ...(journalled.sourceName === undefined ? {} : { sourceName: journalled.sourceName }),
        })
        const session = flusher?.session
        if (session) deps.retireJournal?.(recovered.found, session.id, flusher.newestSeq(session))
        return said(Promise.resolve(true))
    }
    if (record.start === 'blank') return { opened: await newVisit(deps), journal }
    return { opened: false, journal }
}

/** The stored session that opened: the one resumed, or the one continued. */
export const openedFrom = (deps: Pick<OpenDeps, 'flusher'>) => {
    const session = deps.flusher()?.session
    if (!session || session.forkOf !== undefined) return
    return session.continuation ? session.parent?.id : session.id
}

/**
 * Opens the session this load continues; true when one opened, false for a blank start. The
 * migrated auto save's line follows, saying whether it's what opened (§1.4.3).
 */
export const openAtStart = async (deps: OpenDeps, claim: Claim): Promise<boolean> => {
    const opened = await openSessionAtStart(deps, claim)
    if (deps.migrated)
        deps.events({
            kind: 'migrated',
            ...deps.migrated,
            opened: opened && openedFrom(deps) === deps.migrated.sessionId,
        })
    return opened
}

const openSessionAtStart = async (deps: OpenDeps, claim: Claim): Promise<boolean> => {
    const releaseClaim = () => {
        if (claim.kind === 'reload') claim.lock.release()
    }
    // The fixture hook, Start Blank and safe mode open blank (§1.4.2).
    if (startsBlankForTests() || isBlankRequested() || deps.safe || !deps.untouched()) {
        releaseClaim()
        return false
    }
    // Storage unavailable, or a newer database this build can't store into (§1.6.7).
    if (deps.status.mode !== 'stored') {
        const own = deps.ownJournal
        if (claim.kind === 'reload' && own) {
            if (resumeFromJournal(deps, own, claim.lock)) return true
            // Not loaded: a new session id, and the key stays in Local Data (§1.4.2).
            if (!deps.keptForLocalData?.includes(own)) deps.keptForLocalData?.push(own)
            deps.events({ kind: 'unsavedInLocalData' })
        }
        releaseClaim()
        return false
    }
    if (claim.kind === 'none') return newVisit(deps)
    const { record } = claim
    if (claim.kind === 'reload') {
        // Its own journal was kept as a recovery session, which holds its last edits (§1.6.4).
        if (deps.ownRecovery !== undefined) {
            const recovered = await deps.worker.call('readSession', deps.ownRecovery)
            const own = await deps.worker.call('readSession', record.sessionId)
            if (own.kind === 'deleted') deps.events({ kind: 'deletedElsewhere' })
            releaseClaim()
            if (recovered.kind !== 'open') return false
            const parentLock = await holdShared(deps.locks, deps.ownRecovery)
            if (parentLock && recovered.isHead)
                return !!(await openStored(deps, recovered, { mode: 'continue', parentLock }))
            return forked(deps, recovered, deps.ownRecovery, parentLock)
        }
        const read = await deps.worker.call('readSession', record.sessionId)
        const result = await reloadOwn(deps, claim, read, releaseClaim)
        // A failed own journal the reload couldn't show stays in Local Data, and says so.
        if (deps.ownFailed && result.journal === 'left') deps.events({ kind: 'journalFailed' })
        return result.opened
    }
    // A Duplicate Tab: a fork without the binding (§1.4.2); of an unstored continuation, a fork
    // of what it continued.
    const read = await deps.worker.call('readSession', record.sessionId)
    if (read.kind === 'open') return forked(deps, read, record.sessionId)
    if (read.kind !== 'missing') return false
    if (record.start === 'blank') return newVisit(deps)
    if (record.start === 'continuation' && record.parent) {
        const parent = await deps.worker.call('readSession', record.parent)
        if (parent.kind === 'open') return forked(deps, parent, record.parent)
    }
    return false
}
