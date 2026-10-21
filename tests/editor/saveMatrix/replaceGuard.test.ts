import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorld, flow, settle } from './world'

const { storageStatus } = await import('../../../src/local/startup/events')

// The Replace guard needs its read (Part 1 §1.4.7, spec D invariant 6): Replace is enabled only
// when `replaceDecision` was read, gave a decision, and the decision is not "holds earlier". A
// failed read or no decision used to leave Replace enabled, and the file on disk could be the only
// holder of earlier Timeline steps.

const reason = async (guard: (w: Awaited<ReturnType<typeof createWorld>>) => void) => {
    const w = await createWorld({ own: 'bound', storage: 'lacks', ownDisk: 'ahead' })
    // Storing works, so the dialog's own reason for a storage that cannot take the file is absent.
    storageStatus.value = { mode: 'stored' }
    guard(w)
    w.answers.conflict.push(undefined)
    await flow.save()
    await settle()
    assert.equal(w.conflictInputs.length, 1, 'the conflict dialog opened')
    return w.conflictInputs[0]!.replaceDisabled?.()
}

const MAY = /^It may hold earlier Timeline steps/
const HOLDS = /^It holds earlier Timeline steps/

test('Replace guard: a decision that finds nothing missing leaves Replace enabled (control)', async () => {
    assert.equal(await reason(() => undefined), undefined)
})

test('Replace guard: a decision that the chain holds fewer rows disables Replace, definitely (control)', async () => {
    const text = await reason((w) => {
        w.decision.value = { relation: 'unrelated', holdsBase: 'missing' }
    })
    assert.match(String(text), HOLDS)
})

test('Replace guard: a read that fails disables Replace with the uncertain reason', async () => {
    const text = await reason((w) => w.behaviour.set('replaceDecision', () => 'throw'))
    assert.match(String(text), MAY)
})

test('Replace guard: no decision disables Replace with the uncertain reason', async () => {
    const text = await reason((w) => {
        w.decision.value = undefined
    })
    assert.match(String(text), MAY)
})
