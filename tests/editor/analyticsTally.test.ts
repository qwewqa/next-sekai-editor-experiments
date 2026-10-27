import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isValidEvent } from '../../src/analytics/catalogue'
import * as tally from '../../src/analytics/tally'
import { viewportDetails } from '../../src/analytics/viewport'

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

test("a press counts once: a nested command and a held key's repeats are not counted", () => {
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
        'peek.peek.25-50': 2,
        'peek.peek.1k-2k': 1,
        'peek.peek.cached': 1,
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

test('a watcher hears the page become busy and stop being busy, not each nested flow', () => {
    const changes: boolean[] = []
    tally.watchBusy((busy) => changes.push(busy))
    tally.busy(true)
    tally.busy(true)
    tally.busy(false)
    tally.busy(false)
    tally.watchBusy(undefined)
    tally.busy(true)
    tally.busy(false)
    assert.deepEqual(changes, [true, false])
})

test('a recorded event takes its time from the moment the action began', () => {
    tally.enable()
    tally.record('check', { outcome: 'ok' }, performance.now() - 250)
    tally.record('check', { outcome: 'ok' })
    const [first, second] = tally.collect().recorded
    assert.ok(Number(first?.data.took) >= 250)
    assert.equal('took' in (second?.data ?? {}), false)
})

test('a recorded event keeps the device as it was when the action ended, and none if there was no reader', () => {
    tally.enable()
    tally.record('open', { outcome: 'done' })
    let width = 800
    tally.watchDevice((name) => (name === 'preview' ? undefined : { viewport: width }))
    tally.record('save', { outcome: 'done' })
    width = 1600
    tally.record('preview', { host: 'main' })
    tally.record('export', { outcome: 'done' })
    const devices = tally.collect().recorded.map(({ name, device }) => [name, device])
    assert.deepEqual(devices, [
        ['open', undefined],
        ['save', { viewport: 800 }],
        ['preview', undefined],
        ['export', { viewport: 1600 }],
    ])
    tally.watchDevice(undefined)
})

test('an action finished before the client loads keeps the window it ended in', () => {
    // start.ts installs the reader with the counting, so a resize before the client loads and
    // sends the report does not change what the action recorded.
    tally.enable()
    let width = 1200
    tally.watchDevice(() => ({ viewport: width }))
    tally.record('open', { outcome: 'done' })
    width = 480
    assert.deepEqual(tally.collect().recorded[0]?.device, { viewport: 1200 })
    tally.watchDevice(undefined)
})

test('an event after a resize to portrait carries the new ranges and an aspect below 1', () => {
    tally.enable()
    let size = { width: 1440, height: 900 }
    tally.watchDevice(() => viewportDetails(size.width, size.height))
    tally.record('save', { outcome: 'done' })
    size = { width: 500, height: 900 }
    tally.record('save', { outcome: 'done' })
    const [landscape, portrait] = tally.collect().recorded.map(({ device }) => device)
    assert.deepEqual(landscape, {
        viewport: '1440-1920',
        viewportHeight: '900-1080',
        viewportAspect: '1.45-1.7',
    })
    assert.deepEqual(portrait, {
        viewport: '480-640',
        viewportHeight: '900-1080',
        viewportAspect: '0.5-0.65',
    })
    assert.ok(isValidEvent('save', { outcome: 'done', ...portrait }))
    tally.watchDevice(undefined)
})

test('the aspect edge at 1 is exact, and a size that is not a number sends nothing', () => {
    assert.equal(viewportDetails(799, 800).viewportAspect, '0.85-1')
    assert.equal(viewportDetails(800, 800).viewportAspect, '1-1.15')
    assert.equal(viewportDetails(801, 800).viewportAspect, '1-1.15')
    assert.equal(viewportDetails(300, 1440).viewportHeight, '1440+')
    assert.equal(viewportDetails(300, 500).viewportHeight, '500-600')
    assert.deepEqual(viewportDetails(400, 399.5), {
        viewport: '400-480',
        viewportHeight: '<400',
        viewportAspect: '1-1.15',
    })
    assert.deepEqual(viewportDetails(Number.NaN, 700), { viewportHeight: '600-768' })
    assert.deepEqual(viewportDetails(700, 0), { viewport: '640-768', viewportHeight: '<400' })
    assert.deepEqual(viewportDetails(-1, Number.NaN), {})
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
