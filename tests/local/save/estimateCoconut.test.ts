import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { totalOf } from '../../../src/editor/save/total'
import { estimateSaveSize } from '../../../src/local/save/estimate'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { sampleState } from '../records/samples'
import { Fixture, save } from './fixture'

// The size preview on the coconut level (AUD-A-10): the generated large chart deflates its
// `level.json` to 0.21 of the canonical bytes and coconut to 0.16, so a ratio fixed on the first
// ran 12 to 28% high on the second. The level is not in the repository (test_level_data/).

const LEVEL = 'test_level_data/coconut-next-sekai-24887.json'

const widen = (state: State, n: number) => {
    const notes = [...state.store.slides.note.values()].flat()
    const target = notes[(n * 7919) % notes.length]
    assert.ok(target)
    const transaction = createTransaction(state)
    replaceNote(transaction, target, { ...target, size: target.size + 0.25 })
    return transaction.commit([])
}

for (const steps of [3, 30]) {
    test(
        `the estimate on coconut with ${steps} steps is within 15% of the file, with History and without`,
        { skip: !existsSync(LEVEL) },
        async () => {
            const fixture = await Fixture.create()
            let state = sampleState(LEVEL)
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
            const ratio = totalOf(estimate, { history: true, bgm: false })! / file.size
            assert.ok(ratio > 0.85 && ratio < 1.15, `${JSON.stringify(estimate)} for ${file.size}`)
            const { file: bare } = await save(
                fixture,
                { kind: 'copy' },
                { binds: false, extra: { history: false } },
            )
            assert.ok(bare)
            const without = totalOf(estimate, { history: false, bgm: false })! / bare.size
            assert.ok(without > 0.85 && without < 1.15, `${estimate.base} for ${bare.size}`)
        },
    )
}
