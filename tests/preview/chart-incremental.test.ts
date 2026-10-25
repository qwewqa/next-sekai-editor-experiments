import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import test from 'node:test'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { parseLevelData } from '../../src/levelData/parse'
import { buildPreviewChart, createPreviewChartBuilder } from '../../src/preview/engine/chart'
import type { PreviewChart } from '../../src/preview/engine/model'
import { renderPreviewFrame } from '../../src/preview/engine/render'
import type { PreviewRenderer } from '../../src/preview/gl'
import { resolveSkin } from '../../src/preview/skin'
import { createState, type State } from '../../src/state'
import { createSlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { addNote, removeNote } from '../../src/state/mutations/slides/note'
import { editBpm } from '../../src/state/operations/bpm'
import { editSelectedNote } from '../../src/state/operations/note'
import { createTransaction } from '../../src/state/transaction'

// The builder merges changed slides into its last order. After any sequence of
// edits, undo, redo and jumps it must equal a fresh build element by element.

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
const frames = (chart: PreviewChart, times: number[]) => {
    draws = []
    for (const now of times)
        renderPreviewFrame(renderer, skin, chart, now, 1600, 900, 1600, 900, speed, false)
    return draws.join('\n')
}

const same = <T>(actual: T[], expected: T[], label: string) => {
    assert.equal(actual.length, expected.length, `${label} length`)
    for (const [index, value] of actual.entries())
        assert.equal(value, expected[index], `${label}[${index}]`)
}

const assertEqualBuild = (actual: PreviewChart, expected: PreviewChart, label: string) => {
    same(
        actual.notes.map((note) => note.source),
        expected.notes.map((note) => note.source),
        `${label} notes`,
    )
    same(
        actual.connectors.flatMap((c) => [c.head.source, c.tail.source]),
        expected.connectors.flatMap((c) => [c.head.source, c.tail.source]),
        `${label} connectors`,
    )
    same(
        actual.slides.map((slide) => slide.activeHead.source),
        expected.slides.map((slide) => slide.activeHead.source),
        `${label} slides`,
    )
    same(
        actual.chains.map((chain) => chain.infos),
        expected.chains.map((chain) => chain.infos),
        `${label} chains`,
    )
    same(
        actual.simLines.flatMap((line) => [line.left.source, line.right.source]),
        expected.simLines.flatMap((line) => [line.left.source, line.right.source]),
        `${label} sim lines`,
    )
    assert.deepEqual(actual, expected, label)
}

type Info = State['store']['slides']['info']

const withSlides = (state: State, order: (info: Info) => Info) => ({
    ...state,
    store: {
        ...state.store,
        slides: { ...state.store.slides, info: order(state.store.slides.info) },
    },
})

for (const path of charts) {
    test(`incremental builds equal fresh builds over random edits: ${path}`, () => {
        const next = random(path.length * 7919 + 1)
        const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)] as T
        const count = (max: number) => 1 + Math.floor(next() * max)
        const first = load(path)
        const other = load(path)
        const states: State[] = [first]
        const build = createPreviewChartBuilder()
        let built = 0
        const check = (state: State, label: string) => {
            const fresh = buildPreviewChart(state, speed)
            assertEqualBuild(build(state, speed), fresh, label)
            if (built++ % 10 === 0) {
                const end = Math.max(...fresh.notes.map((note) => note.targetTime))
                const times = [0.25, 0.5, 0.75].map((fraction) => end * fraction)
                assert.equal(
                    frames(build(state, speed), times),
                    frames(fresh, times),
                    `${label} draws`,
                )
            }
            return fresh
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

        // A note of a later slide moves onto an earlier slide's note, then an
        // edit of the earlier slide moves it to the end of the map. Undoing that
        // edit puts it back before the tied note.
        const slides = [...first.store.slides.note.values()]
        const early = slides[1]![0]!
        const late = slides[Math.min(8, slides.length - 1)]![0]!
        const tied = edit(first, [late], () => ({ beat: early.beat }))
        const moved = edit(tied, [early], () => ({ left: early.left + 1 }))
        const tiedChart = check(tied, 'tie')
        const times = new Set(tiedChart.notes.map((note) => note.targetTime))
        assert.ok(times.size < tiedChart.notes.length, 'the tie exists')
        check(moved, 'edit tied slide')
        check(tied, 'undo it')
        states.push(tied, moved)

        // Unchanged slides swap places in the map.
        const swapped = withSlides(tied, (info) => {
            const entries = [...info]
            const a = entries.findIndex(([id]) => id === early.slideId)
            const b = entries.findIndex(([id]) => id === late.slideId)
            ;[entries[a], entries[b]] = [entries[b]!, entries[a]!]
            return new Map(entries)
        })
        check(swapped, 'swapped slides')
        states.push(swapped)

        for (let step = 0; step < 60; step++) {
            const state = pick(states)
            const kind = Math.floor(next() * 9)
            let result = state
            if (kind === 0) {
                result = edit(state, notesOf(state, 20), (note) => ({ left: note.left + 1 }))
            } else if (kind === 1) {
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
                const transaction = createTransaction(state)
                const shift = pick([0, 0, 1, 7])
                for (const note of notesOf(state, 30)) {
                    const slideId = createSlideId()
                    for (const each of state.store.slides.note.get(note.slideId) ?? [])
                        addNote(transaction, slideId, { ...each, beat: each.beat + shift })
                }
                result = transaction.commit([])
            } else if (kind === 5) {
                result = pick(states)
            } else if (kind === 6) {
                const transaction = createTransaction(state)
                const bpm = [...state.store.grid.bpm.values()].flatMap((cell) => [...cell])[0]!
                result = transaction.commit(editBpm(transaction, bpm, { bpm: bpm.bpm + 1 }))
            } else if (kind === 7) {
                const grid = state.store.grid
                result = {
                    ...state,
                    store: {
                        ...state.store,
                        grid: { ...grid, timeScale: new Map(grid.timeScale) },
                    },
                }
            } else {
                check(other, 'other chart')
            }
            check(result, `step ${step} kind ${kind}`)
            states.push(result)
        }
    })
}

test('the test charts include at least one chart', () => {
    assert.ok(charts.length > 0)
})
