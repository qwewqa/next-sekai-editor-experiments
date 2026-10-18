import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateSaveSize } from '../../../src/local/save/estimate'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { sampleState } from '../records/samples'
import { Fixture, save } from './fixture'

// The size preview on the generated large chart (Part 1 §1.11.6, "The size preview"): the total
// within 25% of the written file, with History and without. `npm test` runs 30 steps;
// NSE_LONG_SAVE=1 runs the plan's 1,800.

const widen = (state: State, n: number) => {
    const notes = [...state.store.slides.note.values()].flat()
    const target = notes[(n * 7919) % notes.length]
    assert.ok(target)
    const transaction = createTransaction(state)
    replaceNote(transaction, target, { ...target, size: target.size + 0.25 })
    return transaction.commit([])
}

test('the estimate on the generated large chart is within 25% of the file', async () => {
    const steps = process.env.NSE_LONG_SAVE ? 1800 : 30
    const fixture = await Fixture.create()
    let state = sampleState('tests/fixtures/generated-large.json')
    await fixture.start(state)
    for (let k = 1; k < steps; k++) {
        state = widen(state, k)
        await fixture.editState(state, `Edit ${k}`)
    }
    await fixture.flush()
    const estimate = await estimateSaveSize(fixture.store, fixture.chainId)
    assert.ok(estimate)
    const { file } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok(file)
    const ratio = (estimate.base + estimate.history) / file.size
    assert.ok(ratio > 0.75 && ratio < 1.25, `${JSON.stringify(estimate)} for ${file.size}`)
    const { file: bare } = await save(
        fixture,
        { kind: 'copy' },
        { binds: false, extra: { history: false } },
    )
    assert.ok(bare)
    const without = estimate.base / bare.size
    assert.ok(without > 0.75 && without < 1.25, `${estimate.base} for ${bare.size}`)
})
