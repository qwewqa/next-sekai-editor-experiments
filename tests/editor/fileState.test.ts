import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileChanged } from '../../src/editor/file/state'
import { createSessionDescriptor, session } from '../../src/history/session'
import {
    liveState,
    redoState,
    resetStates,
    restoreStates,
    setSlotLoader,
} from '../../src/history/stack'
import { editStep, initialLife, initialStep } from '../helpers/historySteps'
import { goldenChart, stateOf } from '../local/records/charts'

const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const root = (n: number) => new Uint8Array(32).fill(n)

test('an open whose head is not the file never reads as unchanged', () => {
    const first = stateOf(goldenChart())
    resetStates({ state: first, step: initialStep(), isDirty: false })
    // The file holds the root of slot 0; the head (slot 1) has the same content as the session
    // that was open before, but is not the file.
    session.value = createSessionDescriptor({
        sessionId: 'opened',
        file: { name: 'f.nxsp', event: 'opened', hash: hex(root(7)) },
    } as never)
    const head = { ...first }
    restoreStates(
        [
            { step: initialStep(), snapshot: root(7), isDirty: false },
            { step: editStep(initialLife(1, 2)), snapshot: root(9), isDirty: true },
        ],
        1,
        head,
    )
    assert.equal(liveState.value, head)
    assert.equal(fileChanged.value, true)
})

test('presses queued across the unloaded file slot never read as unchanged', async () => {
    const s0 = stateOf(goldenChart())
    const sA = { ...s0, initialLife: s0.initialLife + 1 }
    const s3 = { ...sA }
    session.value = createSessionDescriptor({
        sessionId: 'queued',
        file: { name: 'g.nxsp', event: 'opened', hash: hex(root(2)) },
    } as never)
    restoreStates(
        [
            { step: initialStep(), snapshot: root(0), isDirty: false },
            { step: editStep(initialLife(1, 2)), snapshot: root(1), isDirty: true },
            { step: editStep(initialLife(2, 3)), snapshot: root(2), isDirty: true },
            { step: editStep(initialLife(3, 2)), snapshot: root(3), isDirty: true },
        ],
        0,
        s0,
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    // The file's slot (root 2) never loads; the presses pass over it.
    setSlotLoader(async (snapshot) => {
        if (snapshot[0] === 2) return new Promise<never>(() => undefined)
        await gate
        return snapshot[0] === 1 ? sA : s3
    })
    try {
        redoState()
        redoState()
        redoState()
        release()
        await new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(liveState.value, s3)
        assert.equal(fileChanged.value, true)
    } finally {
        setSlotLoader(undefined)
    }
})
