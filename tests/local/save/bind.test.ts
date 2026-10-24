import assert from 'node:assert/strict'
import test from 'node:test'
import { fromHex16 } from '../../../src/local/hash'
import { BIND_STORES, recordOwnSave, type OwnSaveRecord } from '../../../src/local/save/bind'
import { Fixture } from './fixture'

// Recording our own completed Save (Part 1 §1.4.7; spec A, I-4 and I-10): the binding and nothing
// else, only from the chain's head, over the binding the Save started from, never while a session
// of the chain imports. Each refusal leaves storage exactly as it was.

const STORES = ['chains', 'sessions', 'entries', 'meta', 'handles'] as const

const dump = (fixture: Fixture) =>
    fixture.store.read(STORES, async (tx) => ({
        chains: await tx.getAll('chains'),
        sessions: await tx.getAll('sessions'),
        entries: await tx.getAll('entries'),
        meta: await tx.getAll('meta'),
        handles: await tx.getAll('handles'),
    }))

/** A chain with one stored session of three rows; the Save's cut is its third. */
const chainOf = async () => {
    const fixture = await Fixture.create(90)
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    await fixture.flush()
    return { fixture, session: fixture.session.id }
}

const recordOf = (
    fixture: Fixture,
    sessionId: string,
    extra: Partial<OwnSaveRecord['unit']> = {},
    writer: OwnSaveRecord['writer'] = { sessionId },
): OwnSaveRecord => ({
    chainId: fixture.chainId,
    writer,
    unit: {
        docId: fixture.docId,
        revision: { id: 'own-revision', n: 1, ancestors: [] },
        file: {
            name: 'coconut.nxsp',
            event: 'saved',
            at: 5,
            hash: fromHex16(fixture.head),
            handle: { name: 'coconut.nxsp' },
            // The cut as the build made it: startedAt is the session row's, set when recorded.
            entry: { sessionId, seq: 4, startedAt: 0, count: 4, notKept: 0 },
        },
        marks: [],
        from: {},
        ...extra,
    },
})

const record = (fixture: Fixture, request: OwnSaveRecord) =>
    fixture.store.write(BIND_STORES, (tx) => recordOwnSave(tx, request), { durability: 'strict' })

test('recording changes the chain record, its handle row and the write’s marks, and nothing else', async () => {
    const { fixture, session } = await chainOf()
    const before = await dump(fixture)
    const request = recordOf(fixture, session, { marks: [{ sessionId: session, seq: 2 }] })
    assert.equal(await record(fixture, request), 'recorded')
    const after = await dump(fixture)

    // No session row, no meta row, and the entries differ only in the marked row's `kept`.
    assert.deepEqual(after.sessions, before.sessions)
    assert.deepEqual(after.meta, before.meta)
    assert.equal(after.entries.length, before.entries.length)
    const marked = (rows: unknown[]) =>
        (rows as { seq: number; kept: boolean }[]).map(({ seq, kept }) => [seq, kept])
    assert.deepEqual(
        marked(after.entries).filter(([seq]) => seq === 2),
        [[2, false]],
    )
    assert.deepEqual(
        after.entries.map((row) => ({ ...(row as object), kept: true })),
        before.entries.map((row) => ({ ...(row as object), kept: true })),
    )
    assert.equal(after.handles.length, before.handles.length + 1)

    const chain = (await fixture.chain()) as {
        revision: { id: string }
        file: { entry: { startedAt: number }; name: string }
    }
    assert.equal(chain.revision.id, 'own-revision')
    assert.equal(chain.file.name, 'coconut.nxsp')
    const row = after.sessions[0] as { startedAt: number }
    assert.equal(chain.file.entry.startedAt, row.startedAt)
})

test('a recorded Save is not repeated over the binding it made', async () => {
    const { fixture, session } = await chainOf()
    const request = recordOf(fixture, session)
    assert.equal(await record(fixture, request), 'recorded')
    // The same recognition again: the record's binding is no longer the one it started from.
    assert.equal(await record(fixture, request), 'stale')
})

test('each refusal leaves storage as it was', async () => {
    const { fixture, session } = await chainOf()
    const other = recordOf(fixture, session)
    const refusals: [string, OwnSaveRecord][] = [
        ['gone', { ...other, chainId: 'no-such-chain' }],
        // The page that records holds neither the head nor an unstored continuation of it.
        ['notHead', { ...other, writer: { sessionId: 'someone-else' } }],
        // The record's binding changed since the Save started: a takeover's revocation, say.
        ['stale', { ...other, unit: { ...other.unit, from: { fileAt: 99 } } }],
        // A marked row of a stored session that is not stored.
        ['marks', { ...other, unit: { ...other.unit, marks: [{ sessionId: session, seq: 99 }] } }],
    ]
    for (const [expected, request] of refusals) {
        const before = await dump(fixture)
        assert.equal(await record(fixture, request), expected)
        assert.deepEqual(await dump(fixture), before, expected)
    }
})

test('an unstored continuation records over its parent, the head; a stored session that is not the head does not', async () => {
    const { fixture, session } = await chainOf()
    const unstored = recordOf(fixture, session, {}, { sessionId: 'unstored', parentId: session })
    // A stored session is judged by itself: its parent being the head is not enough.
    await fixture.start()
    await fixture.flush()
    const stored = fixture.session.id
    assert.notEqual(stored, session)
    const behind = recordOf(fixture, session, {}, { sessionId: session, parentId: stored })
    const before = await dump(fixture)
    assert.equal(await record(fixture, behind), 'notHead')
    assert.deepEqual(await dump(fixture), before)
    // The head is now `stored`; the unstored continuation of the old head is no longer its tab.
    assert.equal(await record(fixture, unstored), 'notHead')
    const next = recordOf(fixture, stored, {}, { sessionId: 'unstored', parentId: stored })
    assert.equal(await record(fixture, next), 'recorded')
})

test('a session of the chain that still imports refuses the recording, whichever session it is', async () => {
    const { fixture, session } = await chainOf()
    // The head is the second session; the first, not the head, is the one still importing.
    await fixture.start()
    await fixture.flush()
    const head = fixture.session.id
    await fixture.store.write(['sessions'], async (tx) => {
        const row = (await tx.get('sessions', session)) as object
        await tx.put('sessions', { ...row, importPending: true })
    })
    const before = await dump(fixture)
    assert.equal(await record(fixture, recordOf(fixture, head)), 'importing')
    assert.deepEqual(await dump(fixture), before)
    // Once it ends, the same recording goes through.
    await fixture.store.write(['sessions'], async (tx) => {
        const row = (await tx.get('sessions', session)) as { importPending?: true }
        delete row.importPending
        await tx.put('sessions', row)
    })
    assert.equal(await record(fixture, recordOf(fixture, head)), 'recorded')
})
