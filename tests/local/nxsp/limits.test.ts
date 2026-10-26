import assert from 'node:assert/strict'
import test from 'node:test'
import { maxBeat } from '../../../src/chart/limits'
import { executePlan, planNxsp, readNxsp } from '../../../src/local/nxsp'
import { addBpm } from '../../../src/state/mutations/bpm'
import { createTransaction } from '../../../src/state/transaction'
import { fresh } from './chain'

// The editor's chart limits apply to a file's History as to any stored records: a head past them
// is History that cannot be read, while the level, which is valid, still opens.

const fileWith = async (past: boolean) => {
    const { store, c, hashes, input } = fresh()
    const transaction = createTransaction(c)
    if (past) addBpm(transaction, { beat: maxBeat + 1, bpm: 120 })
    const head = store.add(transaction.commit([]))
    const history = input.history!
    const swap = <T extends { snapshot: string }>(item: T): T =>
        item.snapshot === hashes[2] ? { ...item, snapshot: head } : item
    const changed = {
        ...input,
        history: {
            ...history,
            entries: history.entries.map(swap),
            undoStack: { ...history.undoStack!, slots: history.undoStack!.slots.map(swap) },
        },
    }
    return readNxsp(await executePlan(planNxsp(changed).plan, new Map()))
}

test('a History head past the chart limits is unreadable History, and the level still opens', async () => {
    const whole = await fileWith(false)
    assert.ok(whole.kind === 'nxsp')
    assert.equal(whole.open, 'full')
    assert.ok(whole.history)

    const read = await fileWith(true)
    assert.ok(read.kind === 'nxsp')
    assert.equal(read.open, 'partial')
    assert.ok(read.report.some(({ reason }) => reason === 'history-unreadable'))
    assert.equal(read.history, undefined)
    assert.ok(read.level)
})
