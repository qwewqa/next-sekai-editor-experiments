import assert from 'node:assert/strict'
import { setMaxListeners } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { queryObjects } from 'node:v8'
import { nextTick, type ShallowRef } from 'vue'
import type { State } from '../../src/state'
import { createState } from '../../src/state'
import { soundCharts, soundClips } from '../helpers/playerSounds'
import { goldenChart, note } from '../local/records/charts'

// Use the real chart store and player with fixed history, settings and decoded clips.
const here = (path: string) => new URL(path, import.meta.url).href
const stubs: Record<string, string> = {
    [here('../../src/history/index.ts')]:
        `import { shallowRef } from 'vue'; export const state = shallowRef()`,
    [here('../../src/history/bgm.ts')]:
        `import { computed } from 'vue'; import { state } from './index.ts'; export const playbackBgm = computed(() => state.value.bgm)`,
    [here('../../src/editor/composedView.ts')]: 'export const getComposedLayout = () => undefined',
    [here('../../src/editor/view.ts')]: 'export const view = {}',
    [here('../../src/settings.ts')]:
        'export const settings = { playBgmVolume: 60, playSfxVolume: 80 }',
    [here('../../src/preview/assets/index.ts')]: `
        import { shallowRef } from 'vue'
        export const sfxSlots = ${JSON.stringify(soundClips)}
        export const assetSession = {
            slots: { effect: shallowRef({ state: 'ready', value: { buffers: Object.fromEntries(sfxSlots.map(clip => [clip, { clip }])) } }) },
            ensure() {},
        }
        export const setAudioDecoder = () => {}
    `,
}
registerHooks({
    load: (url, context, next) =>
        url in stubs
            ? { format: 'module', shortCircuit: true, source: stubs[url] }
            : next(url, context),
})

let calls: unknown[][] = []
let nextId = 0
class Context extends EventTarget {
    currentTime = 10
    state = 'running'
    destination = 'destination'
    static current: Context
    resume() {
        return Promise.resolve()
    }
    constructor() {
        super()
        setMaxListeners(0, this)
        Context.current = this
    }
}
class Source {
    id = nextId++
    onended: (() => void) | null = null
    constructor(
        _context: unknown,
        readonly options: AudioBufferSourceOptions,
    ) {
        calls.push(['source', this.id, options])
    }
    connect(node: Gain) {
        calls.push(['connect', this.id, node.id])
    }
    disconnect() {
        calls.push(['disconnect', this.id])
    }
    start(...args: number[]) {
        calls.push(['start', this.id, ...args])
    }
    stop(when?: number) {
        calls.push(['stop', this.id, when ?? null])
    }
}
class Gain {
    id = nextId++
    gain = {
        cancelScheduledValues: (time: number) => calls.push(['cancel', this.id, time]),
        setValueAtTime: (value: number, time: number) => calls.push(['set', this.id, value, time]),
        linearRampToValueAtTime: (value: number, time: number) =>
            calls.push(['ramp', this.id, value, time]),
    }
    constructor(_context: unknown, options: unknown) {
        calls.push(['gain', this.id, options])
    }
    connect(target: unknown) {
        calls.push(['connect', this.id, target])
    }
    disconnect() {
        calls.push(['disconnect', this.id])
    }
}
Object.assign(globalThis, {
    AudioContext: Context,
    AudioBufferSourceNode: Source,
    GainNode: Gain,
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    window: new EventTarget(),
})
const state = (await import('../../src/history')).state as ShallowRef<State>
const player = await import('../../src/player')
const playbackContext = Context.current
const { createSoundScheduler } = await import('../../src/playerSoundScheduler')

test('Play keeps its recorded hit, hold, catch-up and stop calls', async (t) => {
    let schedule: () => void = () => {}
    t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
        schedule = callback
        return 1
    })
    t.mock.method(globalThis, 'clearInterval', () => {})
    t.mock.method(globalThis, 'setTimeout', () => 1)
    t.mock.method(globalThis, 'clearTimeout', () => {})
    const recordings = []
    for (const [index, chart] of soundCharts().entries()) {
        calls = []
        nextId = 0
        Context.current.currentTime = 10
        state.value = {
            ...chart,
            bgm: { ...chart.bgm, buffer: { clip: 'bgm' } as unknown as AudioBuffer },
        }
        player.startPlayer(index === 1 ? 0.6 : 0, index === 2 ? 1.5 : 1, () =>
            assert.fail('start failed'),
        )
        for (const time of [10.5, 11, 11.5, 13, 13.5, 14, 15, 16, 17, 18]) {
            calls.push(['window', time])
            Context.current.currentTime = time
            schedule()
        }
        player.isSfxEnabled.value = false
        await nextTick()
        player.isSfxEnabled.value = true
        await nextTick()
        player.stopPlayer()
        recordings.push(calls)
    }
    const fixture = new URL('../fixtures/playerScheduling.json', import.meta.url)
    if (process.env.NSE_WRITE_GOLDEN === '1')
        writeFileSync(fixture, JSON.stringify(recordings, null, 4) + '\n')
    const expected = JSON.parse(readFileSync(fixture, 'utf8'))
    assert.deepEqual(recordings, expected)
})

const scheduler = (context: Context, read = () => soundCharts()[2]!) =>
    createSoundScheduler({
        context: context as unknown as AudioContext,
        source: read,
        buffers: {
            sfx: Object.fromEntries(
                soundClips.map((clip) => [clip, { clip } as unknown as AudioBuffer]),
            ),
            bgm: { offset: 0 },
        },
        volumes: { bgm: () => 60, sfx: () => 80 },
        start: { time: 0, contextTime: 10, speed: 1 },
    })

test('schedulers on one context own their spacing, volume and stop calls', () => {
    calls = []
    nextId = 0
    const context = new Context()
    const first = scheduler(context)
    const second = scheduler(context)
    first.schedule()
    const firstCalls = [...calls]
    const firstSources = firstCalls.filter(([method]) => method === 'source').map(([, id]) => id)
    assert.ok(firstSources.length > 0)
    calls = []
    second.schedule()
    assert.deepEqual(
        calls.filter(([method]) => method === 'start').map(([, , ...args]) => args),
        firstCalls.filter(([method]) => method === 'start').map(([, , ...args]) => args),
    )
    const secondGains = calls.filter(([method]) => method === 'gain').map(([, id]) => id)
    calls = []
    first.stop(true)
    assert.deepEqual(
        calls.filter(([method]) => method === 'stop').map(([, id]) => id),
        firstSources,
    )
    calls = []
    second.setSfxVolume(30)
    assert.deepEqual(
        calls.filter(([method]) => method === 'ramp').map(([, id]) => id),
        secondGains,
    )
    second.stop(true)
})

test('a clock that advances during planning skips past hits and resumes a spanning hold', () => {
    calls = []
    nextId = 0
    const context = new Context()
    const sounds = scheduler(context, () => {
        context.currentTime = 10.5
        return soundCharts()[2]!
    })
    sounds.schedule()
    assert.deepEqual(
        calls.filter(([method]) => method === 'start').map(([, , ...args]) => args),
        [[10.74, 0], [10.5]],
    )
    sounds.stop(true)
})

for (const work of [
    'scanning hidden sections',
    'scanning holds',
    'spacing criticalTap hits',
] as const) {
    test(`a speed change queues near hits before ${work}`, (t) => {
        t.mock.method(globalThis, 'setInterval', () => 1)
        t.mock.method(globalThis, 'clearInterval', () => {})
        t.mock.method(globalThis, 'setTimeout', () => 1)
        t.mock.method(globalThis, 'clearTimeout', () => {})
        playbackContext.currentTime = 10
        state.value = soundCharts()[2]!
        player.startPlayer(0, 1, () => assert.fail('start failed'))
        const { timeScale, connector } = state.value.store.grid
        const advance = () => {
            playbackContext.currentTime = 10.03
        }
        if (work === 'scanning hidden sections') {
            const values = timeScale.values.bind(timeScale)
            t.mock.method(timeScale, 'values', () => {
                advance()
                return values()
            })
        } else if (work === 'scanning holds') {
            const get = connector.get.bind(connector)
            t.mock.method(connector, 'get', (key: number) => {
                advance()
                return get(key)
            })
        } else {
            const sort = Array.prototype.sort
            t.after(() => {
                Array.prototype.sort = sort
            })
            Array.prototype.sort = function (this: unknown[], compare) {
                if (this.length === 1 && this[0] === 0) advance()
                return sort.call(this, compare)
            }
        }
        calls = []
        try {
            player.startPlayer(0, 1.5, () => assert.fail('restart failed'), 0)
            assert.equal(playbackContext.currentTime, 10.03)
            const starts = calls.filter(([method]) => method === 'start').map(([, , when]) => when)
            assert.ok(starts.includes(10.014), 'queue the next hit at the new speed')
            assert.ok(starts.includes(10), 'queue the hit at the restart time')
        } finally {
            player.stopPlayer()
            playbackContext.state = 'suspended'
            playbackContext.dispatchEvent(new Event('statechange'))
            playbackContext.state = 'running'
        }
    })
}

for (const pending of ['nothing', 'resume()', 'an ended callback'] as const) {
    test(`stopping after a display frame releases chart audio with ${pending} pending`, async (t) => {
        class DecodedAudio {}
        t.mock.method(globalThis, 'setInterval', () => 1)
        t.mock.method(globalThis, 'clearInterval', () => {})
        t.mock.method(globalThis, 'setTimeout', () => 1)
        t.mock.method(globalThis, 'clearTimeout', () => {})
        let resolveResume!: () => void
        const resume = new Promise<void>((resolve) => {
            resolveResume = resolve
        })
        const ended: (() => void)[] = []
        if (pending === 'resume()') {
            playbackContext.state = 'suspended'
            t.mock.method(playbackContext, 'resume', () => resume)
        }
        if (pending === 'an ended callback') {
            const start = Source.prototype.start
            t.mock.method(Source.prototype, 'start', function (this: Source, ...args: number[]) {
                if (this.onended && !(this.options.buffer instanceof DecodedAudio))
                    ended.push(this.onended)
                start.apply(this, args)
            })
        }
        playbackContext.currentTime = 10
        state.value = {
            ...soundCharts()[0]!,
            bgm: { offset: 0, buffer: new DecodedAudio() as AudioBuffer },
        }
        player.startPlayer(0, 1, () => assert.fail('start failed'))
        if (pending === 'an ended callback') assert.ok(ended.length > 0)
        player.getPlayerDisplayTime()
        assert.equal(queryObjects(DecodedAudio), 1)
        player.stopPlayer()
        // Finish the pending fades through the context's suspension handler.
        playbackContext.state = 'suspended'
        playbackContext.dispatchEvent(new Event('statechange'))
        playbackContext.state = 'running'
        state.value = soundCharts()[1]!
        const { playbackBgm } = await import('../../src/history/bgm')
        assert.equal(playbackBgm.value, state.value.bgm)
        await nextTick()
        calls = []
        // Mock call records also hold the start deadline's closure until released.
        t.mock.reset()
        try {
            assert.equal(queryObjects(DecodedAudio), 0)
        } finally {
            resolveResume()
            for (const callback of ended) callback()
            await nextTick()
        }
    })
}

for (const work of ['sorting critical holds', "converting the next hold's times"] as const) {
    test(`normal holds are queued before ${work}`, (t) => {
        t.mock.method(globalThis, 'setInterval', () => 1)
        t.mock.method(globalThis, 'clearInterval', () => {})
        t.mock.method(globalThis, 'setTimeout', () => 1)
        t.mock.method(globalThis, 'clearTimeout', () => {})
        playbackContext.currentTime = 10
        state.value = createState(
            {
                ...goldenChart().chart,
                bpms: [
                    { beat: 0, bpm: 60 },
                    { beat: 0.3, bpm: 60 },
                ],
                timeScales: [],
                slides: [
                    [note(0.021, { sfx: 'none' }), note(0.04, { sfx: 'none' })],
                    [
                        note(0.3, {
                            sfx: 'none',
                            connectorActiveIsCritical: work === 'sorting critical holds',
                        }),
                        note(0.4, { sfx: 'none' }),
                    ],
                ],
            },
            0,
        )
        const sort = Array.prototype.sort
        t.after(() => {
            Array.prototype.sort = sort
        })
        let sortedHolds = false
        const bpm = state.value.bpms[1]!
        const slope = bpm.s
        Object.defineProperty(bpm, 's', { configurable: true, get: () => slope })
        t.mock.getter(bpm, 's', () => {
            if (sortedHolds && work === "converting the next hold's times")
                playbackContext.currentTime = 10.03
            return slope
        })
        Array.prototype.sort = function (this: unknown[], compare) {
            if (Array.isArray(this[0])) {
                sortedHolds = true
                if (this[0][0] === 0.3 && work === 'sorting critical holds')
                    playbackContext.currentTime = 10.03
            }
            return sort.call(this, compare)
        }
        calls = []
        try {
            player.startPlayer(0, 1.5, () => assert.fail('start failed'), 0)
            assert.equal(playbackContext.currentTime, 10.03)
            assert.ok(calls.some(([method, , when]) => method === 'start' && when === 10.014))
        } finally {
            player.stopPlayer()
            playbackContext.state = 'suspended'
            playbackContext.dispatchEvent(new Event('statechange'))
            playbackContext.state = 'running'
        }
    })
}

test('hold cleanup checks the clock again before extending the next voice', async (t) => {
    const { scheduleActivePlayerAudio } = await import('../../src/playerAudio')
    const context = new Context()
    const actives = new Set<import('../../src/playerAudio').ActivePlayerAudio>()
    const buffer = {} as AudioBuffer
    scheduleActivePlayerAudio(
        context as unknown as AudioContext,
        actives,
        buffer,
        0,
        1,
        80,
        10,
        10.01,
    )
    scheduleActivePlayerAudio(
        context as unknown as AudioContext,
        actives,
        buffer,
        2,
        3,
        80,
        10,
        10.04,
    )
    const [first, second] = [...actives]
    assert.ok(first && second)
    const stop = first.stop
    t.mock.method(first, 'stop', () => {
        stop()
        context.currentTime = 10.05
    })
    context.currentTime = 10.02
    calls = []
    scheduleActivePlayerAudio(
        context as unknown as AudioContext,
        actives,
        buffer,
        3,
        4,
        80,
        10.04,
        11,
    )
    assert.ok(!actives.has(second), 'release the voice that ended during cleanup')
    assert.ok(calls.some(([method, , when]) => method === 'start' && when === 10.05))
    for (const active of actives) active.stop()
})

test('Play pressed while the BGM still decodes starts its audio once the decode completes', (t) => {
    let schedule: () => void = () => {}
    t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
        schedule = callback
        return 1
    })
    t.mock.method(globalThis, 'clearInterval', () => {})
    t.mock.method(globalThis, 'setTimeout', () => 1)
    t.mock.method(globalThis, 'clearTimeout', () => {})
    calls = []
    nextId = 0
    playbackContext.currentTime = 10
    const chart = soundCharts()[0]!
    const meta = { hash: 'a', filename: 'a', size: 1, type: 'audio/wav' }
    state.value = { ...chart, bgm: { offset: 0.5, meta } }
    player.startPlayer(1, 1, () => assert.fail('start failed'))
    const bgmSources = () =>
        calls.filter(
            ([method, , options]) =>
                method === 'source' &&
                (options as AudioBufferSourceOptions).buffer === (buffer as unknown),
        )
    const buffer = { clip: 'bgm' } as unknown as AudioBuffer
    playbackContext.currentTime = 11
    schedule()
    assert.equal(bgmSources().length, 0)
    // The decode completes: the state gets the audio, and the next window starts it.
    state.value = { ...state.value, bgm: { offset: 0.5, meta, buffer } }
    playbackContext.currentTime = 12
    schedule()
    const [source] = bgmSources()
    assert.ok(source)
    // At the chart time playing now (Play at 1 s, 1.8 s since the 0.2 s preroll), with the offset.
    const start = calls.find(([method, id]) => method === 'start' && id === source[1])
    assert.equal(start?.[2], 12)
    assert.ok(Math.abs((start?.[3] as number) - (1 + 1.8 + 0.5)) < 1e-9)
    // Once only.
    playbackContext.currentTime = 13
    schedule()
    assert.equal(bgmSources().length, 1)
    player.stopPlayer()
})
