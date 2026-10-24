import assert from 'node:assert/strict'
import test from 'node:test'
import { writeMeta } from '../../src/local/db'
import { openLocalData } from '../../src/local/testing/db'
import { CI_SEEDS, createWorld } from '../../src/local/testing/world'
import { clampTime, DAY_MS, nextTime, stampNow } from '../../src/local/time'
import { onFlushCommitted, runFlushHooks } from '../../src/local/worker/flushHooks'

// Strictly increasing now, and the post-flush hook point.

test('now never repeats across two tabs, with the clock held back', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const tabs = [world.tab('a'), world.tab('b')]
        const dbs = await Promise.all(tabs.map((tab) => openLocalData(tab)))
        const stamps: number[] = []
        const frozen = 1_000_000
        await Promise.all(
            tabs.map((tab, i) =>
                tab.run(async () => {
                    for (let n = 0; n < 5; n++)
                        stamps.push(
                            await dbs[i]!.transaction(['meta'], 'readwrite', (tx) =>
                                stampNow(tx, frozen - n * 1000),
                            ),
                        )
                }),
            ),
        )
        assert.equal(new Set(stamps).size, 10, `seed ${seed}`)
        assert.deepEqual(
            [...stamps].sort((a, b) => a - b),
            Array.from({ length: 10 }, (_, i) => frozen + i),
        )
        await world.idle()
    }
})

test('a later clock is taken as it is; a time far ahead from elsewhere is clamped', async () => {
    assert.equal(nextTime(10, 5), 11)
    assert.equal(nextTime(10, 50), 50)
    assert.equal(clampTime(100 + DAY_MS, 100), 100 + DAY_MS)
    assert.equal(clampTime(101 + DAY_MS, 100), 100)
    const world = createWorld({ seed: 1 })
    const tab = world.tab('a')
    const db = await openLocalData(tab)
    await tab.run(() =>
        db.transaction(['meta'], 'readwrite', (tx) => writeMeta(tx, 'maxSeenTime', 1000)),
    )
    const next = await tab.run(() =>
        db.transaction(['meta'], 'readwrite', (tx) => stampNow(tx, 900)),
    )
    assert.equal(next, 1001)
})

test('post-flush hooks run in order, and a failing hook fails nothing', async () => {
    const seen: string[] = []
    const off = [
        onFlushCommitted(() => {
            seen.push('first')
            throw new Error('hook')
        }),
        onFlushCommitted(async (flush) => {
            seen.push(`second ${flush.session.id}`)
        }),
    ]
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
        await runFlushHooks({
            session: { id: 's', chainId: 'c' },
            entries: [],
            stackBlocks: [],
            records: [],
            media: [],
            descriptorChanged: false,
        })
    } finally {
        console.error = original
        for (const remove of off) remove()
    }
    assert.deepEqual(seen, ['first', 'second s'])
    assert.equal(errors.length, 1)
})
