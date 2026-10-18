import assert from 'node:assert/strict'
import test from 'node:test'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { coconutPath, hasCoconut, sampleState } from '../records/samples'
import { Fixture, save, sourceOf } from './fixture'

// The long-chain Save budget rows of Part 1 §1.9.3, measured on the writer in Node (checks, not
// gates; `NSE_BUDGETS=1`): a Save that downloads (no base file) and a write-back appending to a
// bound file, for coconut with 1,800 steps and for a 20-hour chain of about 20,000 steps. The
// 20-hour chain's steps are small synthetic bodies over coconut, so its chunks are lighter than a
// real one's. Timings print; nothing fails on them.

const widen = (state: State, n: number) => {
    const notes = [...state.store.slides.note.values()].flat()
    const target = notes[(n * 7919) % notes.length]
    assert.ok(target)
    const transaction = createTransaction(state)
    replaceNote(transaction, target, { ...target, size: target.size + 0.25 })
    return transaction.commit([])
}

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const timed = async <T>(run: () => Promise<T>) => {
    const start = performance.now()
    const value = await run()
    return { value, ms: Math.round(performance.now() - start) }
}

const measure = async (name: string, fixture: Fixture) => {
    await fixture.flush()
    const download = await timed(() => save(fixture, { kind: 'copy' }, { binds: false }))
    assert.ok(download.value.file)
    const bound = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(bound.file)
    await fixture.edit(999_999)
    await fixture.flush()
    const source = await sourceOf(bound.file)
    const writeBack = await timed(() =>
        save(fixture, { kind: 'append', source: 'target' }, { files: [source], disk: diskOf }),
    )
    assert.ok(writeBack.value.file)
    console.log(
        `${name}: download build ${download.ms} ms (${download.value.file.size} B); ` +
            `write-back ${writeBack.ms} ms (${writeBack.value.file.size} B)`,
    )
}

test(
    'the long-chain Save budgets, measured',
    { skip: !process.env.NSE_BUDGETS || !hasCoconut },
    async () => {
        const coconut = sampleState(coconutPath)

        const steps1800 = await Fixture.create()
        let state = coconut
        await steps1800.start(state)
        for (let k = 1; k < 1800; k++) {
            state = widen(state, k)
            await steps1800.editState(state, `Edit ${k}`)
        }
        await measure('coconut, 1,800 steps', steps1800)

        const hours20 = await Fixture.create()
        await hours20.start(coconut)
        for (let k = 1; k < 20_000; k++) await hours20.edit(k)
        await measure('20-hour chain, 20,000 steps', hours20)
    },
)
