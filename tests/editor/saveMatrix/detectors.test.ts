import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check, type Facts } from './invariants'
import { FAULTS, FILES, PATHS, runCell } from './matrix'
import { bytesOf, createWorld, startsWith } from './world'

// Negative controls for the fault matrix: each invariant check must be able to fail, and the
// baseline cells must really reach the picker and write, or a clean matrix would prove nothing.

const facts: Facts = { inHand: (name) => name === 'own.nxsp' }
const invariants = async (
    world: Awaited<ReturnType<typeof createWorld>>,
    extra: Partial<Facts> = {},
) => (await check(world, { ...facts, ...extra })).map((v) => v.invariant)

test('I1 sees a picked file left holding less, and accepts bytes put back, appended or offered', async () => {
    const world = await createWorld()
    world.before.set('own.nxsp', new Blob(['0123456789']))
    world.mock.writeFile('own.nxsp', new Blob([]))
    assert.deepEqual(await invariants(world), ['I1'])
    world.mock.writeFile('own.nxsp', new Blob(['0123456789 and more']))
    assert.deepEqual(await invariants(world), [])
    world.mock.writeFile('own.nxsp', new Blob([]))
    world.mock.downloads.push({
        kind: 'recovery',
        name: 'own.nxsp',
        blob: new Blob(['0123456789']),
    })
    assert.deepEqual(await invariants(world), [])
    // Not in hand: reported as information only.
    world.mock.downloads.length = 0
    assert.deepEqual(await invariants(world, { inHand: () => false }), ['info:emptied'])
})

test('I2 sees a picked file written without nse-bind exclusive', async () => {
    const world = await createWorld()
    world.writes.push({ name: 'own.nxsp', exclusive: false, shared: true, picked: true })
    assert.deepEqual(await invariants(world), ['I2'])
    world.writes[0] = { name: 'own.nxsp', exclusive: true, shared: false, picked: true }
    assert.deepEqual(await invariants(world), [])
})

test('I3 sees a reservation ended twice, never, or left held', async () => {
    const world = await createWorld()
    const first = world.flusher.reserveSave()!
    assert.deepEqual(await invariants(world), ['I3', 'I3'])
    await world.flusher.endSave(first)
    assert.deepEqual(await invariants(world), [])
    await world.flusher.endSave(first)
    assert.deepEqual(await invariants(world), ['I3'])
})

test('I4 and I5 see a picker opened without activation or during an import', async () => {
    const world = await createWorld()
    const opening = {
        name: 'x',
        activation: true,
        importing: false,
        importPending: false,
        dialogOpen: false,
    }
    world.openings.push({ ...opening, activation: false })
    world.openings.push({ ...opening, importing: true })
    world.openings.push({ ...opening, importPending: true })
    assert.deepEqual(await invariants(world), ['I4', 'I5', 'I5'])
})

test('I6 sees a dialog under the lock, a Preparing left open, and a lock left held', async () => {
    const world = await createWorld()
    world.dialogs.push({ kind: 'refused', args: [], lockHeld: true })
    world.dialogs.push({ kind: 'saved', args: [], lockHeld: true })
    world.preparing.push({ name: 'x', open: true, controller: new AbortController() })
    const holder = world.otherTab('exclusive')
    await holder.got
    assert.deepEqual(await invariants(world), ['I6', 'I6'])
    holder.release()
    await holder.done
    // Our own lock held at the end.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const mine = world.mock.locks.request('nse-bind', { mode: 'exclusive' }, () => held)
    await world.until(() => world.lockHeld(), 'our lock')
    assert.deepEqual(await invariants(world), ['I6', 'I6', 'I6'])
    release()
    await mine
})

test('I7, I8 and a thrown flow are seen', async () => {
    const world = await createWorld()
    localStorage.setItem('sonolus-next-sekai-editor.saving.chain-own', '{}')
    assert.deepEqual(await invariants(world, { unwritten: true }), ['I7'])
    assert.deepEqual(await invariants(world), [])
    world.writes.push({ name: 'x', exclusive: true, shared: false, picked: false })
    world.errors.push(new Error('boom'))
    assert.deepEqual(await invariants(world, { cancelled: true }), ['I8', 'flow threw'])
})

test('the baseline cells reach their picker and write, and a Save cancelled in its dialog does not', async () => {
    const byId = (id: string) => PATHS.find((p) => p.id === id)!
    const none = FAULTS.find((f) => f.id === 'none')!
    const dismissed = FAULTS.find((f) => f.id === 'dialog-cancelled')!
    for (const id of ['save-as', 'separate', 'notfound-saveas', 'save-to-file', 'export']) {
        const result = await runCell(byId(id), { id: 'unknown', picks: ['unknown'] }, none)
        assert.deepEqual(
            result.violations.map((v) => v.invariant).filter((x) => x !== 'info:emptied'),
            [],
            id,
        )
        assert.match(result.outcome, /\| unknown\.nxsp \|/, `${id} wrote the picked file`)
    }
    const result = await runCell(byId('save-as'), { id: 'dismiss', picks: ['dismiss'] }, dismissed)
    assert.deepEqual(result.violations, [])
    assert.equal(result.outcome.split(' | ')[1], '')
    assert.ok(FILES.dismiss)
    void startsWith
    void bytesOf
})

test('I9 sees a file bound to two chains, or bound and another chain’s Export target, unless a revocation is pending', async () => {
    const world = await createWorld()
    // The detector reads the store; these rows stand in for what a bug would have stored.
    const rows = new Map<string, Record<string, unknown>>()
    for (const row of await world.storedChains()) rows.set(String(row.chainId), row)
    const put = (id: string, row: Record<string, unknown>) => rows.set(id, row)
    world.storedChains = async () => [...rows.values()]
    assert.deepEqual(await invariants(world), [])
    const own = rows.get('chain-own')!
    const other = rows.get('chain-other')!
    put('chain-other', {
        ...other,
        file: { ...(other.file as object), name: 'own.nxsp' },
    })
    assert.deepEqual(await invariants(world), ['I9'])
    // R11: storage could not take the revocation of that binding, so it is kept for later.
    const { writeRevocation } = await import('../../../src/editor/save/env')
    const file = rows.get('chain-other')!.file as { name: string; at: number }
    writeRevocation('chain-other', { by: 'chain-own', at: 5, name: file.name, fileAt: file.at })
    assert.deepEqual(await invariants(world), [])
    put('chain-other', other)
    localStorage.clear()
    put('chain-own', {
        ...own,
        file: { ...(own.file as object), name: 'target.nsld' },
    })
    assert.deepEqual(await invariants(world), ['I9'])
})

test('the door hands out a new handle object on every read, and stores nothing for a faulted call', async () => {
    const world = await createWorld()
    const picked = world.handle('own.nxsp')
    const read = (await world.worker.call('readHandle', {
        chainId: 'chain-own',
        role: 'file',
    })) as FileSystemFileHandle
    const again = (await world.worker.call('readHandle', {
        chainId: 'chain-own',
        role: 'file',
    })) as FileSystemFileHandle
    assert.notEqual(read, picked)
    assert.notEqual(read, again)
    assert.equal(await read.isSameEntry(picked), true)
    assert.equal(await picked.isSameEntry(read), true)

    // E-4: the fault fires before the handler, so nothing is stored.
    world.behaviour.set('takeOver', () => 'throw')
    const before = JSON.stringify(await world.worker.call('readChainRecord', 'chain-other'))
    await assert.rejects(
        world.worker.call('takeOver', {
            owner: {
                chainId: 'chain-other',
                role: 'file',
                name: 'other.nxsp',
                at: 2000,
                handle: true,
            },
            by: 'chain-own',
            at: 5,
        }),
        /takeOver #1/,
    )
    assert.equal(JSON.stringify(await world.worker.call('readChainRecord', 'chain-other')), before)
    assert.ok(world.handleRows.has('chain-other:file'))
})
