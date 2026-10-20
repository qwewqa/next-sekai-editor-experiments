import assert from 'node:assert/strict'
import test from 'node:test'
import { ringEntries } from '../../src/diagnostics'
import { notifyFlusherStart, onFlusherStart } from '../../src/local/flusherStart'

test('a start listener that throws is recorded and stops neither the others nor the caller', () => {
    const calls: string[] = []
    onFlusherStart(() => calls.push('first'))
    onFlusherStart(() => {
        calls.push('throws')
        throw new Error('listener failure')
    })
    onFlusherStart(() => calls.push('last'))
    const before = ringEntries().length
    assert.doesNotThrow(() => notifyFlusherStart())
    assert.deepEqual(calls, ['first', 'throws', 'last'])
    assert.ok(ringEntries().length > before)
    assert.match(ringEntries().at(-1)?.text ?? '', /listener failure/)
    // Each runs once.
    notifyFlusherStart()
    assert.deepEqual(calls, ['first', 'throws', 'last'])
})

test('a cancelled start listener does not run', () => {
    let ran = false
    const cancel = onFlusherStart(() => (ran = true))
    cancel()
    notifyFlusherStart()
    assert.equal(ran, false)
})
