import type { LevelDataEntity } from '@sonolus/core'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { maxBeat, maxLane, maxMeter, maxSize, minMeter } from '../../src/chart/limits'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { parseSusChart } from '../../src/chart/parse/sus'
import { parseUscChart } from '../../src/chart/parse/usc'
import { ImportRefusal } from '../../src/chart/refusal'
import type { StageId } from '../../src/chart/stages'
import { validateChart } from '../../src/chart/validate'
import { chcyToUsc } from '../../src/chcy/convert'
import { clipboardEntry, setClipboardData } from '../../src/clipboard'
import { parseLevelData } from '../../src/levelData/parse'
import { iterSlotLanes } from '../../src/preview/engine/layout'
import { createState } from '../../src/state'
import { toBpmEntity } from '../../src/state/entities/bpm'
import { addToStoreGrid, removeFromStoreGrid, replaceInStoreGrid } from '../../src/state/store/grid'
import { parseSus } from '../../src/sus/parse'
import { parseUsc } from '../../src/usc/parse'
import { minimalLevel } from './levelDataSynthetic'

const refusal = (field: string) => (error: unknown) =>
    error instanceof ImportRefusal && error.reason === 'invalidValue' && error.params[0] === field

const withNote = (data: Record<string, number>): LevelDataEntity[] =>
    minimalLevel().map((entity) =>
        entity.archetype === 'NormalTapNote'
            ? {
                  ...entity,
                  data: [
                      ...entity.data.filter((item) => !(item.name in data)),
                      ...Object.entries(data).map(([name, value]) => ({ name, value })),
                  ],
              }
            : entity,
    )

const openLevel = (entities: LevelDataEntity[]) => validateChart(parseLevelDataChart(entities))

test('a level with a note far past the largest beat is refused', () => {
    assert.throws(() => openLevel(withNote({ '#BEAT': 1e16 })), refusal('beat'))
    assert.throws(() => openLevel(withNote({ '#BEAT': maxBeat + 1 })), refusal('beat'))
})

test('a level with a note far past the largest size or lane is refused', () => {
    assert.throws(() => openLevel(withNote({ size: 1e9 })), refusal('left'))
    assert.throws(() => openLevel(withNote({ size: maxSize })), refusal('size'))
    assert.throws(() => openLevel(withNote({ lane: 1e16 })), refusal('left'))
    assert.throws(() => openLevel(withNote({ lane: -1e16 })), refusal('left'))
})

test('the largest values in the real levels open, and so do the limits', () => {
    // A note 585 beats in, one 255 lanes from the middle, and one 364 lanes wide.
    openLevel(withNote({ '#BEAT': 585, lane: 180.25, size: 182 }))
    openLevel(withNote({ '#BEAT': 585, lane: -100, size: 100 }))
    openLevel(withNote({ '#BEAT': maxBeat, lane: 0, size: maxSize / 2 }))
    openLevel(withNote({ lane: maxLane - 1, size: 1 }))
})

test('every event kind refuses a coordinate past its limit', () => {
    const camera = {
        beat: 0,
        cameraLeft: 0,
        cameraSize: 6,
        cameraZoom: 1,
        cameraZoomTargetLane: 0,
        cameraZoomTargetY: 0,
        cameraZoomVerticalAlign: 'default',
        cameraRotation: 0,
        cameraStageTilt: 0,
        eventEase: 'none',
    } as const
    const mask = {
        stageId: 0 as StageId,
        beat: 0,
        maskLeft: -6,
        maskSize: 12,
        isMaskNotes: false,
        eventEase: 'none',
    } as const
    const pivot = {
        stageId: 0 as StageId,
        beat: 0,
        pivotLane: 0,
        divisionSize: 2,
        divisionParity: 'even',
        yOffset: 0,
        yOffsetBeat: 0,
        eventEase: 'none',
    } as const

    const refused = (
        change: (chart: ReturnType<typeof parseLevelDataChart>) => void,
        field: string,
    ) => {
        const chart = parseLevelDataChart(minimalLevel())
        change(chart)
        assert.throws(() => validateChart(chart), refusal(field))
    }
    refused((c) => c.cameraEvents.push({ ...camera, beat: 1e16 }), 'beat')
    refused((c) => c.cameraEvents.push({ ...camera, cameraLeft: -1e16 }), 'cameraLeft')
    refused((c) => c.cameraEvents.push({ ...camera, cameraSize: 1e9 }), 'cameraSize')
    refused(
        (c) => c.cameraEvents.push({ ...camera, cameraZoomTargetLane: 1e16 }),
        'cameraZoomTargetLane',
    )
    refused((c) => c.stageMaskEvents.push({ ...mask, beat: 1e16 }), 'beat')
    refused((c) => c.stageMaskEvents.push({ ...mask, maskLeft: -1e16 }), 'maskLeft')
    refused((c) => c.stageMaskEvents.push({ ...mask, maskSize: 1e9 }), 'maskSize')
    refused((c) => c.stagePivotEvents.push({ ...pivot, pivotLane: 1e16 }), 'pivotLane')
    refused((c) => c.stagePivotEvents.push({ ...pivot, yOffsetBeat: 1e16 }), 'yOffsetBeat')
    refused((c) => c.bpms.push({ beat: 1e16, bpm: 120 }), 'beat')
})

test('a USC and a ChCy file with a note at beat 1e16, and a SUS file with a bar of 1e15 beats, are refused', () => {
    const usc = {
        version: 2,
        usc: {
            offset: 0,
            objects: [
                { type: 'bpm', beat: 0, bpm: 120 },
                { type: 'timeScaleGroup', changes: [{ beat: 0, timeScale: 1 }] },
                {
                    type: 'single',
                    beat: 1e16,
                    timeScaleGroup: 0,
                    lane: 0,
                    size: 1,
                    critical: false,
                    trace: false,
                },
            ],
        },
    }
    assert.throws(() => validateChart(parseUscChart(parseUsc(usc).usc.objects)), refusal('beat'))

    const chcy = parseLevelData({
        bgmOffset: 0,
        entities: [
            { archetype: 'Initialization', data: [] },
            { archetype: 'InputManager', data: [] },
            { archetype: 'Stage', data: [] },
            {
                archetype: 'TimeScaleGroup',
                name: 'tsg:0',
                data: [
                    { name: 'first', ref: 'tsc:0:0' },
                    { name: 'length', value: 0 },
                    { name: 'next', value: -1 },
                ],
            },
            {
                archetype: '#BPM_CHANGE',
                data: [
                    { name: '#BEAT', value: 0 },
                    { name: '#BPM', value: 150 },
                ],
            },
            {
                archetype: 'CriticalTapNote',
                data: [
                    { name: '#BEAT', value: 1e16 },
                    { name: 'lane', value: 0 },
                    { name: 'size', value: 1 },
                    { name: 'timeScaleGroup', ref: 'tsg:0' },
                ],
            },
        ],
    })
    assert.throws(() => validateChart(parseUscChart(chcyToUsc(chcy).objects)), refusal('beat'))

    // A SUS file reaches a late beat only through a long bar, which is refused as a meter.
    const sus = [
        '#TITLE "Import"',
        '#REQUEST "ticks_per_beat 480"',
        '#00002:1000000000000000',
        '#BPM01:120',
        '#00008:01',
        '#00112:11',
        '#00113:11',
    ]
    assert.throws(() => validateChart(parseSusChart(parseSus(sus))), refusal('meter'))
})

test('a copy with a beat or a note past the limits is not pasted', () => {
    const copy = (beat: number, size: number, anchor = 1) => ({
        lane: 0,
        beat: anchor,
        entities: minimalLevel().map((entity) =>
            entity.archetype === 'NormalTapNote'
                ? {
                      ...entity,
                      data: entity.data.map((item) =>
                          item.name === '#BEAT'
                              ? { ...item, value: beat }
                              : item.name === 'size'
                                ? { ...item, value: size }
                                : item,
                      ),
                  }
                : entity,
        ),
    })
    setClipboardData(copy(1e16, 1))
    assert.equal(clipboardEntry.value?.data, undefined)
    setClipboardData(copy(1, 1e9))
    assert.equal(clipboardEntry.value?.data, undefined)
    setClipboardData(copy(1, 1, 1e16))
    assert.equal(clipboardEntry.value?.data, undefined)
    setClipboardData(copy(585, 182))
    assert.notEqual(clipboardEntry.value?.data, undefined)
})

test('the grid and the slot lanes end for a value past the limits', () => {
    const { store } = createState(parseLevelDataChart(minimalLevel()), 0)
    const bpm = toBpmEntity({ beat: 1e16, bpm: 120 })
    addToStoreGrid(store.grid, bpm, 1e16, 2e16)
    removeFromStoreGrid(store.grid, bpm, 1e16, 2e16)
    replaceInStoreGrid(store.grid, bpm, toBpmEntity({ beat: 1e16, bpm: 90 }), 1e16, 2e16)

    assert.ok(iterSlotLanes(0, 1e9).length <= maxSize)
    assert.ok(iterSlotLanes(1e16, 1).length <= maxSize)
})

test('a BPM change with a meter far past the limits is refused', () => {
    for (const meter of [1e16, maxMeter + 1, minMeter / 2, 1e-12]) {
        const chart = parseLevelDataChart(minimalLevel())
        chart.bpms.push({ beat: 0.1, bpm: 120, meter })
        assert.throws(() => validateChart(chart), refusal('meter'), `${meter}`)
    }
    for (const meter of [minMeter, 3, 4, maxMeter]) {
        const chart = parseLevelDataChart(minimalLevel())
        chart.bpms.push({ beat: 0.1, bpm: 120, meter })
        validateChart(chart)
    }
})

test('the grid searches end for a meter that slipped past the limits, promptly', () => {
    // Run apart, so a hang fails the test instead of stalling the run.
    const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
    const script = `
        import { calculateBpms, toBpmIntegral } from ${url('../../src/state/integrals/bpms.ts')}
        import { ceilGridBeat, floorGridBeat, gridLines, snapBeat, toBeatGrid } from ${url('../../src/state/integrals/grid.ts')}
        for (const meter of [1e16, 1e-12]) {
            const grid = toBeatGrid(
                calculateBpms([{ beat: 0, bpm: 120 }, { beat: 0.1, bpm: 120, meter }].map(toBpmIntegral)),
            )
            for (const division of [1, 4, 192]) {
                ceilGridBeat(grid, 0.05, division)
                floorGridBeat(grid, 0.5, division)
                snapBeat(grid, 0.5, division)
                gridLines(grid, 0, 30, division, 2000)
            }
        }
        console.log('done')
    `
    const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { encoding: 'utf8', timeout: 20_000 },
    )
    assert.equal(run.signal, null, 'timed out')
    assert.equal(run.status, 0, run.stderr)
})
