import { shallowRef } from 'vue'
import { openState } from '../../history'
import { storageKey } from '../../storage'
import { journalState } from '../journal/content'
import { readJournal } from '../journal/format'
import { sessionLock } from '../locks'
import type { DisplayName } from '../names'
import type { ShownName } from './events'
import {
    AUTO_SAVE_KEY,
    AUTO_SAVE_UNREADABLE_KEY,
    LEGACY_RECOVERY_KEY,
    toRecoveryFile,
} from './legacy'
import { holdShared, openStored, type OpenDeps } from './open'
import { replaySessionJournal, type RecoveryContext } from './steps'
import { claimSessionLock } from './tab'

// What the UI acts on after startup (Part 1 §1.4.1, §1.4.14): Reopen after leaving a session,
// Restore as a Copy from a load notice, and Settings › Local Data › Recovery's rows with their
// Open, Download and Discard…. Page-only: it drives the open session and the storage worker.

/** The session left last in this tab by New, an open or a restore, while it can be reopened. */
export const previousSession = shallowRef<{ sessionId: string; name: ShownName } | undefined>()

let context: { open: OpenDeps; recovery: RecoveryContext } | undefined

/** Set by startup once the recovery order has run. */
export const setSessionContext = (open: OpenDeps, recovery: RecoveryContext) => {
    context = { open, recovery }
}

/** Notes the session a switch left: Reopen offers it while it's stored (§1.4.1). */
export const leftSession = (
    sessionId: string,
    name: DisplayName,
    at: number,
    stored: Promise<boolean>,
) => {
    const left = { sessionId, name: { name, at } }
    previousSession.value = left
    void stored.then((ok) => {
        // Not durably stored (Leave Anyway): there's nothing to reopen.
        if (!ok && previousSession.value === left) previousSession.value = undefined
    })
}

/**
 * Opens a stored session in this tab, replacing what's open: its pending journal applied first
 * under its lock (§1.6.4, between loads), then a continuation, or a fork when it isn't its
 * chain's latest session or is open in another tab. False when it can't be opened.
 */
const openSession = async (sessionId: string, asCopy: boolean) => {
    if (!context) return false
    const { open, recovery } = context
    // Its own tab let it go once its strict commit landed.
    await open.flusher()?.outgoing
    const lock = await claimSessionLock(open.locks, sessionId)
    if (lock)
        try {
            await replaySessionJournal(recovery, sessionId)
        } finally {
            lock.release()
        }
    const read = await open.worker.call('readSession', sessionId)
    if (read.kind !== 'open') return false
    const elsewhere = await open.client.heldElsewhere(sessionLock(sessionId))
    const fork = asCopy || elsewhere || !read.isHead
    const file = read.chain.file as { name?: unknown } | undefined
    const copyOf =
        typeof file?.name === 'string'
            ? { name: file.name, bound: true }
            : { name: typeof read.chain.name === 'string' ? read.chain.name : '', bound: false }
    const parentLock = await holdShared(open.locks, sessionId)
    const state = await openStored(
        open,
        read,
        fork || !parentLock
            ? { mode: 'fork', ...(parentLock ? { parentLock } : {}), copyOf }
            : { mode: 'continue', parentLock },
        { replace: true },
    )
    return !!state
}

/** Reopen (§1.4.1): continues the session this tab left last. */
export const reopen = async () => {
    const left = previousSession.value
    if (!left) return false
    const opened = await openSession(left.sessionId, false)
    if (opened) previousSession.value = undefined
    return opened
}

/** Restore as a Copy (§1.4.2's notice): a fork of a session open in another tab. */
export const restoreAsCopy = (sessionId: string) => openSession(sessionId, true)

/** A row of Settings › Local Data › Recovery (§1.4.14). */
export type RecoveryItem =
    /** A journal of an earlier visit kept while storage is unavailable: Open and Download. */
    | { kind: 'journal'; key: string; text: string; writtenAt?: number; size: number }
    /** The old auto save, unreadable, or kept without IndexedDB: Download and Discard…. */
    | { kind: 'autoSave'; key: string; text: string; size: number; readable: boolean }
    /** The legacy recovery slot: Download only. */
    | { kind: 'legacy'; key: string; text: string; size: number }
    /** Unreadable recovered work in the `recovered` store: Download and Discard…. */
    | { kind: 'recovered'; id: string; foundAt: number; size: number }

const local = () => {
    try {
        return localStorage
    } catch {
        return undefined
    }
}

/** Every recovery row, as Local Data lists them. */
export const recoveryItems = async (): Promise<RecoveryItem[]> => {
    const items: RecoveryItem[] = []
    for (const found of context?.recovery.keptForLocalData ?? []) {
        const text = local()?.getItem(storageKey(found.from))
        if (text !== found.text) continue
        const reading = readJournal(text, found.sessionId)
        items.push({
            kind: 'journal',
            key: found.from,
            text,
            ...(reading.kind === 'journal' ? { writtenAt: reading.journal.writtenAt } : {}),
            size: new Blob([text]).size,
        })
    }
    for (const key of [AUTO_SAVE_KEY, AUTO_SAVE_UNREADABLE_KEY]) {
        const text = local()?.getItem(storageKey(key))
        if (text === null || text === undefined) continue
        items.push({
            kind: 'autoSave',
            key,
            text,
            size: new Blob([text]).size,
            readable: key === AUTO_SAVE_KEY && context?.recovery.status.mode !== 'stored',
        })
    }
    const legacy = local()?.getItem(storageKey(LEGACY_RECOVERY_KEY))
    if (legacy)
        items.push({
            kind: 'legacy',
            key: LEGACY_RECOVERY_KEY,
            text: legacy,
            size: new Blob([legacy]).size,
        })
    const worker = context?.open.worker
    if (worker && context?.recovery.status.mode !== 'memory')
        for (const row of await worker.call('listRecovered').catch(() => []))
            items.push({ kind: 'recovered', id: row.id, foundAt: row.foundAt, size: row.size })
    return items
}

/** A recovery row as a file to download (`toRecoveryFile`); the UI hands it over. */
export const recoveryFile = async (item: RecoveryItem) => {
    if (item.kind !== 'recovered') return toRecoveryFile(item.text)
    const text = await context?.open.worker.call('readRecovered', item.id)
    return text === undefined ? undefined : toRecoveryFile(text)
}

/**
 * Discard… after its confirm: removes the row, only while it still holds what was listed. A
 * journal goes only after it was opened and stored, downloaded or discarded (§1.6.7).
 */
export const discardRecoveryItem = async (item: RecoveryItem) => {
    if (item.kind === 'recovered') {
        await context?.open.worker.call('discardRecovered', item.id)
        return
    }
    const store = local()
    const key = storageKey(item.key)
    if (store?.getItem(key) === item.text) store.removeItem(key)
}

/**
 * Open on a journal kept while storage is unavailable (§1.6.7): its state in a new session in
 * this tab, whose own journal covers it from now on. The key stays until downloaded or discarded.
 */
export const openRecoveryJournal = (item: RecoveryItem & { kind: 'journal' }) => {
    const sessionId = item.key.slice('journal.'.length)
    const reading = readJournal(item.text, sessionId)
    if (reading.kind !== 'journal') return false
    const content = journalState(reading.journal)
    if (content.kind !== 'state') return false
    const { name, sourceName } = reading.journal.descriptor
    openState(content.state, {
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof sourceName === 'string' ? { sourceName } : {}),
    })
    return true
}
