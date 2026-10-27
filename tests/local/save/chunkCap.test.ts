import assert from 'node:assert/strict'
import test from 'node:test'
import { CHUNK_CAP } from '../../../src/local/chunkVerify'
import { Fixture, save, stateAt } from './fixture'

// A chunk the reader would refuse to inflate (past CHUNK_CAP) is never written, since the file
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

test("a stored chunk past the reader's cap is refused, not written", async () => {
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

test("a pending chunk past the reader's cap is refused, not written", async () => {
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
