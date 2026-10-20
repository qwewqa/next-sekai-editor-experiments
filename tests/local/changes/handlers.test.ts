import assert from 'node:assert/strict'
import test from 'node:test'
import type { NoteObject } from '../../../src/chart/note'
import { captureEntryDescription } from '../../../src/history/operations'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { noteObjectOf } from '../../../src/local/records/extract'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { createWorld } from '../../../src/local/testing/world'
import {
    changeHandlers,
    clearChangeCaches,
    type FindEditsPage,
} from '../../../src/local/worker/changeHandlers'
import { createState, type State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { editStep, nativeOperation } from '../../helpers/historySteps'
import { openPage } from '../flush/harness'
import { goldenChart, note } from '../records/charts'
import { beginIn } from '../startup/harness'
import { storedEntries } from '../timeline/helpers'

// The worker's change reads over the test core (§1.6.5): what an entry changed, and Edits Here's
// scan in slices, newest first, leaving out entries whose state can't be read.

const chart = (count: number) =>
    createState(
        {
            ...goldenChart().chart,
            slides: Array.from({ length: count }, (_, i) => [note(i * 4, { left: -4 })]),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
        },
        0,
    )

/** The state with the note at `beat` one lane further right. */
const nudge = (state: State, beat: number) => {
    const target = [...state.store.slides.note.values()].flat().find((n) => n.beat === beat)!
    const transaction = createTransaction(state)
    const object: NoteObject = { ...noteObjectOf(target), left: target.left + 1 }
    replaceNote(transaction, target, object)
    return transaction.commit([])
}

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

/** A stored session nudging the notes at these beats in turn. */
const stored = async (beats: number[]) => {
    clearChangeCaches()
    const world = createWorld({ seed: 7 })
    const page = await openPage(world, world.tab('a'))
    const states = [chart(40)]
    const session = beginIn(page, states[0]!)
    for (const beat of beats) {
        const next = nudge(states.at(-1)!, beat)
        states.push(next)
        page.flusher.append(
            {
                kind: 'edit',
                step: editStep(
                    nativeOperation(
                        { id: 'nse.object.move', data: { subject: 'note', changed: { note: 1 } } },
                        `Nudged ${beat}`,
                    ),
                ),
            },
            next,
            true,
        )
    }
    await page.flusher.flush({ strict: true })
    const handlers = changeHandlers({ core: page.core, test: true, emit: () => undefined })
    const run = <T>(work: () => Promise<T>) => page.tab.run(work)
    return { world, page, session, states, handlers, run }
}

const scanAll = async (
    find: (cursor?: FindEditsPage['cursor']) => Promise<FindEditsPage>,
): Promise<FindEditsPage> => {
    const all: FindEditsPage = { matches: [], unreadable: 0 }
    let cursor: FindEditsPage['cursor']
    do {
        const page = await find(cursor)
        all.matches.push(...page.matches)
        all.unreadable += page.unreadable
        all.top ??= page.top
        cursor = page.cursor
    } while (cursor)
    return all
}

test('readChanges: what an entry changed against the one before', async () => {
    const { states, handlers, run } = await stored([8, 12])
    const set = await run(() =>
        handlers.readChanges({ before: rootOf(states[0]!), after: rootOf(states[1]!) }),
    )
    assert.deepEqual(
        set?.objects.map((object) => [object.status, object.beat]),
        [['changed', 8]],
    )
    const same = await run(() =>
        handlers.readChanges({ before: rootOf(states[1]!), after: rootOf(states[1]!) }),
    )
    assert.equal(same?.layout, 'none')
})

test('findEdits: newest first, across slices, with the entry each was compared with', async () => {
    // 120 edits: three slices of 50, each nudging a note at a beat from 0 to 156.
    const beats = Array.from({ length: 120 }, (_, i) => (i % 40) * 4)
    const { session, handlers, run, world } = await stored(beats)
    const result = await scanAll((cursor) =>
        run(() =>
            handlers.findEdits({
                sessionId: session.id,
                from: 10,
                to: 13,
                budgetMs: 0,
                ...(cursor ? { cursor } : {}),
            }),
        ),
    )
    const seqs = storedEntries(world, session.id)
    // Beat 12 was nudged by edits 4, 44 and 84 (the 1st edit is seq 1).
    assert.deepEqual(
        result.matches.map(captureEntryDescription),
        [84, 44, 4].map((n) => captureEntryDescription(seqs[n])),
    )
    assert.deepEqual(
        result.matches.map((match) => match.seq),
        [84, 44, 4].map((n) => seqs[n]!.seq),
    )
    for (const match of result.matches) assert.equal(match.previous.seq, match.seq - 1)
    // Positions along the scan, newest first from 0.
    assert.equal(result.matches[0]!.pos, seqs.at(-1)!.seq - result.matches[0]!.seq)
    assert.equal(result.unreadable, 0)
    assert.equal(result.top?.seq, seqs.at(-1)!.seq)
})

test('findEdits stops at what an earlier scan checked', async () => {
    const { session, handlers, run, world } = await stored([12, 12, 12, 12])
    const seqs = storedEntries(world, session.id).map((entry) => entry.seq)
    const result = await scanAll((cursor) =>
        run(() =>
            handlers.findEdits({
                sessionId: session.id,
                from: 12,
                to: 12,
                until: { sessionId: session.id, seq: seqs[2]! },
                ...(cursor ? { cursor } : {}),
            }),
        ),
    )
    assert.deepEqual(
        result.matches.map((match) => match.seq),
        [seqs[4], seqs[3]],
    )
})

test('a missing chunk makes an entry unknown: readChanges says so, findEdits leaves it out', async () => {
    const { states, session, handlers, run, page } = await stored([8, 8])
    // A chunk only the second edit's state has.
    const shared = new Set(
        [states[0]!, states[1]!].flatMap((state) =>
            encodeSnapshot(toRecords(state)).chunks.map((chunk) => toHex(chunk.hash)),
        ),
    )
    const own = encodeSnapshot(toRecords(states[2]!)).chunks.find(
        (chunk) => !shared.has(toHex(chunk.hash)),
    )!
    await run(() =>
        page.core.write(['chunks'], (tx) =>
            tx.delete('chunks', hashKey(fromHex16(toHex(own.hash)))),
        ),
    )
    const unknown = await run(() =>
        handlers.readChanges({ before: rootOf(states[1]!), after: rootOf(states[2]!) }),
    )
    assert.equal(unknown, undefined)
    const result = await scanAll((cursor) =>
        run(() =>
            handlers.findEdits({
                sessionId: session.id,
                from: 8,
                to: 8,
                ...(cursor ? { cursor } : {}),
            }),
        ),
    )
    // The first edit still matches; the second, and nothing else, could not be checked.
    assert.equal(result.matches.length, 1)
    assert.equal(result.unreadable, 1)
})
