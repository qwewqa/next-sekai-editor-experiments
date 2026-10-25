import assert from 'node:assert/strict'
import test from 'node:test'
import { CHUNK_CAP } from '../../../src/local/chunkVerify'
import { readNxsp } from '../../../src/local/nxsp'
import { Fixture, save, stateAt } from './fixture'

// A chunk the reader would refuse to inflate (past CHUNK_CAP) must never be written: the file
// would open with its history unreadable. The Save refuses it as it does any reader cap.

/** The state with a group name long enough that its header chunk inflates past the cap. */
const oversized = () => {
    const { state } = stateAt(0)
    const [id, group] = [...state.groups][0]!
    return {
        ...state,
        groups: new Map(state.groups).set(id, { ...group, name: 'a'.repeat(CHUNK_CAP) }),
    }
}

const refusal = (built: Awaited<ReturnType<typeof save>>['built']) => {
    assert.ok('refused' in built, 'the Save wrote the file')
    return built as { refused: string; limit?: string }
}

test('a stored chunk past the reader’s cap is refused, not written', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.editState(oversized(), { id: 'big' })
    await fixture.flush()
    const { built, file } = await save(fixture, { kind: 'copy' })
    assert.equal(file, undefined)
    assert.deepEqual(
        { refused: refusal(built).refused, limit: refusal(built).limit },
        { refused: 'plan', limit: 'chunks' },
    )
})

test('a pending chunk past the reader’s cap is refused, not written', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.editState(oversized(), { id: 'big' })
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { extra: { pending: fixture.pending(0) } },
    )
    assert.equal(file, undefined)
    assert.equal(refusal(built).limit, 'chunks')
})

test('a chunk under the cap is written and reads fully', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    const small = stateAt(0).state
    const [id, group] = [...small.groups][0]!
    // Names below the cap by far still pass: the boundary is the chunk's inflated length.
    await fixture.editState(
        { ...small, groups: new Map(small.groups).set(id, { ...group, name: 'a'.repeat(1024) }) },
        { id: 'small' },
    )
    await fixture.flush()
    const { built, file } = await save(fixture, { kind: 'copy' })
    assert.ok(!('refused' in built) && file)
    const read = await readNxsp(file)
    assert.equal(read.kind, 'nxsp')
    assert.ok(read.kind === 'nxsp' && read.history && !read.report.length)
})
