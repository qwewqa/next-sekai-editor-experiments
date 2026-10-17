import { DB_NAME } from '../../../src/local/db'
import type { World } from '../../../src/local/testing/world'
import {
    replay,
    storedSlots,
    type ReplayedStack,
    type ReplayEntry,
    type ReplaySlot,
    type StackBlockRow,
    type StackWindow,
} from '../../../src/local/timeline'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'

// Reading a session's stored stack and entries back from the test core's profile.

/** The state with its n-th note a quarter lane wider. */
export const widen = (state: State, n = 0) => {
    const notes = [...state.store.slides.note.values()].flat()
    const target = notes[n % notes.length]!
    const transaction = createTransaction(state)
    replaceNote(transaction, target, { ...target, size: target.size + 0.25 })
    return transaction.commit([])
}

const valuesOf = (world: World, store: string) =>
    (world.memory.dump(DB_NAME).get(store) ?? []).map((row) => row.value as Record<string, unknown>)

/** A session's entries in `seq` order. */
export const storedEntries = (world: World, sessionId: string): ReplayEntry[] =>
    valuesOf(world, 'entries')
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number)) as unknown as ReplayEntry[]

/** A session's stack blocks by block number. */
export const storedBlocks = (world: World, sessionId: string) =>
    new Map(
        valuesOf(world, 'stackBlocks')
            .filter((row) => row.sessionId === sessionId)
            .map((row) => [row.block as number, row as unknown as StackBlockRow]),
    )

export const sessionRow = (world: World, sessionId: string) =>
    valuesOf(world, 'sessions').find((row) => row.id === sessionId)

/** A session's stored window and its slots. */
export const storedStack = (
    world: World,
    sessionId: string,
): { window: StackWindow; slots: ReplaySlot[] | undefined } => {
    const window = sessionRow(world, sessionId)?.stack as StackWindow | undefined
    if (!window) throw new Error(`Session ${sessionId} has no stored stack`)
    const blocks = storedBlocks(world, sessionId)
    return { window, slots: storedSlots(window, (block) => blocks.get(block)) }
}

/** What replaying the session's stored entries gives. */
export const replayed = (world: World, sessionId: string): ReplayedStack =>
    replay(storedEntries(world, sessionId))
