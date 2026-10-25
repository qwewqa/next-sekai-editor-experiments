import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { serializeToLevelData } from '../../src/levelData/serialize'
import { executePlan, planNxsp, summaryOf, type BuildInput } from '../../src/local/nxsp'
import { toRecords } from '../../src/local/records/records'
import type { State } from '../../src/state'
import { crafted, jsonOf, setJson } from '../local/nxsp/craft'
import { headInput } from '../local/nxsp/helpers'
import { goldenChart, note, stage, stateOf, type FixtureChart } from '../local/records/charts'

// The level the scenario starts from: the records golden chart (Part 1 §1.6.11.1) without what only
// dynamic stages hold (the scenario turns them on and adds them through the editor), and without
// media (the scenario adds those through the editor), plus one note in each of 18 more 16-beat
// windows, so a kind holds more than 16 chunks and its node has depth 1.

export const WINDOWS = 18

export const startChart = (): FixtureChart => {
    const fixture = goldenChart()
    const { chart, extras } = fixture
    const { levelInfo } = extras
    if (!levelInfo) throw new Error('The golden chart has level info')
    chart.isDynamicStages = false
    // The first stage only, with the group folder kept; level data has no stage records without dynamic stages.
    const main = chart.stages.get(stage(1))
    if (!main) throw new Error('The golden chart has a first stage')
    chart.stages = new Map([[stage(1), main]])
    chart.stageFolders = new Map()
    chart.cameraEvents = []
    chart.stageMaskEvents = []
    chart.stagePivotEvents = []
    chart.stageStyleEvents = []
    chart.stageTransformEvents = []
    // The golden chart's fourth slide is on the second stage.
    chart.slides = chart.slides.slice(0, 3)
    for (let window = 1; window <= WINDOWS; window++) chart.slides.push([note(window * 16 + 1)])
    fixture.extras = {
        levelInfo: {
            ...levelInfo,
            tags: [{ title: 'First tag' }, { title: 'Tag' }],
            cover: undefined,
            preview: undefined,
        },
        bgm: undefined,
    }
    return fixture
}

/** The state the editor holds after opening the level data of `startChart`. */
export const startState = (): State => stateOf(startChart())

/** What the builder takes for a file of the level, with no history and no media. */
export const startInput = (now: number, appVersion: string): BuildInput => {
    const state = startState()
    return {
        context: {
            now,
            newId: () => randomUUID(),
            device: { id: randomUUID(), label: 'Web (Chrome)' },
            appVersion,
        },
        id: randomUUID(),
        lineageId: randomUUID(),
        revision: { parent: null, n: 1, ancestors: [], fileName: 'fixture.nxsp' },
        ...headInput(state),
        summary: summaryOf(toRecords(state)),
        media: {},
        // Names no build reads: they ride through every Save of the chain (Part 1 §1.6.11.4).
        extra: {
            zzTopLevel: { carried: true },
            metadata: { zzMeta: ['carried', 1] },
        },
    }
}

/** `fixture.nxsp`: made by the product's own builder in Node, with no history. */
export const fixtureFile = async (now: number, appVersion: string) => {
    const { plan } = planNxsp(startInput(now, appVersion))
    return new Uint8Array(await (await executePlan(plan, new Map())).arrayBuffer())
}

/** Level data of the start chart as gzipped JSON, the form the Open command takes as an Export target. */
export const levelJson = () => {
    const chart = startChart()
    const state = stateOf(chart)
    const level = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    return new Uint8Array(gzipSync(new TextEncoder().encode(JSON.stringify(level))))
}

/** A copy of a file with one unknown key in a manifest entry: a run input, never a fixture (scenario step 9). */
export const craftedCopy = async (file: Uint8Array) => {
    const copy = await crafted(
        (items) => {
            const manifest = jsonOf(items, 'history/manifest.json')
            manifest.entries[0].zzUnknownKey = true
            setJson(items, 'history/manifest.json', manifest)
        },
        new Blob([new Uint8Array(file)]),
    )
    return new Uint8Array(await copy.arrayBuffer())
}
