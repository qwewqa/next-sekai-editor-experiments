import { NO_USE_DAY, type UseDay } from './days'
import { bumpEpoch, FORMAT_VERSION, readMeta, writeMeta } from './db'
import { toHex } from './hash'
import { KeyRange, type Key, type KvTx } from './kv/types'
import {
    isKnownEntryKind,
    isKnownNodeType,
    isNewerRootVersion,
    isNewerSessionVersion,
} from './records/unknownValues'
import { stampNow } from './time'
import type { ExclusiveHold, StorageCore } from './worker/core'

// GC (Part 1 §1.6.8.6; deletion design §3.5): mark from every row that names a body, sweep the
// bodies nothing reaches. One `nse-maint` exclusive hold from the mark to the last sweep (R6): no
// writer adds a reference meanwhile, and the pass stops as soon as one waits, keeping what it swept.
// It reads only the fields that name bodies, and removes nothing while a newer build's data is
// in use (R7): a newer session, an unknown entry kind, or a reachable node this build can't read.

export type GcResult =
    /** Not due: no deletion pending and run already on this day of use. */
    | { kind: 'skipped' }
    /** `nse-maint` is held or wanted, or an import is running (its deduped bodies are unmarked). */
    | { kind: 'busy' }
    | { kind: 'done'; swept: number }
    /** A writer waited: stopped, with the batches swept so far committed. */
    | { kind: 'aborted'; swept: number }
    /** Data a newer build wrote: nothing removed, and not tried again until the next day of use. */
    | { kind: 'unsafe'; why: string }

/** A body first stored within this many days of use is kept: an import's or flush's parts in flight. */
export const GC_GRACE_DAYS = 2

const READ_BATCH = 2000
const SWEEP_BATCH = 500
/** Pops of the traversal between looks for a waiting writer. */
const TRAVERSE_STEP = 5000

const BODY_STORES = ['nodes', 'chunks', 'media'] as const

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

const isHash = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array && value.byteLength === 16

const packed = (value: unknown): Uint8Array[] => {
    if (!(value instanceof Uint8Array) || value.byteLength % 16) return []
    const out: Uint8Array[] = []
    for (let at = 0; at < value.byteLength; at += 16) out.push(value.subarray(at, at + 16))
    return out
}

const keyHex = (key: Key) => toHex(new Uint8Array(key as ArrayBuffer))

class Unsafe extends Error {}
class Aborted extends Error {}

/** Runs one pass inside `core.exclusive`; `always` runs it when not due (after a removal). */
export const gcPass = async (
    core: StorageCore,
    { always = false, tick }: { always?: boolean; tick?: () => void } = {},
): Promise<GcResult> => {
    const ran = await core.exclusive((hold) => pass(hold, always, tick))
    return ran.ran ? ran.value : { kind: 'busy' }
}

const pass = async (
    hold: ExclusiveHold,
    always: boolean,
    tick: (() => void) | undefined,
): Promise<GcResult> => {
    const state = await hold.read(['meta'], async (tx) => ({
        format: (await readMeta(tx, 'formatVersion')) ?? FORMAT_VERSION,
        days: (await readMeta(tx, 'daysOfUse')) ?? NO_USE_DAY,
        last: await readMeta(tx, 'lastGcAt'),
        pending: (await readMeta(tx, 'deletionsPending')) === true,
    }))
    if (state.format > FORMAT_VERSION) return { kind: 'unsafe', why: 'a newer database format' }
    // An unsafe pass today waits for the next day of use even with a deletion pending.
    const unsafeToday = state.last?.unsafe === true && state.last.day >= state.days
    const due = (state.pending && !unsafeToday) || !state.last || state.last.day < state.days
    if (!always && !due) return { kind: 'skipped' }
    const sessions = await hold.read(['sessions'], (tx) => tx.getAll('sessions'))
    if (sessions.some((row) => isRow(row) && isNewerSessionVersion(row.v)))
        return unsafe(hold, state.days, 'a session of a newer version')
    // A running import skips bodies already stored, which only its later batches reach: wait.
    // One that stopped (`importPending` with no lock held) starts again at batch 0 and stores again
    // whatever is swept meanwhile, so it never holds GC up.
    if (await hold.importRunning()) return { kind: 'busy' }

    let swept = 0
    /** Between batches: a waiting writer ends the pass. */
    const yieldTo = async () => {
        tick?.()
        if (await hold.writerWaiting()) throw new Aborted()
    }
    try {
        const marked = new Set<string>()
        const mark = (hash: unknown) => {
            if (isHash(hash)) marked.add(toHex(hash))
        }
        // Mark: every entry's state, a recovered entry's pushed states, every stack slot.
        await pages(hold, 'entries', yieldTo, (row) => {
            if (!isKnownEntryKind(row.kind)) throw new Unsafe('an entry of an unknown kind')
            mark(row.snapshot)
            const push = isRow(row.stack) ? row.stack.push : undefined
            if (Array.isArray(push)) for (const slot of push) if (isRow(slot)) mark(slot.snapshot)
        })
        await pages(hold, 'stackBlocks', yieldTo, (row) => {
            for (const hash of packed(row.hashes)) mark(hash)
        })
        // Then everything the marked roots reach through `refs`. A reachable node this build
        // can't read may reach more than its `refs` say; an unreachable one is swept.
        const refs = new Map<string, Uint8Array[]>()
        const unread = new Map<string, string>()
        await pages(hold, 'nodes', yieldTo, (row, key) => {
            const hex = keyHex(key)
            if (!isKnownNodeType(row.t)) unread.set(hex, 'a node of an unknown type')
            else if (row.t === 'root' && isNewerRootVersion(row.v))
                unread.set(hex, 'a root of a newer version')
            refs.set(hex, packed(row.refs))
        })
        const stack = [...marked]
        let pops = 0
        for (let hex = stack.pop(); hex !== undefined; hex = stack.pop()) {
            if (++pops % TRAVERSE_STEP === 0) await yieldTo()
            const why = unread.get(hex)
            if (why) throw new Unsafe(why)
            for (const child of refs.get(hex) ?? []) {
                const text = toHex(child)
                if (marked.has(text)) continue
                marked.add(text)
                stack.push(text)
            }
        }

        const candidates: { store: string; key: Key }[] = []
        for (const store of BODY_STORES) {
            await yieldTo()
            for (const key of await hold.read([store], (tx) => tx.getAllKeys(store)))
                if (!marked.has(keyHex(key))) candidates.push({ store, key })
        }

        // Sweep, keeping what was first stored within the grace period or has no day.
        for (let at = 0; at < candidates.length; at += SWEEP_BATCH) {
            await yieldTo()
            const batch = candidates.slice(at, at + SWEEP_BATCH)
            swept += await hold.write([...BODY_STORES, 'meta'], async (tx) => {
                let deleted = 0
                for (const { store, key } of batch) {
                    const row = await tx.get(store, key)
                    if (!isRow(row) || typeof row.day !== 'number') continue
                    if (state.days - row.day < GC_GRACE_DAYS) continue
                    await tx.delete(store, key)
                    deleted++
                }
                if (deleted) await bumpEpoch(tx)
                return deleted
            })
        }
    } catch (error) {
        if (error instanceof Unsafe) return unsafe(hold, state.days, error.message)
        if (error instanceof Aborted) return { kind: 'aborted', swept }
        throw error
    }
    await hold.write(['meta'], async (tx) => {
        await writeMeta(tx, 'lastGcAt', { day: state.days, time: await stampNow(tx) })
        await writeMeta(tx, 'deletionsPending', false)
    })
    return { kind: 'done', swept }
}

/** Records that the pass ran (so it isn't repeated today), leaving `deletionsPending` as it is. */
const unsafe = async (hold: ExclusiveHold, day: UseDay, why: string): Promise<GcResult> => {
    await hold.write(['meta'], async (tx) =>
        writeMeta(tx, 'lastGcAt', { day, time: await stampNow(tx), unsafe: true }),
    )
    return { kind: 'unsafe', why }
}

/** Every row of a store in key order, a read transaction per batch, yielding between them. */
const pages = async (
    hold: ExclusiveHold,
    store: string,
    yieldTo: () => Promise<void>,
    each: (row: Row, key: Key) => void,
) => {
    let after: Key | undefined
    for (;;) {
        const batch = await hold.read([store], (tx: KvTx) =>
            tx.entries(store, {
                ...(after === undefined ? {} : { query: KeyRange.lowerBound(after, true) }),
                limit: READ_BATCH,
            }),
        )
        for (const { primaryKey, value } of batch) each(isRow(value) ? value : {}, primaryKey)
        if (batch.length < READ_BATCH) return
        after = batch.at(-1)?.primaryKey
        await yieldTo()
    }
}
