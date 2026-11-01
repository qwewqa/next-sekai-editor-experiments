import assert from 'node:assert/strict'
import test from 'node:test'
import type { NoteObject, NoteType } from '../../src/chart/note'
import { planActiveSound, planSounds, type SoundSource } from '../../src/playerSounds'
import { createState, type State } from '../../src/state'
import { soundCharts, soundClips } from '../helpers/playerSounds'
import { goldenChart, note } from '../local/records/charts'

const sourceOf = ({ store }: State): SoundSource => ({
    notes: new Set([...store.grid.note.values()].flatMap((bucket) => [...bucket])),
    connectors: new Set([...store.grid.connector.values()].flatMap((bucket) => [...bucket])),
    getInfo: (note) => store.slides.info.get(note.slideId)?.find((info) => info.note === note),
    getHideChanges: (group) =>
        [...new Set([...store.grid.timeScale.values()].flatMap((bucket) => [...bucket]))]
            .filter((change) => change.groupId === group)
            .sort((a, b) => a.beat - b.beat),
})
const clips = Object.fromEntries(soundClips.map((clip) => [clip, true]))

test('note kinds choose their hit clip for singles and each position in a hold', () => {
    const expected: Record<NoteType, string[][]> = {
        default: [
            ['Tap', 'Flick'],
            ['normalTap', 'Flick'],
            ['Tick', 'Tick'],
            ['normalTap', 'Flick'],
        ],
        trace: [
            ['Trace', 'Flick'],
            ['Trace', 'Flick'],
            ['Trace', 'Flick'],
            ['Trace', 'Flick'],
        ],
        anchor: [
            ['', ''],
            ['', ''],
            ['', ''],
            ['', ''],
        ],
        damage: [
            ['', ''],
            ['', ''],
            ['', ''],
            ['', ''],
        ],
        forceTick: [
            ['Tick', 'Tick'],
            ['Tick', 'Tick'],
            ['Tick', 'Tick'],
            ['Tick', 'Tick'],
        ],
        forceNonTick: [
            ['Tap', 'Flick'],
            ['normalTap', 'Flick'],
            ['Tap', 'Flick'],
            ['normalTap', 'Flick'],
        ],
    }
    for (const [noteType, roles] of Object.entries(expected)) {
        for (const [role, sounds] of roles.entries()) {
            for (const isCritical of [false, true]) {
                for (const [flick, suffix] of sounds.entries()) {
                    const target = note(1, {
                        noteType: noteType as NoteType,
                        isCritical,
                        flickDirection: flick ? 'up' : 'none',
                    })
                    const slide = [
                        ...(role === 2 || role === 3 ? [note(0)] : []),
                        target,
                        ...(role === 1 || role === 2 ? [note(2)] : []),
                    ]
                    const chart = createState(
                        { ...goldenChart().chart, timeScales: [], slides: [slide] },
                        0,
                    )
                    const plan = planSounds(
                        sourceOf(chart),
                        chart.bpms,
                        clips,
                        { from: 0.5, to: 0.6 },
                        { lastSfx: {} },
                    )
                    const hit = plan.events.filter((event) => event.type === 'hit')
                    const clip = suffix.startsWith('normal')
                        ? suffix
                        : (isCritical ? 'critical' : 'normal') + suffix
                    assert.deepEqual(
                        hit.map((event) => event.clip),
                        suffix ? [clip] : [],
                        `${noteType}, role ${role}, critical ${isCritical}, flick ${flick}`,
                    )
                }
            }
        }
    }
})

test('explicit clips, suppressed notes and unavailable clips keep their rules', () => {
    for (const extra of [
        { sfx: 'criticalFlick' },
        { noteType: 'damage', sfx: 'normalTap' },
        { noteType: 'anchor', sfx: 'normalTap' },
        { isFake: true },
        { sfx: 'none' },
        { sfx: 'damage' },
    ] as Partial<NoteObject>[]) {
        const chart = createState({ ...goldenChart().chart, slides: [[note(0, extra)]] }, 0)
        const plan = planSounds(
            sourceOf(chart),
            chart.bpms,
            clips,
            { from: 0, to: 0.5 },
            { lastSfx: {} },
        )
        const expected =
            extra.noteType === 'anchor' ||
            extra.isFake ||
            extra.sfx === 'none' ||
            extra.sfx === 'damage'
                ? []
                : [extra.sfx]
        assert.deepEqual(
            plan.events.map((event) => event.clip),
            expected,
        )
        assert.deepEqual(
            planSounds(sourceOf(chart), chart.bpms, {}, { from: 0, to: 0.5 }, { lastSfx: {} }),
            {
                events: [],
                state: { until: 0.5, lastSfx: {} },
            },
        )
    }
})

test('spacing and equal-time order persist across windows without changing the prior state', () => {
    const chart = soundCharts()[2]!
    const source = sourceOf(chart)
    const previous = { lastSfx: {} }
    const first = planSounds(source, chart.bpms, clips, { from: 0, to: 0.75 }, previous)
    assert.deepEqual(
        first.events.filter((event) => event.type === 'hit'),
        [
            { type: 'hit', clip: 'normalTap', time: 0 },
            { type: 'hit', clip: 'normalTap', time: 0.021 },
            { type: 'hit', clip: 'normalTap', time: 0.74 },
            { type: 'hit', clip: 'criticalTap', time: 0 },
            { type: 'hit', clip: 'normalFlick', time: 0 },
            { type: 'hit', clip: 'normalTrace', time: 0 },
        ],
    )
    const before = structuredClone(first.state)
    const second = planSounds(source, chart.bpms, clips, { from: 0.75, to: 1.5 }, first.state)
    assert.deepEqual(second.events, [{ type: 'hit', clip: 'normalTap', time: 0.761 }])
    assert.deepEqual(previous, { lastSfx: {} })
    assert.deepEqual(first.state, before)
    assert.equal(second.state.until, 1.5)
    assert.equal(second.state.lastSfx.normalTap, 0.761)
})

test('hidden holds resume in a later window and catch-up includes only spanning pieces', () => {
    const chart = soundCharts()[1]!
    const source = sourceOf(chart)
    const holds = (from: number, to: number, until?: number) =>
        planSounds(source, chart.bpms, clips, { from, to }, { lastSfx: {}, until }).events.filter(
            (event) => event.type === 'hold',
        )
    assert.deepEqual(
        holds(0.6, 0.9).map((event) => [event.clip, event.time, event.endTime]),
        [
            ['normalActive', 0, 1],
            ['normalActive', 0.5, 1],
            ['criticalActive', 0, 5],
        ],
    )
    assert.deepEqual(holds(1, 2, 1), [])
    assert.deepEqual(
        holds(2, 2.5, 2).map((event) => [event.clip, event.time, event.endTime]),
        [['normalActive', 2, 4.5]],
    )
    assert.deepEqual(
        holds(3, 3.5, 2.5).map((event) => [event.clip, event.time, event.endTime]),
        [
            ['normalActive', 2, 4.5],
            ['criticalActive', 0, 5],
        ],
    )
})

test('hold merging retains the longest end and replaces expired voices at catch-up', () => {
    const active = { endBeat: 6, endTime: 5 }
    const expired = { endBeat: 10, endTime: 2 }
    assert.deepEqual(planActiveSound([active], 2, 4, 2, 4, 1), {
        expired: [],
        next: { type: 'skip' },
    })
    assert.deepEqual(planActiveSound([expired, active], 6, 8, 5, 7, 3), {
        expired: [expired],
        next: { type: 'extend', active },
    })
    assert.deepEqual(planActiveSound([active], 6, 8, 5, 7, 5), {
        expired: [active],
        next: { type: 'start', time: 5 },
    })
    assert.deepEqual(planActiveSound([], 0, 8, 0, 7, 3), {
        expired: [],
        next: { type: 'start', time: 3 },
    })
    assert.deepEqual(planActiveSound([active], 8, 9, 7, 8, 3), {
        expired: [],
        next: { type: 'start', time: 7 },
    })
    assert.deepEqual(active, { endBeat: 6, endTime: 5 })
})
