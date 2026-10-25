import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as tally from '../../src/analytics/tally'

// The page the arming listener needs: listeners by type, and the visibility.
const listeners = new Map<string, (event: Event) => void>()
const page = { visibilityState: 'visible' }
Object.assign(globalThis, {
    window: {
        addEventListener: (type: string, listener: (event: Event) => void) => {
            listeners.set(type, listener)
        },
        removeEventListener: (type: string) => {
            listeners.delete(type)
        },
    },
    document: page,
})

afterEach(() => {
    tally.disable()
})

const counts = () => Object.fromEntries(tally.collect().counts)

test('while off, nothing is counted or recorded', () => {
    tally.bump('notices.error')
    tally.bumpCommand('save', 'key')
    tally.record('check', { outcome: 'ok' })
    tally.enable()
    const { counts, recorded } = tally.collect()
    assert.equal(counts.size, 0)
    assert.equal(recorded.length, 0)
})

test('a press counts once: a nested command and a held key’s repeats are not counted', () => {
    tally.enable()
    tally.bumpCommand('save', 'key')
    tally.bumpCommand('save', 'key')
    tally.bumpCommand('cameraEvent', 'nested')
    tally.bumpCommand('scrollDown', 'repeat')
    tally.bumpCommand('zoomXIn', 'wheel')
    tally.bumpCommand('zoomXIn', 'wheel')
    assert.deepEqual(counts(), { 'usage.save.key': 2, 'usage.zoomXIn.wheel': 1 })
    // The wheel counts once a visit, not once a send.
    tally.bumpCommand('zoomXIn', 'wheel')
    assert.deepEqual(counts(), {})
})

test('counts are deltas since the last take, capped at 9999', () => {
    tally.enable()
    tally.bump('notices.info', 10_500)
    assert.deepEqual(counts(), { 'notices.info': 9999 })
    tally.bump('notices.info')
    assert.deepEqual(counts(), { 'notices.info': 1 })
})

test('at most KEY_LIMIT counters, and USAGE_LIMIT of them usage', () => {
    tally.enable()
    for (let i = 0; i <= tally.USAGE_LIMIT; i++) tally.bump(`usage.command${i}.key`)
    for (let i = 0; i <= tally.KEY_LIMIT; i++) tally.bump(`edits.op${i}`)
    const all = tally.collect().counts
    assert.equal(all.size, tally.KEY_LIMIT)
    assert.equal(
        [...all.keys()].filter((key) => key.startsWith('usage.')).length,
        tally.USAGE_LIMIT,
    )
    assert.equal(all.get('usage.command0.key'), 1)
    assert.equal(all.has(`usage.command${tally.USAGE_LIMIT}.key`), false)
})

test('at most RECORD_LIMIT events wait for the client', () => {
    tally.enable()
    for (let i = 0; i <= tally.RECORD_LIMIT; i++) tally.record('check', { outcome: 'ok' })
    assert.equal(tally.collect().recorded.length, tally.RECORD_LIMIT)
})

test('turning off forgets what was counted', () => {
    tally.enable()
    tally.bump('notices.warning')
    tally.disable()
    tally.enable()
    assert.deepEqual(counts(), {})
})

test('a count stops at the cap however many bumps follow', () => {
    tally.enable()
    for (let i = 0; i < 20_000; i++) tally.bumpCommand('save', 'key')
    assert.equal(tally.collect().counts.get('usage.save.key'), 9999)
})

test('the first trusted input on a visible page arms the visit, and the listener goes', () => {
    assert.equal(tally.armedTime(), undefined)
    let armed = 0
    const stop = tally.onArmed(() => armed++)
    tally.enable()
    assert.deepEqual([...listeners.keys()].sort(), [
        'keydown',
        'pointerdown',
        'touchstart',
        'wheel',
    ])
    const input = listeners.get('pointerdown')!
    input({ isTrusted: false } as Event)
    page.visibilityState = 'hidden'
    input({ isTrusted: true } as Event)
    page.visibilityState = 'visible'
    assert.equal(armed, 0, 'an untrusted input, and one while hidden')
    input({ isTrusted: true } as Event)
    assert.equal(armed, 1)
    assert.notEqual(tally.armedTime(), undefined)
    assert.equal(listeners.size, 0)
    stop()
    // An armed visit stays armed, and waits for no input again.
    tally.disable()
    tally.enable()
    assert.equal(listeners.size, 0)
})

test('a Timeline step shown counts as a peek, with its time as a range or as cached', () => {
    tally.enable()
    tally.peekShown(30)
    tally.peekShown(30)
    tally.peekShown(1200)
    tally.peekShown(undefined)
    assert.deepEqual(counts(), {
        'features.peek': 4,
        'perf.peek.<50': 2,
        'perf.peek.1k-2k': 1,
        'perf.peek.cached': 1,
    })
})

test('startup is marked once, with its outcome and whether the page was ever hidden', () => {
    tally.markStartup('done')
    assert.equal(tally.startup(), undefined, 'while off')
    tally.enable()
    page.visibilityState = 'hidden'
    tally.markStartup('slow')
    page.visibilityState = 'visible'
    tally.markStartup('error')
    const started = tally.startup()
    assert.equal(started?.outcome, 'slow')
    assert.equal(started?.hidden, true)
    assert.ok((started?.at ?? 0) > 0)
})

test('flows mark the page busy and not busy again, never below none', () => {
    tally.busy(false)
    tally.busy(true)
    tally.busy(true)
    tally.busy(false)
    assert.equal(tally.isBusy(), true)
    tally.busy(false)
    assert.equal(tally.isBusy(), false)
})

test('a recorded event takes its time from the moment the action began', () => {
    tally.enable()
    tally.record('check', { outcome: 'ok' }, performance.now() - 250)
    tally.record('check', { outcome: 'ok' })
    const [first, second] = tally.collect().recorded
    assert.ok(Number(first?.data.took) >= 250)
    assert.equal('took' in (second?.data ?? {}), false)
})

test('a chart that opened, restored or saved waits for the client, once per trigger', () => {
    tally.chartChanged('open')
    assert.equal(tally.hasCharts(), false, 'while off')
    tally.enable()
    let asked = 0
    tally.watchCharts(() => asked++)
    tally.chartChanged('open')
    tally.chartChanged('open')
    tally.chartChanged('save')
    assert.equal(asked, 3)
    assert.deepEqual(tally.takeCharts(), ['open', 'save'])
    assert.equal(tally.hasCharts(), false)
    tally.watchCharts(undefined)
})

test('facts noted for the start events are forgotten when the statistics go off', () => {
    tally.enable()
    tally.note('reload')
    assert.equal(tally.wasNoted('reload'), true)
    tally.disable()
    assert.equal(tally.wasNoted('reload'), false)
})
