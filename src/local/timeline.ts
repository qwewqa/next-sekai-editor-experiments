import {
    captureEntryDescription,
    captureStep,
    equalJson,
    pushedStep,
    type EntryDescription,
    type JsonValue,
    type UndoableStep,
} from '../history/operations'
import { equalBytes, toHex } from './hash'
import type { SessionOrigin } from './records/unknownValues'

// The timeline and the stored undo stack (Part 1 §1.3.7–§1.3.9, §1.6.4 #6). Replay of a session's
// entries defines its stack; the stack is stored as snapshot refs in blocks of 256 slots, keyed
// by absolute slot numbers, with a window of at most 5,000 slots that always includes the index.
// The page replays its pending entries over the stack last acknowledged, so a flush writes the
// stack after its last entry, rewriting only the blocks whose slots changed.

/** Slots in one `stackBlocks` row. */
export const BLOCK_SLOTS = 256
/** The stored window's most slots [WS-31]. The live tab's stack has no limit. */
export const STACK_CAP = 5000

/** A session row's `stack`: the stored slots `base … base + length − 1` and the index. */
export type StackWindow = { readonly base: number; readonly length: number; readonly index: number }

/**
 * The stored window of a stack of `length` slots (§1.6.4 #6): normally the newest `cap`; when
 * the index sits below them, the redo end is cut first, so the window is the `cap` slots ending
 * at the index, or starting at slot 0 when the index is under `cap`. Slots below `floor` (a
 * restored stack's own base) aren't known, so the window never starts below it.
 */
export const storedWindow = (
    length: number,
    index: number,
    floor = 0,
    cap = STACK_CAP,
): StackWindow => {
    if (!(index >= floor && index < length)) throw new RangeError('The index is outside the stack')
    let base = Math.max(floor, length - cap)
    if (index < base) base = Math.max(floor, index < cap ? 0 : index - cap + 1)
    return { base, length: Math.min(cap, length - base), index }
}

export const blockOf = (slot: number) => Math.floor(slot / BLOCK_SLOTS)

/** The window's first and last block. */
export const windowBlocks = (window: StackWindow) => ({
    first: blockOf(window.base),
    last: blockOf(window.base + window.length - 1),
})

/** The slots `first … end − 1` of a block inside a window. */
export const blockSpan = (window: StackWindow, block: number) => ({
    first: Math.max(block * BLOCK_SLOTS, window.base),
    end: Math.min((block + 1) * BLOCK_SLOTS, window.base + window.length),
})

/** Kinds a session's first entry can have (§1.3.6): `recovered` for a session a journal made. */
export const FIRST_KINDS: readonly string[] = ['init', 'continue', 'recovered']

/** Entries that make a chain edited (§1.6.11.2's `edited`). */
export const EDITING_KINDS: readonly string[] = ['edit', 'undo', 'redo', 'restore', 'recovered']

export const isEditingKind = (kind: string) => EDITING_KINDS.includes(kind)

/**
 * A chain record's flags at its creation (§1.6.11.2): `hasContent` for every origin but a blank
 * start and a continuation, `edited` for work that's in no file (a migrated auto save, a journal).
 */
export const chainFlagsAtCreation = (origin: SessionOrigin) => ({
    hasContent: origin !== 'new' && origin !== 'continued',
    edited: origin === 'migrated' || origin === 'journal',
})

export type ReplaySlot = { readonly snapshot: Uint8Array; readonly step: UndoableStep }

/** A `recovered` entry's `stack` (§1.6.11.2): slots `0 … keep − 1` kept, then `push`, at `index`. */
export type RecoveredStack = {
    readonly keep: number
    readonly push: readonly ReplaySlot[]
    readonly index: number
}

/** What replay reads of an entry row. */
export type ReplayEntry = EntryDescription & {
    readonly seq: number
    readonly snapshot: Uint8Array
    readonly stack?: RecoveredStack
}

export type ReplayedStack = { readonly slots: readonly ReplaySlot[]; readonly index: number }

/** Entries replay can't follow: the stack they describe isn't one replay gives. */
export class ReplayError extends Error {
    override name = 'ReplayError'
}

/**
 * Replays a session's entries (§1.3.9), after an inherited stack when it continues one. The test
 * oracle for the stored stack, and how a stack is rebuilt where none was stored. Strict: an
 * undo or redo that doesn't land on its snapshot, or a first entry of the wrong kind, throws.
 */
export const replay = (
    entries: Iterable<ReplayEntry>,
    inherited?: ReplayedStack,
): ReplayedStack => {
    let slots: ReplaySlot[] = inherited ? [...inherited.slots] : []
    let index = inherited ? inherited.index : -1
    let first = !inherited
    for (const entry of entries) {
        const fail = (why: string): never => {
            throw new ReplayError(`Entry ${entry.seq} (${entry.kind}): ${why}`)
        }
        try {
            captureEntryDescription(entry)
        } catch {
            fail('invalid entry description')
        }
        if (first && !FIRST_KINDS.includes(entry.kind)) fail('a session cannot begin with it')
        first = false
        const slot = () => ({ snapshot: entry.snapshot, step: pushedStep(entry) })
        const lands = () => {
            const landed = slots[index]
            if (!landed || !equalBytes(landed.snapshot, entry.snapshot))
                fail('its snapshot is not the slot it lands on')
        }
        switch (entry.kind) {
            case 'init':
                if (slots.length) fail('init after the first entry')
                slots = [slot()]
                index = 0
                break
            case 'continue':
                // The inherited stack stays; only a continuation of nothing starts from its own.
                if (!slots.length) {
                    slots = [slot()]
                    index = 0
                }
                break
            case 'edit':
            case 'restore':
                if (!slots.length) fail('nothing to push onto')
                slots.length = index + 1
                slots.push(slot())
                index++
                break
            case 'undo':
                if (index <= 0) fail('nothing to undo')
                index--
                lands()
                break
            case 'redo':
                if (index >= slots.length - 1) fail('nothing to redo')
                index++
                lands()
                break
            case 'save':
            case 'export':
                if (!slots.length) fail('no stack')
                lands()
                break
            case 'recovered': {
                const stack = entry.stack ?? fail('no stack')
                if (
                    !Number.isSafeInteger(stack.keep) ||
                    stack.keep < 0 ||
                    !Number.isSafeInteger(stack.index)
                )
                    fail('invalid stack replacement')
                slots = [
                    ...slots.slice(0, stack.keep),
                    ...stack.push.map((slot) => ({
                        snapshot: slot.snapshot,
                        step: captureStep(slot.step),
                    })),
                ]
                index = stack.index
                if (index < 0 || index >= slots.length) fail('its index is outside its stack')
                break
            }
            default:
                fail('an unknown kind')
        }
    }
    return { slots, index }
}

/** A `stackBlocks` row (§1.6.11.2). */
export type StackBlockRow = {
    sessionId: string
    block: number
    /** The absolute slot of its first item. */
    first: number
    hashes: Uint8Array
    steps: UndoableStep[]
}

/** A block's slot, or undefined when the block doesn't hold it. */
export const blockSlot = (row: StackBlockRow | undefined, slot: number): ReplaySlot | undefined => {
    if (!row) return
    const at = slot - row.first
    if (at < 0 || (at + 1) * 16 > row.hashes.byteLength) return
    const step = row.steps?.[at]
    if (!step) return
    try {
        return { snapshot: row.hashes.slice(at * 16, at * 16 + 16), step: captureStep(step) }
    } catch {
        return
    }
}

/** The stored window's slots from its blocks, or undefined when a block lacks one. */
export const storedSlots = (
    window: StackWindow,
    block: (block: number) => StackBlockRow | undefined,
): ReplaySlot[] | undefined => {
    const slots: ReplaySlot[] = []
    for (let slot = window.base; slot < window.base + window.length; slot++) {
        const found = blockSlot(block(blockOf(slot)), slot)
        if (!found) return
        slots.push(found)
    }
    return slots
}

/** A block's row from its slots, hashes packed (§1.6.11.2). */
export const blockRow = (
    sessionId: string,
    block: number,
    first: number,
    slots: readonly ReplaySlot[],
): StackBlockRow => {
    const hashes = new Uint8Array(slots.length * 16)
    slots.forEach((slot, i) => {
        hashes.set(slot.snapshot, i * 16)
    })
    return { sessionId, block, first, hashes, steps: slots.map((slot) => captureStep(slot.step)) }
}

/**
 * How a stored stack differs from what its entries replay to, as messages; empty when it's a
 * window of replay's stack: at most `STACK_CAP` slots, the index inside it, every slot equal.
 */
export const stackMismatches = (
    stored: { window: StackWindow; slots: readonly ReplaySlot[] | undefined },
    replayed: ReplayedStack,
): string[] => {
    const { window, slots } = stored
    const problems: string[] = []
    if (window.length < 1 || window.length > STACK_CAP)
        problems.push(`a window of ${window.length} slots`)
    if (window.index !== replayed.index)
        problems.push(`index ${window.index}, replay gives ${replayed.index}`)
    if (window.index < window.base || window.index >= window.base + window.length)
        problems.push('the index is outside the window')
    if (window.base + window.length > replayed.slots.length)
        problems.push(`the window ends at ${window.base + window.length}, past replay's stack`)
    if (!slots) problems.push('a block lacks a slot of the window')
    else
        slots.forEach((slot, i) => {
            const expected = replayed.slots[window.base + i]
            if (!expected || !equalBytes(expected.snapshot, slot.snapshot))
                problems.push(
                    `slot ${window.base + i}: ${toHex(slot.snapshot)}, replay gives ${
                        expected ? toHex(expected.snapshot) : 'nothing'
                    }`,
                )
            else if (
                !equalJson(expected.step as unknown as JsonValue, slot.step as unknown as JsonValue)
            )
                problems.push(`slot ${window.base + i}: step differs`)
        })
    return problems
}

/** A slot of the page's model: stored (its hash) or an entry not yet acknowledged. */
export type ModelSlot<E> = {
    readonly hash?: Uint8Array
    readonly entry?: E
    /** Complete immutable description of the transition that created this slot. */
    readonly step: UndoableStep
}

/** A stack numbered from `first`, as replay gives it: the page's model of a session's stack. */
export class SlotStack<S> {
    constructor(
        public first: number,
        public slots: S[],
        public index: number,
    ) {}

    get end() {
        return this.first + this.slots.length
    }

    at(slot: number): S | undefined {
        return this.slots[slot - this.first]
    }

    clone() {
        return new SlotStack(this.first, [...this.slots], this.index)
    }
}

/** What an entry does to the model, as replay does it; false when the model can't follow. */
const applyKind = <S>(
    stack: SlotStack<S>,
    kind: string,
    slot: () => S,
    changed: { from: number },
): boolean => {
    switch (kind) {
        case 'init':
            stack.first = 0
            stack.slots = [slot()]
            stack.index = 0
            changed.from = 0
            return true
        case 'continue':
            if (stack.slots.length) return true
            stack.first = 0
            stack.slots = [slot()]
            stack.index = 0
            changed.from = 0
            return true
        case 'edit':
        case 'restore':
            if (!stack.slots.length) return false
            stack.slots.length = stack.index - stack.first + 1
            stack.slots.push(slot())
            stack.index++
            changed.from = Math.min(changed.from, stack.index)
            return true
        case 'undo':
            if (stack.index <= stack.first) return false
            stack.index--
            return true
        case 'redo':
            if (stack.index >= stack.end - 1) return false
            stack.index++
            return true
        case 'save':
        case 'export':
            return stack.slots.length > 0
        default:
            return false
    }
}

/** A block a flush rewrites: its slots `first … end − 1`. */
export type BlockWrite = { readonly block: number; readonly first: number; readonly end: number }

/** A flush's stack: the window after its last entry, and the blocks it rewrites. */
export type StackPlan<E> = {
    readonly stack: SlotStack<ModelSlot<E>>
    readonly window: StackWindow
    readonly writes: readonly BlockWrite[]
    /** Every block of the window is rewritten: nothing is taken from what's stored. */
    readonly full: boolean
}

/** Where a window was stored: the database (`meta.dbInstanceId`) and its epoch. */
export type StoredAt = { readonly db: string; readonly epoch: number }

type Saved<E> = {
    committed: SlotStack<ModelSlot<E>>
    window: StackWindow | undefined
    durable: boolean
    at: StoredAt | undefined
    blocks: Map<number, { first: number; end: number }>
}

/**
 * A session's stack as the page knows it (§1.6.4 #6): the stack last acknowledged, every slot a
 * stored hash, with the stored window and the span of each stored block. A flush replays its
 * entries over it and rewrites only the blocks whose slots or span changed, normally the last.
 */
export class SessionStack<E> {
    /** The stack after the entries acknowledged so far. */
    committed = new SlotStack<ModelSlot<E>>(0, [], -1)
    /** The window as stored; undefined until the first write. */
    window: StackWindow | undefined
    /** Each stored block's slots `first … end − 1`. */
    readonly blocks = new Map<number, { first: number; end: number }>()
    /** False when the stored blocks may differ from `blocks`: the next flush rewrites them all. */
    synced = true
    /** Whether the window was stored in a database, not a restarted worker's memory. */
    durable = false
    /** Where the window was stored. */
    at: StoredAt | undefined
    /** The stack before entries only an in-memory store acknowledged: a restart goes back to it. */
    private beforeMemory: Saved<E> | undefined

    /**
     * The stack after these entries, replayed over the acknowledged one, with the first slot
     * they changed; undefined when they don't follow from it (a bug: they're stored anyway).
     */
    replay(
        entries: readonly { readonly kind: string }[],
        slot: (entry: E) => ModelSlot<E>,
        recovered?: (entry: E) => ModelSlot<E>,
    ): { stack: SlotStack<ModelSlot<E>>; changedFrom: number } | undefined {
        const stack = this.committed.clone()
        const changed = { from: Infinity }
        for (const entry of entries) {
            if (entry.kind === 'recovered' && recovered) {
                stack.first = 0
                stack.slots = [recovered(entry as E)]
                stack.index = 0
                changed.from = 0
            } else if (!applyKind(stack, entry.kind, () => slot(entry as E), changed)) return
        }
        if (!stack.slots.length) return
        return { stack, changedFrom: changed.from }
    }

    /** The window to store after a replay, and the blocks to rewrite. */
    plan(stack: SlotStack<ModelSlot<E>>, changedFrom: number): StackPlan<E> {
        const window = storedWindow(stack.end, stack.index, stack.first)
        const { first, last } = windowBlocks(window)
        const writes: BlockWrite[] = []
        const full = !this.synced || !this.window
        for (let block = first; block <= last; block++) {
            const span = blockSpan(window, block)
            const stored = full ? undefined : this.blocks.get(block)
            // A stored block may start below the window (its base moved up): those slots are
            // still replay's, so only a block whose own slots changed, or that ends elsewhere,
            // is rewritten.
            const keeps =
                stored !== undefined &&
                stored.first <= span.first &&
                stored.end === span.end &&
                span.end <= changedFrom
            if (!keeps) writes.push({ block, ...span })
        }
        return { stack, window, writes, full }
    }

    /**
     * Takes an acknowledged flush's stack: its entries' slots resolved to their roots. Without
     * `written` the worker kept a newer stack than this flush's, so the blocks are rewritten.
     */
    commit(
        plan: StackPlan<E>,
        resolve: (entry: E) => { hash: Uint8Array; step: UndoableStep } | undefined,
        { written, durable, at }: { written: boolean; durable: boolean; at: StoredAt },
    ) {
        const slots = plan.stack.slots.map((slot) => {
            if (!slot.entry) return slot
            const stored = resolve(slot.entry)
            if (!stored) throw new Error('A stack slot has no stored snapshot')
            return { hash: stored.hash, step: stored.step }
        })
        this.committed = new SlotStack(plan.stack.first, slots, plan.stack.index)
        this.window = plan.window
        const { first, last } = windowBlocks(plan.window)
        for (const block of [...this.blocks.keys()])
            if (block < first || block > last) this.blocks.delete(block)
        for (const write of plan.writes)
            this.blocks.set(write.block, { first: write.first, end: write.end })
        this.synced = written
        this.durable = durable
        this.at = at
    }

    /** After a worker restart or an unknown outcome: the next flush rewrites every block. */
    unsync() {
        this.synced = false
    }

    /** The worker removed the stored stack: none is stored until the next flush writes it whole. */
    forget() {
        this.window = undefined
        this.blocks.clear()
        this.synced = false
        this.durable = false
        this.at = undefined
    }

    /**
     * A fork's stack: this one as acknowledged, or `inherited` (with slots of entries stored
     * without a reply), which the fork's first flush stores whole.
     */
    forkedStack(inherited?: SlotStack<ModelSlot<E>>) {
        const fork = new SessionStack<E>()
        fork.committed = (inherited ?? this.committed).clone()
        return fork
    }

    /** Saves the stack before the first entry only an in-memory store acknowledged. */
    checkpoint() {
        this.beforeMemory ??= {
            committed: this.committed,
            window: this.window,
            durable: this.durable,
            at: this.at,
            blocks: new Map(this.blocks),
        }
    }

    /** A database holds what memory held: the checkpoint goes. */
    release() {
        this.beforeMemory = undefined
    }

    /** A restarted worker lost its memory: back to the checkpoint, its entries pending again. */
    rollback() {
        const saved = this.beforeMemory
        this.beforeMemory = undefined
        if (saved) {
            this.committed = saved.committed
            this.window = saved.window
            this.durable = saved.durable
            this.at = saved.at
            this.blocks.clear()
            for (const [block, span] of saved.blocks) this.blocks.set(block, span)
        }
        this.synced = false
    }
}

/** A session's rows as the stack check reads them. */
export type SessionRows = {
    readonly session: Record<string, unknown>
    readonly entries: readonly ReplayEntry[]
    readonly blocks: ReadonlyMap<number, StackBlockRow>
}

/**
 * How each stored stack differs from replay of its session's entries (§1.3.9), as messages: a
 * continuation's replay starts from its parent's stack at `uptoSeq`. Sessions without a stored
 * stack are skipped.
 */
export const stackViolations = (sessions: ReadonlyMap<string, SessionRows>): string[] => {
    const replayed = new Map<string, ReplayedStack | undefined>()
    const replayOf = (id: string, upto = Infinity): ReplayedStack | undefined => {
        const rows = sessions.get(id)
        if (!rows) return
        const parent = rows.session.parent as { id?: unknown; uptoSeq?: unknown } | undefined
        const inherited =
            typeof parent?.id === 'string' && typeof parent.uptoSeq === 'number'
                ? replayOf(parent.id, parent.uptoSeq)
                : undefined
        const key = `${id}\0${upto}`
        if (!replayed.has(key))
            replayed.set(
                key,
                replay(
                    rows.entries.filter((entry) => entry.seq <= upto),
                    inherited,
                ),
            )
        return replayed.get(key)
    }
    const problems: string[] = []
    for (const [id, rows] of sessions) {
        const window = rows.session.stack as StackWindow | undefined
        if (!window) continue
        try {
            const expected = replayOf(id)
            if (!expected) continue
            const slots = storedSlots(window, (block) => rows.blocks.get(block))
            for (const problem of stackMismatches({ window, slots }, expected))
                problems.push(`session ${id}: ${problem}`)
        } catch (error) {
            problems.push(
                `session ${id}: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }
    return problems
}
