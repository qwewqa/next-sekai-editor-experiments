import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import test from 'node:test'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { parseLevelData } from '../../src/levelData/parse'
import { createCameraCompiler, createPreviewChartBuilder } from '../../src/preview/engine/chart'
import type { Quad } from '../../src/preview/engine/math'
import type { PreviewChart } from '../../src/preview/engine/model'
import { previewBackgroundQuad, renderPreviewFrame } from '../../src/preview/engine/render'
import type { PreviewRenderer } from '../../src/preview/gl'
import { resolveSkin } from '../../src/preview/skin'
import {
    applyMirror,
    createMirrorSender,
    selectedObjects,
    selectionPlaces,
    type MirrorState,
} from '../../src/preview/worker/mirror'
import { createState, type State } from '../../src/state'
import { createSlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { addNote, removeNote } from '../../src/state/mutations/slides/note'
import { editBpm } from '../../src/state/operations/bpm'
import { editSelectedNote } from '../../src/state/operations/note'
import { createTransaction } from '../../src/state/transaction'

// The preview's worker builds the chart from a copy of the state, sent as diffs and cloned as
// postMessage clones them. After any run of edits, undo and peek jumps, its chart must equal
// the main thread's, element by element and by what it draws, with the same selection.

const charts = [
    'tests/fixtures/generated-large.json',
    ...(process.env.PREVIEW_CULL_CHARTS?.split(delimiter) ?? []),
].filter((path) => path && existsSync(path))

const speed = 10

const load = (path: string) =>
    createState(
        parseLevelDataChart(parseLevelData(JSON.parse(readFileSync(path, 'utf8'))).entities),
        0,
    )

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const sprite = { u0: 0, v0: 0, u1: 1, v1: 1 }
const skin = resolveSkin(() => sprite)
let draws: string[] = []
const renderer: PreviewRenderer = {
    maxViewportSize: { width: 1600, height: 900 },
    setTexture() {},
    begin() {},
    draw(sprite, quad, z, alpha) {
        if (sprite && alpha > 0) draws.push(JSON.stringify([quad, z, alpha]))
    },
    flush() {},
    isContextLost: () => false,
    dispose() {},
}
/** Playing frames, then paused frames with the selection's outline, and the background quads. */
const frames = (chart: PreviewChart, times: number[], objects: ReadonlySet<object>) => {
    draws = []
    const quads: Quad[] = []
    for (const now of times) {
        quads.push(
            renderPreviewFrame(renderer, skin, chart, now, 1600, 900, 1600, 900, speed, false),
        )
        renderPreviewFrame(
            renderer,
            skin,
            chart,
            now,
            1600,
            900,
            1600,
            900,
            speed,
            false,
            undefined,
            { objects, outline: (quad) => draws.push(`o${JSON.stringify(quad)}`) },
            true,
        )
    }
    return { draws: draws.join('\n'), quads }
}

/** Each note's place in the state: its slide and its index in the slide's infos. */
const places = (state: Pick<MirrorState, 'store'>) => {
    const result = new Map<object, string>()
    for (const [id, infos] of state.store.slides.info)
        for (const [index, info] of infos.entries()) result.set(info.note, `${id}:${index}`)
    for (const [id, connectors] of state.store.slides.connector)
        for (const [index, connector] of connectors.entries())
            result.set(connector, `${id}c${index}`)
    return result
}

const sameBySource = (
    worker: PreviewChart,
    workerState: MirrorState,
    main: PreviewChart,
    mainState: State,
    label: string,
) => {
    const workerPlaces = places(workerState)
    const mainPlaces = places(mainState)
    const path = (lookup: Map<object, string>) => (source: object | undefined) =>
        source ? lookup.get(source) : undefined
    const compare = (
        pick: (chart: PreviewChart, at: (source?: object) => unknown) => unknown[],
        what: string,
    ) => {
        const actual = pick(worker, path(workerPlaces))
        const expected = pick(main, path(mainPlaces))
        assert.equal(actual.length, expected.length, `${label} ${what} length`)
        for (const [index, value] of actual.entries())
            assert.equal(value, expected[index], `${label} ${what}[${index}]`)
    }
    compare((chart, at) => chart.notes.map((note) => at(note.source)), 'notes')
    compare(
        (chart, at) =>
            chart.connectors.flatMap((c) => [at(c.source), at(c.head.source), at(c.tail.source)]),
        'connectors',
    )
    compare((chart, at) => chart.slides.map((slide) => at(slide.activeHead.source)), 'slides')
    compare((chart, at) => chart.chains.map((chain) => at(chain.infos[0]?.note)), 'chains')
    compare(
        (chart, at) =>
            chart.simLines.flatMap((line) => [at(line.left.source), at(line.right.source)]),
        'sim lines',
    )
    // The worker's entities are copies, so the rest compares by value.
    assert.deepEqual(worker, main, label)
}

for (const path of charts) {
    test(`the worker's mirrored chart equals the main thread's over random edits: ${path}`, () => {
        const next = random(path.length * 104729 + 3)
        const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)] as T
        const count = (max: number) => 1 + Math.floor(next() * max)
        const first = load(path)
        const other = load(path)
        const states: State[] = [first]

        // The main thread's builder and the worker's, each long-lived as in the app.
        const mainBuild = createPreviewChartBuilder()
        const mainCameras = createCameraCompiler()
        const sender = createMirrorSender()
        let workerBuild = createPreviewChartBuilder()
        let mirror: MirrorState | undefined
        let checked = 0
        let sentSlides = 0
        const check = (state: State, label: string) => {
            const diff = sender.diff(state)
            if (diff) {
                const copy = structuredClone(diff)
                if (copy.reset) workerBuild = createPreviewChartBuilder()
                sentSlides += copy.slides?.changed.length ?? 0
                mirror = applyMirror(mirror, copy)
            }
            assert.ok(mirror, label)
            const main = mainBuild(state, speed)
            const worker = workerBuild(mirror, speed)
            sameBySource(worker, mirror, main, state, label)
            if (checked++ % 10 === 0) {
                // A selection of notes and connectors, sent as places in the slides.
                const selected = new Set<object>()
                for (const [id, infos] of state.store.slides.info) {
                    if (next() < 0.2) for (const info of infos) selected.add(info.note)
                    if (next() < 0.2)
                        for (const connector of state.store.slides.connector.get(id) ?? [])
                            selected.add(connector)
                }
                const copied = selectedObjects(
                    mirror,
                    structuredClone(selectionPlaces(state, selected)),
                )
                assert.equal(copied.size, selected.size, `${label} selection`)
                const end = Math.max(...main.notes.map((note) => note.targetTime))
                const times = [0.25, 0.5, 0.75].map((fraction) => end * fraction)
                const expected = frames(main, times, selected)
                const actual = frames(worker, times, copied)
                assert.equal(actual.draws, expected.draws, `${label} draws`)
                // The main thread's background quad, from the state's cameras alone.
                for (const [index, now] of times.entries())
                    assert.deepEqual(
                        previewBackgroundQuad(mainCameras(state), now, 1600, 900, false),
                        expected.quads[index],
                        `${label} background at ${now}`,
                    )
            }
        }
        check(first, 'open')

        // One edited note per slide, so each transaction's entities stay current.
        const notesOf = (state: State, max: number) => {
            const slides = [...state.store.slides.note.values()]
            const chosen: NoteEntity[] = []
            for (let i = 0; i < count(max) && slides.length; i++) {
                const notes = slides.splice(Math.floor(next() * slides.length), 1)[0]!
                chosen.push(pick(notes))
            }
            return chosen
        }
        const edit = (state: State, notes: NoteEntity[], change: (note: NoteEntity) => object) => {
            const transaction = createTransaction(state)
            return transaction.commit(
                notes.flatMap((note) => editSelectedNote(transaction, note, change(note))),
            )
        }
        const spread = (state: State) => {
            const beats = [...state.store.slides.note.values()].flat().map((note) => note.beat)
            return (note: NoteEntity) => ({ beat: pick(beats) ?? note.beat })
        }

        for (let step = 0; step < 60; step++) {
            const state = pick(states)
            const kind = Math.floor(next() * 8)
            let result = state
            if (kind === 0) {
                result = edit(state, notesOf(state, 20), (note) => ({ left: note.left + 1 }))
            } else if (kind === 1) {
                // Ties between slides: the map's order decides them.
                result = edit(state, notesOf(state, 20), spread(state))
            } else if (kind === 2) {
                const stage = pick([...state.stages.keys()])
                const group = pick([...state.groups.keys()])
                result = edit(state, notesOf(state, 3), () => ({ stageId: stage, groupId: group }))
            } else if (kind === 3) {
                const transaction = createTransaction(state)
                for (const note of notesOf(state, 30))
                    for (const each of state.store.slides.note.get(note.slideId) ?? [])
                        removeNote(transaction, each)
                result = transaction.commit([])
            } else if (kind === 4) {
                // Duplicates, some on the same beats.
                const transaction = createTransaction(state)
                const shift = pick([0, 0, 1, 7])
                for (const note of notesOf(state, 30)) {
                    const slideId = createSlideId()
                    for (const each of state.store.slides.note.get(note.slideId) ?? [])
                        addNote(transaction, slideId, { ...each, beat: each.beat + shift })
                }
                result = transaction.commit([])
            } else if (kind === 5) {
                // Undo, redo and peeks jump to any earlier state.
                result = pick(states)
            } else if (kind === 6) {
                const transaction = createTransaction(state)
                const bpm = [...state.store.grid.bpm.values()].flatMap((cell) => [...cell])[0]!
                result = transaction.commit(editBpm(transaction, bpm, { bpm: bpm.bpm + 1 }))
            } else {
                // A chart switch: a first copy, as onResetState asks for.
                sender.reset()
                check(other, `step ${step} other chart`)
                sender.reset()
            }
            check(result, `step ${step} kind ${kind}`)
            states.push(result)
        }
        // Diffs carried only what changed: far fewer slides than a copy per state.
        assert.ok(sentSlides < first.store.slides.info.size * 30, `${sentSlides} slides sent`)
    })
}

test('the test charts include at least one chart', () => {
    assert.ok(charts.length > 0)
})
