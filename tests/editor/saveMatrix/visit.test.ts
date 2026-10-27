import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle, type World } from './world'

// A new visit is stored from its first own entry, so opening a chart and closing it again adds
// nothing. A write-back that writes nothing keeps it so, and one that writes commits the visit's
// first row before the file. The real save flow runs over the door's real flusher and flush
// handlers, so "stored" is what the store holds. The fork at the commit comes from the world's
// fake flusher.

const { setSaveEnvironment } = await import('../../../src/editor/save/binding')
const { setFlusherForMatrix } = await import('./stubs/storing')
const { session: currentSession } = await import('../../../src/history/session')
const { createHistoryOperation } = await import('../../../src/history/createHistoryOperation')
const { initialStep } = await import('../../helpers/historySteps')

type Row = Record<string, unknown>

const storedRow = (w: World, store: 'chains' | 'sessions' | 'entries', key: unknown) =>
    w.door.tab.run(() =>
        w.door.core.read(
            [store],
            async (tx) => (await tx.get(store, key as never)) as Row | undefined,
        ),
    )

/** A new visit to chain-own: a continuation of its head, not stored yet, as a load opens it. */
const visit = async (w: World) => {
    const record = w.chains.get('chain-own')!
    const head = String(record.head)
    const parent = (await storedRow(w, 'sessions', head))!
    const uptoSeq = Number(parent.lastSeq)
    const last = (await storedRow(w, 'entries', [head, uptoSeq]))!
    const { flusher } = w.door
    const session = flusher.continueSession({
        id: 'session-visit',
        chainId: 'chain-own',
        docId: String(record.docId),
        lineageId: String(record.lineageId),
        parent: { id: head, uptoSeq },
        stack: {
            first: 0,
            slots: [{ hash: last.snapshot as Uint8Array, step: initialStep() }],
            index: 0,
        },
        chain: { ...record },
        operation: createHistoryOperation({
            id: 'nse.continue',
            data: { fromTime: Number(parent.updatedAt) },
        }),
        dirty: false,
    })
    setFlusherForMatrix(flusher, { rewrite: () => undefined })
    setSaveEnvironment(() =>
        flusher.session
            ? {
                  worker: w.worker as never,
                  flusher,
                  session: flusher.session,
                  chainId: flusher.session.chainId,
              }
            : undefined,
    )
    currentSession.value = { ...currentSession.value, sessionId: session.id }
    return session
}

const ended = (w: World, kind: string) => w.dialogs.some((dialog) => dialog.kind === kind)

for (const { name, setup, denied, shown } of [
    {
        name: 'nothing changed: "No changes since"',
        setup: { unchanged: true },
        shown: 'noChanges',
    },
    {
        name: 'the file changed on disk, and the conflict dialog is closed',
        setup: { unchanged: true, ownDisk: 'ahead' as const },
        shown: 'conflict',
    },
    {
        name: 'the file is gone, and the not-found dialog is closed',
        setup: { unchanged: true, own: 'missing' as const },
        shown: 'notFound',
    },
    {
        name: 'the write permission is refused',
        setup: {},
        denied: true,
        shown: 'denied',
    },
])
    test(`a Save that writes nothing stores nothing of the visit: ${name}`, async () => {
        const w = await createWorld({ storage: 'holds', ...setup })
        if (denied) w.tune.writePermission = 'denied'
        const session = await visit(w)
        await flow.save()
        await settle()
        assert.ok(ended(w, shown), `the Save ended in ${shown}`)
        assert.equal(w.writes.length, 0, 'nothing is written')
        assert.equal(session.stored, false, 'the visit is not stored')
        assert.equal(await storedRow(w, 'sessions', 'session-visit'), undefined)
        assert.equal((await storedRow(w, 'chains', 'chain-own'))?.head, 'session-own')
    })

test("a write-back commits the visit's first row before it writes the file", async () => {
    const w = await createWorld({ storage: 'holds' })
    const session = await visit(w)
    const storedAtWrite: boolean[] = []
    const push = w.mock.calls.push.bind(w.mock.calls)
    w.mock.calls.push = (...items: string[]) => {
        for (const item of items) if (item === 'write:own.nxsp') storedAtWrite.push(session.stored)
        return push(...items)
    }
    await flow.save()
    await settle()
    assert.ok(ended(w, 'saved'), 'saved')
    assert.deepEqual(storedAtWrite, [true], 'the visit was stored before the write')
    const first = await storedRow(w, 'entries', ['session-visit', 1])
    assert.equal(first?.kind, 'continue')
    assert.equal((await storedRow(w, 'chains', 'chain-own'))?.head, 'session-visit')
})

test('a commit before the write that forks the session writes nothing and opens the Save dialog', async () => {
    const w = await createWorld({ storage: 'holds' })
    const fork = { ...w.session, id: 'session-fork', chainId: 'chain-fork', chain: {} }
    w.flusher.flush = () => {
        // Another tab continued the chain first, so the commit went on as a fork, without the binding.
        w.flusher.session = fork
        return Promise.resolve()
    }
    await flow.save()
    await settle()
    assert.equal(w.writes.length, 0, 'nothing is written')
    assert.ok(ended(w, 'saveDialog'), 'the Save dialog, for the fork')
})
