import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enqueueSave, exclusive } from '../../../src/editor/save/queue'

// Saves in a tab run one at a time, in press order (spec B invariant 9). The old queue held one
// running Save and one waiting, and dropped every press after those.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A run that logs its start and end, and takes `ms`. */
const run =
    (log: string[], name: string, ms = 5) =>
    async () => {
        log.push(`${name}>`)
        await sleep(ms)
        log.push(`<${name}`)
    }

/** `console.error('A Save failed')` is the queue's report of a run that threw. */
const quiet = async <T>(body: () => Promise<T>) => {
    const real = console.error
    const reported: unknown[] = []
    console.error = (...args: unknown[]) => {
        if (args[0] === 'A Save failed') reported.push(args[1])
        else real(...args)
    }
    try {
        return { value: await body(), reported }
    } finally {
        console.error = real
    }
}

test('Saves of different commands run one after another, in press order, none dropped', async () => {
    const log: string[] = []
    await Promise.all([
        exclusive('a', run(log, 'a', 20)),
        exclusive('b', run(log, 'b')),
        exclusive('c', run(log, 'c')),
        exclusive('d', run(log, 'd')),
    ])
    assert.deepEqual(log, ['a>', '<a', 'b>', '<b', 'c>', '<c', 'd>', '<d'])
})

test('a press that has not started joins an earlier one of the same command', async () => {
    const log: string[] = []
    const first = exclusive('save', run(log, 'first', 20))
    await sleep(1)
    const queued = exclusive('save', run(log, 'second'))
    const joined = exclusive('save', run(log, 'third'))
    assert.equal(joined, queued, 'the third press is the second')
    await Promise.all([first, queued, joined])
    assert.deepEqual(log, ['first>', '<first', 'second>', '<second'])
    // Once it has started, a press of the command queues behind it, as one more.
    const again: string[] = []
    const a = exclusive('save', run(again, 'a', 20))
    await sleep(1)
    await Promise.all([a, exclusive('save', run(again, 'b'))])
    assert.deepEqual(again, ['a>', '<a', 'b>', '<b'])
})

test('a queued Save is never joined', async () => {
    const log: string[] = []
    await Promise.all([
        enqueueSave(run(log, 'one', 10)),
        enqueueSave(run(log, 'two')),
        enqueueSave(run(log, 'three')),
    ])
    assert.deepEqual(log, ['one>', '<one', 'two>', '<two', 'three>', '<three'])
})

test('a run that throws frees the queue, also when it throws before its first await', async () => {
    const log: string[] = []
    const { reported } = await quiet(() =>
        Promise.all([
            exclusive('a', () => Promise.reject(new Error('rejected'))),
            exclusive('b', () => {
                throw new Error('thrown')
            }),
            exclusive('c', run(log, 'c')),
        ]),
    )
    assert.deepEqual(log, ['c>', '<c'])
    assert.deepEqual(
        reported.map((error) => (error as Error).message),
        ['rejected', 'thrown'],
    )
})
