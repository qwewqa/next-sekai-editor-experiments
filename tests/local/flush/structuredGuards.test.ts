import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName, equalJson, type JsonValue } from '../../../src/history/operations'
import { createWorld } from '../../../src/local/testing/world'
import { editStep, initialLife, nativeOperation, originOperation } from '../../helpers/historySteps'
import { goldenChart, stateOf } from '../records/charts'
import { handlersOf, readOpen } from '../startup/harness'
import { storedEntries } from '../timeline/helpers'
import { openPage, rows } from './harness'

test('invalid append and Save descriptions preserve sequence, reservation and pending entries', async () => {
    const world = createWorld({ seed: 93801 })
    const page = await openPage(world, world.tab('guard'))
    const state = stateOf(goldenChart())
    const session = page.flusher.begin({
        id: 'guard',
        docId: 'doc',
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush()
    const nextSeq = session.nextSeq
    assert.throws(() =>
        page.flusher.append({ kind: 'edit', step: { kind: 'edit', operation: NaN } }, state, true),
    )
    assert.equal(session.nextSeq, nextSeq)
    assert.equal(session.pending.length, 0)
    const reservation = page.flusher.reserveSave()!
    const changed = { ...state, initialLife: state.initialLife + 1 }
    page.flusher.append(
        { kind: 'edit', step: editStep(initialLife(state.initialLife, changed.initialLife)) },
        changed,
        true,
    )
    const pending = [...session.pending]
    assert.throws(() =>
        page.flusher.endSave(reservation, { wall: reservation.wall, state, operation: Infinity }),
    )
    assert.equal(session.reserved, reservation.seq)
    assert.deepEqual(session.pending, pending)
    assert.equal(session.identity, undefined)
    await page.flusher.endSave(reservation, {
        wall: reservation.wall,
        state,
        operation: nativeOperation(
            { id: 'nse.file.save', data: { file: captureName('guard.nxsp'), delivery: 'file' } },
            'Saved guard.nxsp',
        ),
    })
    assert.deepEqual(page.errors, [])
    assert.deepEqual(
        storedEntries(world, session.id).map(({ kind, seq }) => [kind, seq]),
        [
            ['init', 1],
            ['save', 2],
            ['edit', 3],
        ],
    )
})

test('chain-field continuation describes the last source entry and rejects unsupported writers', async () => {
    const world = createWorld({ seed: 93802 })
    const page = await openPage(world, world.tab('source'), {
        writeChain: (request) => page.tab.run(() => handlersOf(page).writeChainFields(request)),
    })
    const state = stateOf(goldenChart())
    const session = page.flusher.begin({
        id: 'source',
        docId: 'doc',
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })
    const changed = { ...state, initialLife: state.initialLife + 1 }
    page.flusher.append(
        { kind: 'edit', step: editStep(initialLife(state.initialLife, changed.initialLife)) },
        changed,
        true,
    )
    await page.flusher.flush()
    const stored = rows(world, 'sessions').get(session.id)!
    const lastTime = stored.updatedAt as number
    assert.notEqual(lastTime, stored.startedAt)
    const original = rows(world, 'chains').get(session.chainId)!
    for (const v of [undefined, 1, 3]) {
        await page.tab.run(() =>
            page.core.write(['sessions'], (tx) => tx.put('sessions', { ...stored, v })),
        )
        const result = await page.tab.run(() =>
            handlersOf(page).writeChainFields({
                chainId: session.chainId,
                sessionId: session.id,
                fields: { name: 'must not write' },
                appVersion: '0.6.0',
            }),
        )
        assert.equal(result.kind, 'missing')
        assert.deepEqual(rows(world, 'chains').get(session.chainId), original)
        assert.equal(
            (await page.tab.run(() => handlersOf(page).readSession(session.id))).kind,
            'later',
        )
    }
    await page.tab.run(() =>
        page.core.write(['sessions', 'chains'], async (tx) => {
            await tx.put('sessions', stored)
            await tx.put('chains', { ...original, head: 'other' })
        }),
    )
    const source = await readOpen(page, session.id)
    assert.equal(source.session.updatedAt, lastTime)
    assert.equal(await page.flusher.setChainFields({ exportName: 'Fork name' }), false)
    await page.flusher.flush()
    const fork = page.flusher.session!
    assert.notEqual(fork.id, session.id)
    const event = storedEntries(world, fork.id)[0]!
    assert(event.kind === 'continue')
    assert(
        equalJson(
            event.operation,
            nativeOperation(
                { id: 'nse.continue', data: { fromTime: lastTime } },
                'Continued',
            ) as unknown as JsonValue,
        ),
    )
    assert.deepEqual(page.errors, [])
})
