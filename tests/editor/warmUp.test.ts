import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWarmUp, type WarmUpEnv } from '../../src/editor/warmUp.ts'

// The warm-up waits for startup, loads one group per idle slot, skips on Save-Data and drops
// failures.

const setup = (overrides: Partial<WarmUpEnv> = {}) => {
    const idleSlots: (() => void)[] = []
    let ended!: () => void
    const startupEnded = new Promise<void>((resolve) => {
        ended = resolve
    })
    const env: WarmUpEnv = {
        startupEnded: () => startupEnded,
        idle: (run) => idleSlots.push(run),
        saveData: () => false,
        ...overrides,
    }
    return { env, idleSlots, ended }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('nothing loads, or waits for idle, before startup ends', async () => {
    const loaded: string[] = []
    const { env, idleSlots, ended } = setup()
    const done = runWarmUp([[() => Promise.resolve(loaded.push('a'))]], env)
    await settle()
    assert.deepEqual(loaded, [])
    assert.equal(idleSlots.length, 0)
    ended()
    await settle()
    assert.deepEqual(loaded, [])
    assert.equal(idleSlots.length, 1)
    idleSlots[0]?.()
    await done
    assert.deepEqual(loaded, ['a'])
})

test('a group loads in each idle slot, in order, all of its modules together', async () => {
    const loaded: string[] = []
    const load = (name: string) => () => Promise.resolve(loaded.push(name))
    const { env, idleSlots, ended } = setup()
    const done = runWarmUp([[load('a1'), load('a2')], [load('b')], [load('c')]], env)
    ended()
    await settle()
    assert.equal(idleSlots.length, 1)
    idleSlots[0]?.()
    await settle()
    assert.deepEqual(loaded, ['a1', 'a2'])
    assert.equal(idleSlots.length, 2)
    idleSlots[1]?.()
    await settle()
    assert.deepEqual(loaded, ['a1', 'a2', 'b'])
    idleSlots[2]?.()
    await done
    assert.deepEqual(loaded, ['a1', 'a2', 'b', 'c'])
})

test('Save-Data skips the warm-up', async () => {
    const loaded: string[] = []
    const { env, idleSlots, ended } = setup({ saveData: () => true })
    ended()
    await runWarmUp([[() => Promise.resolve(loaded.push('a'))]], env)
    assert.deepEqual(loaded, [])
    assert.equal(idleSlots.length, 0)
})

test('a failed load is dropped and the next group still loads', async () => {
    const loaded: string[] = []
    const { env, idleSlots, ended } = setup()
    const done = runWarmUp(
        [
            [() => Promise.reject(new Error('gone')), () => Promise.resolve(loaded.push('a'))],
            [() => Promise.resolve(loaded.push('b'))],
        ],
        env,
    )
    ended()
    await settle()
    idleSlots[0]?.()
    await settle()
    idleSlots[1]?.()
    await done
    assert.deepEqual(loaded, ['a', 'b'])
})
