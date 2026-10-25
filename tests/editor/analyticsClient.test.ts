import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldSend, type Inputs } from '../../src/analytics/config'
import {
    BYTE_LIMIT,
    createSender,
    QUEUE_LIMIT,
    REQUEST_LIMIT,
    SEND_INTERVAL,
    type Item,
} from '../../src/analytics/sender'

const on: Inputs = {
    target: { origin: 'https://stats.nse-services.qwewqa.dev', website: 'w' },
    fromTestKey: false,
    choice: null,
    signal: false,
    webdriver: false,
    hostname: 'nse.qwewqa.dev',
    site: 'production',
    safeMode: false,
    saveData: false,
}

test('a page sends only with a target, the switch on, and on its own host', () => {
    assert.ok(shouldSend(on))
    assert.ok(!shouldSend({ ...on, target: null }), 'no target')
    assert.ok(!shouldSend({ ...on, choice: false }), 'turned off')
    assert.ok(!shouldSend({ ...on, signal: true }), 'a browser signal, no choice')
    assert.ok(shouldSend({ ...on, signal: true, choice: true }), 'turned on despite a signal')
    assert.ok(!shouldSend({ ...on, safeMode: true }), 'safe mode')
    assert.ok(!shouldSend({ ...on, saveData: true }), 'save data')
    assert.ok(!shouldSend({ ...on, webdriver: true }), 'an automated browser')
    assert.ok(shouldSend({ ...on, webdriver: true, fromTestKey: true }), 'a spec’s mock')
    assert.ok(
        shouldSend({
            ...on,
            webdriver: true,
            target: { origin: 'http://127.0.0.1:5361', website: 'w' },
        }),
        'a perf run’s mock',
    )
    assert.ok(!shouldSend({ ...on, hostname: 'copy.example.com' }), 'a copy on another host')
    assert.ok(!shouldSend({ ...on, hostname: 'nse.qwewqa.dev', site: 'test' }), 'the wrong site')
    assert.ok(shouldSend({ ...on, hostname: 'test.nse.qwewqa.dev', site: 'test' }))
    assert.ok(shouldSend({ ...on, hostname: 'localhost' }))
    assert.ok(shouldSend({ ...on, hostname: '127.0.0.1' }))
})

const item = (name = 'visit', pad = ''): Item => ({
    type: 'event',
    payload: {
        website: 'w',
        hostname: 'nse.qwewqa.dev',
        screen: '1920x1080',
        language: 'en',
        url: '/',
        title: '',
        referrer: '',
        timestamp: 1_792_800_000,
        name,
        data: pad ? { pad } : {},
    },
})

type Call = { url: string; init?: RequestInit; body: string; resolve: (response: Response) => void }

/** A sender over a fake fetch whose responses the test gives, and a fake clock. */
const harness = ({ online = true, beacon = true } = {}) => {
    const calls: Call[] = []
    const beacons: string[] = []
    const env = { now: 0, online }
    const sender = createSender({
        url: 'https://stats.example/api/batch',
        fetch: (url, init) =>
            new Promise((resolve, reject) => {
                const call = { url, init, body: String(init.body), resolve }
                calls.push(call)
                init.signal?.addEventListener('abort', () => {
                    reject(new Error('timeout'))
                })
            }),
        sendBeacon: beacon
            ? (_url, body) => {
                  beacons.push(body)
                  return true
              }
            : undefined,
        onLine: () => env.online,
        now: () => env.now,
    })
    const answer = async (call: Call, processed: number, status = 200) => {
        call.resolve(new Response(JSON.stringify({ size: processed, processed }), { status }))
        // The response's body and the checks after it.
        for (let i = 0; i < 10; i++) await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
    }
    return { sender, calls, beacons, env, answer }
}

test('a send carries the queue and the summaries as one batch, as Umami reads it', async () => {
    const { sender, calls, answer } = harness()
    sender.add(item())
    sender.send('hidden', () => [item('notices')])
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call!.url, 'https://stats.example/api/batch')
    assert.deepEqual(
        { ...call!.init, body: undefined, signal: undefined },
        {
            method: 'POST',
            body: undefined,
            keepalive: true,
            mode: 'cors',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: { 'Content-Type': 'text/plain' },
            signal: undefined,
        },
    )
    const body = JSON.parse(call!.body) as Item[]
    assert.deepEqual(
        body.map((sent) => sent.payload.name),
        ['visit', 'notices'],
    )
    for (const sent of body) assert.equal(typeof sent.payload.timestamp, 'number')
    await answer(call!, 2)
    assert.ok(!sender.isStopped())
})

test('while the page is open, sends are a minute apart; pagehide sends anyway, by beacon', async () => {
    const { sender, calls, beacons, env, answer } = harness()
    sender.add(item())
    sender.send('hidden')
    await answer(calls[0]!, 1)
    sender.add(item())
    env.now = SEND_INTERVAL - 1
    sender.send('hidden')
    assert.equal(calls.length, 1, 'within the minute')
    env.now = SEND_INTERVAL
    sender.send('hidden')
    assert.equal(calls.length, 2, 'a minute later')
    sender.add(item())
    sender.send('leaving')
    assert.equal(beacons.length, 1, 'pagehide, with a request in flight and within the minute')
    assert.equal((JSON.parse(beacons[0]!) as Item[]).length, 1)
})

test('one request at a time while the page is open', () => {
    const { sender, calls, env } = harness()
    sender.add(item())
    sender.send('hidden')
    sender.add(item())
    env.now = 2 * SEND_INTERVAL
    sender.send('hidden')
    assert.equal(calls.length, 1)
})

test('offline, nothing is sent and the queue and summaries wait', () => {
    const { sender, calls, beacons, env } = harness({ online: false })
    let taken = 0
    sender.add(item())
    sender.send('hidden', () => [item('notices', String(++taken))])
    sender.send('leaving', () => [item('notices', String(++taken))])
    assert.equal(calls.length + beacons.length, 0)
    assert.equal(taken, 0, 'the summaries stay with the counters')
    env.online = true
    sender.send('hidden')
    assert.equal(calls.length, 1)
})

for (const [failure, respond] of [
    ['an error status', (call: Call) => call.resolve(new Response('{}', { status: 500 }))],
    [
        'fewer items processed',
        (call: Call) => call.resolve(new Response('{"size":1,"processed":0}', { status: 200 })),
    ],
    ['a body Umami would not send', (call: Call) => call.resolve(new Response('not json'))],
] as const)
    test(`${failure} stops sending for the visit and drops the queue`, async () => {
        const { sender, calls, beacons, env } = harness()
        sender.add(item())
        sender.send('hidden')
        respond(calls[0]!)
        await new Promise((resolve) => setImmediate(resolve))
        assert.ok(sender.isStopped())
        sender.add(item())
        env.now = 10 * SEND_INTERVAL
        sender.send('hidden')
        sender.send('leaving')
        assert.equal(calls.length + beacons.length, 1)
    })

test('a network error stops sending, and nothing rejects unhandled', async () => {
    const calls: number[] = []
    const sender = createSender({
        url: 'u',
        fetch: () => {
            calls.push(1)
            return Promise.reject(new TypeError('Failed to fetch'))
        },
        sendBeacon: undefined,
        onLine: () => true,
        now: () => 0,
    })
    sender.add(item())
    sender.send('hidden')
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(sender.isStopped())
})

test('a beacon the browser refuses stops sending', () => {
    const sender = createSender({
        url: 'u',
        fetch: () => Promise.reject(new Error('unused')),
        sendBeacon: () => false,
        onLine: () => true,
        now: () => 0,
    })
    sender.add(item())
    sender.send('leaving')
    assert.ok(sender.isStopped())
})

test('the queue holds at most QUEUE_LIMIT events and BYTE_LIMIT bytes', () => {
    const { sender, calls } = harness()
    for (let i = 0; i <= QUEUE_LIMIT; i++) sender.add(item())
    sender.send('hidden')
    assert.equal((JSON.parse(calls[0]!.body) as Item[]).length, QUEUE_LIMIT, 'the 51st is dropped')

    const big = harness()
    for (let i = 0; i < 20; i++) big.sender.add(item('visit', 'x'.repeat(4000)))
    big.sender.send('hidden')
    assert.ok(big.calls[0]!.body.length <= BYTE_LIMIT)
    assert.equal((JSON.parse(big.calls[0]!.body) as Item[]).length, 7)
})

test('a visit makes at most REQUEST_LIMIT requests', () => {
    const { sender, beacons } = harness()
    for (let i = 0; i < REQUEST_LIMIT + 5; i++) {
        sender.add(item())
        sender.send('leaving')
    }
    assert.equal(beacons.length, REQUEST_LIMIT)
})

test('stopping drops the queue, and nothing is sent after, the pagehide send included', () => {
    const { sender, calls, beacons } = harness()
    sender.add(item())
    sender.stop()
    sender.add(item())
    sender.send('hidden', () => [item()])
    sender.send('leaving', () => [item()])
    assert.equal(calls.length + beacons.length, 0)
})

test('a request carries a timeout, so one that never ends fails like a network error', () => {
    const { sender, calls } = harness()
    sender.add(item())
    sender.send('hidden')
    assert.ok(calls[0]!.init?.signal instanceof AbortSignal)
})

// A page that listens for unload loses its back-forward cache, and an interval is polling.
test('the analytics code sets no interval and never listens for unload', () => {
    const folder = new URL('../../src/analytics/', import.meta.url)
    for (const file of readdirSync(folder)) {
        const source = readFileSync(new URL(file, folder), 'utf8')
        assert.doesNotMatch(source, /setInterval|['"](?:before)?unload['"]/, file)
    }
})
