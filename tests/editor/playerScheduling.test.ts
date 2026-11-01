import assert from 'node:assert/strict'
import { setMaxListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { nextTick, type ShallowRef } from 'vue'
import type { State } from '../../src/state'
import { soundCharts, soundClips } from '../helpers/playerSounds'

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
    constructor() {
        super()
        setMaxListeners(0, this)
        Context.current = this
    }
}
class Source {
    id = nextId++
    onended: (() => void) | null = null
    constructor(_context: unknown, options: unknown) {
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
    const expected = JSON.parse(
        readFileSync(new URL('../fixtures/playerScheduling.json', import.meta.url), 'utf8'),
    )
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
