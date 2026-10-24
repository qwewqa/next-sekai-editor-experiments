import assert from 'node:assert/strict'
import test from 'node:test'
import { gzip, ungzip } from 'pako'
import type { Chart } from '../../src/chart'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { parseClipboardData } from '../../src/clipboard/data/parse'
import { parseAutoSave } from '../../src/history/autoSave/parse'
import { serializeAutoSave } from '../../src/history/autoSave/serialize'
import { peek, pushState, redoState, resetStates, state, undoState } from '../../src/history/stack'
import { serializeEditorMetadata } from '../../src/levelData/editorMetadata'
import { serializeToLevelDataEntities } from '../../src/levelData/entities/serialize'
import { stateFromRecords, toRecords } from '../../src/local/records/records'
import type { State } from '../../src/state'
import type { Entity } from '../../src/state/entities'
import { inStoredOrder, transformSelection } from '../../src/state/operations/transformSelection'
import { createStore } from '../../src/state/store/creates'
import type { Transaction } from '../../src/state/transaction'
import { futureInitialLife, initialStep, originOperation } from '../helpers/historySteps'
import { recordsText } from '../local/records/charts'
import {
    add,
    baseState,
    chartOrder,
    edits,
    entityAt,
    keptOrders,
    kinds,
    levelDataOf,
    openLevelData,
    sameTrack,
    seen,
    type Kind,
} from './sameBeatKinds'

// Through the editor's own edit functions, the same-beat order the user sees is what the
// records keep, and every round trip keeps it.

const permutations = [
    [1, 2, 3],
    [1, 3, 2],
    [2, 1, 3],
    [2, 3, 1],
    [3, 1, 2],
    [3, 2, 1],
]

const assertKept = (state: State, kind: Kind, beat: number, expected: number[], track = 1) => {
    const orders = keptOrders(state, kind, beat, track)
    assert.deepEqual(
        orders,
        { seen: expected, records: expected, restored: expected, levelData: expected },
        `${kind.name} at ${beat} on ${track}`,
    )
}

test('same-beat objects play in the order they were added, and every round trip keeps it', () => {
    for (const kind of kinds)
        for (const [n, order] of permutations.entries()) {
            // Neighbours before and after, added before, between and after the three.
            const neighbours = [
                (t: Transaction) => add(t, kind, 2, 20),
                (t: Transaction) => add(t, kind, 6, 60),
            ]
            const steps: ((t: Transaction) => unknown)[] = order.map(
                (tag) => (t: Transaction) => add(t, kind, 4, tag),
            )
            steps.splice(n % 4, 0, ...neighbours.slice(0, 1))
            steps.splice((n + 2) % 5, 0, ...neighbours.slice(1))
            // The other track gets the reverse, interleaved, when the kind has tracks.
            if (kind.track)
                for (const [i, tag] of [...order].reverse().entries())
                    steps.splice(2 * i + 1, 0, (t: Transaction) => add(t, kind, 4, tag + 10, 2))
            const result = edits(baseState(), ...steps)
            assertKept(result, kind, 4, order)
            if (kind.track)
                assertKept(
                    result,
                    kind,
                    4,
                    [...order].reverse().map((tag) => tag + 10),
                    2,
                )
        }
})

/** A pair at beat 4, added as 1 then 2, with neighbours at 2 and 6. */
const pair = (kind: Kind) =>
    edits(
        baseState(),
        (t) => add(t, kind, 2, 20),
        (t) => add(t, kind, 4, 1),
        (t) => add(t, kind, 6, 60),
        (t) => add(t, kind, 4, 2),
    )

test('editing a same-beat object in place keeps its place', () => {
    for (const kind of kinds) {
        const before = pair(kind)
        const [one, two] = [1, 2].map((tag) => entityAt(before, kind, 4, tag)) as [Entity, Entity]
        for (const changes of [
            [[two, kind.edit]],
            [[one, kind.edit]],
            [
                [two, kind.edit],
                [one, kind.edit],
            ],
        ] as const) {
            const after = transformSelection(
                before,
                [],
                new Map(changes as unknown as [never, never][]),
            )
            assert.notEqual(after, before, kind.name)
            assertKept(after, kind, 4, [1, 2])
        }
    }
})

test('moving a same-beat pair keeps its order whatever the selection order', () => {
    for (const kind of kinds) {
        const before = pair(kind)
        const [one, two] = [1, 2].map((tag) => entityAt(before, kind, 4, tag)) as [Entity, Entity]
        for (const selection of [
            [one, two],
            [two, one],
        ]) {
            const after = transformSelection(
                before,
                selection,
                new Map(selection.map((entity) => [entity as never, { beat: 8 }])),
            )
            assert.deepEqual(seen(after, kind, 4), [], kind.name)
            assertKept(after, kind, 8, [1, 2])
        }
    }
})

test('moving one of a same-beat pair away and back puts it last, and that order is what is kept', () => {
    // The select tool's drag moves an event as a remove and an add (select.ts `moves`).
    for (const kind of kinds) {
        const before = pair(kind)
        const away = edits(before, (t) => {
            kind.remove(t, entityAt(before, kind, 4, 1) as never)
            add(t, kind, 9, 1)
        })
        assertKept(away, kind, 4, [2])
        const back = edits(away, (t) => {
            kind.remove(t, entityAt(away, kind, 9, 1) as never)
            add(t, kind, 4, 1)
        })
        assertKept(back, kind, 4, [2, 1])
        assert.notEqual(recordsText(toRecords(back)), recordsText(toRecords(before)), kind.name)
    }
})

test('undo and redo restore the same-beat order and the records of each step', () => {
    for (const kind of kinds) {
        const before = pair(kind)
        const reversed = edits(before, (t) => {
            kind.remove(t, entityAt(before, kind, 4, 1) as never)
            add(t, kind, 4, 1)
        })
        const edited = transformSelection(
            reversed,
            [],
            new Map([[entityAt(reversed, kind, 4, 2) as never, kind.edit as never]]),
        )
        const texts = [before, reversed, edited].map((s) => recordsText(toRecords(s)))
        peek.value = undefined
        resetStates({ isDirty: false, step: initialStep(originOperation()), state: before })
        pushState(futureInitialLife(before.initialLife, reversed.initialLife, 'Reversed'), reversed)
        pushState(futureInitialLife(reversed.initialLife, edited.initialLife, 'Edited'), edited)
        const check = (index: number, order: number[]) => {
            assert.deepEqual(seen(state.value, kind, 4), order, `${kind.name} step ${index}`)
            assert.equal(recordsText(toRecords(state.value)), texts[index], kind.name)
            assertKept(state.value, kind, 4, order)
        }
        check(2, [2, 1])
        undoState()
        check(1, [2, 1])
        undoState()
        check(0, [1, 2])
        redoState()
        check(1, [2, 1])
        redoState()
        check(2, [2, 1])
    }
})

/** Copy's clipboard text for a selection (commands/copy: stored order, its own store, no folders). */
const copyText = (source: State, selection: Entity[]) => {
    const of = (kind: Kind) =>
        inStoredOrder(
            source,
            selection.filter((entity) => entity.type === kind.type),
            (entity) => entity,
        )
    const chart = {
        initialLife: source.initialLife,
        isDynamicStages: source.isDynamicStages,
        groups: source.groups,
        stages: source.stages,
        slides: [],
        ...Object.fromEntries(kinds.map((kind) => [kind.chart, of(kind)])),
    } as unknown as Chart
    const store = createStore(chart, source.bpms)
    const entities = serializeToLevelDataEntities(
        source.initialLife,
        source.isDynamicStages,
        store,
        source.groups,
        source.stages,
    )
    return JSON.stringify({
        lane: 0,
        beat: 4,
        entities,
        ...serializeEditorMetadata(entities, store),
    })
}

/** Paste's adds for clipboard text, in the parsed chart's order (tools/paste: `transform`, `pastes`). */
const pasteText = (target: State, text: string, beatOffset: number) => {
    const data = parseClipboardData(JSON.parse(text))
    const chart = parseLevelDataChart(data.entities, data.defaultGuideColors)
    const mapped = (ids: Map<number, unknown>, from: Map<number, unknown>, id: number) =>
        [...ids.keys()][[...from.keys()].indexOf(id)]
    return edits(target, (t) => {
        for (const kind of kinds)
            for (const object of chart[kind.chart] as Record<string, number>[]) {
                const moved: Record<string, number> = {
                    ...object,
                    beat: (object.beat ?? 0) + beatOffset,
                }
                if (kind.track === 'stageId')
                    moved.stageId = mapped(target.stages, chart.stages, object.stageId!) as number
                if (kind.track === 'groupId')
                    moved.groupId = mapped(target.groups, chart.groups, object.groupId!) as number
                kind.add(t, moved as never)
            }
    })
}

test('copied and pasted same-beat objects keep their order, whatever the selection order', () => {
    for (const kind of kinds) {
        const before = edits(pair(kind), (t) => {
            // The reverse order on the other track, where there is one.
            if (!kind.track) return
            add(t, kind, 4, 12, 2)
            add(t, kind, 4, 11, 2)
        })
        const selection = [...[1, 2].map((tag) => entityAt(before, kind, 4, tag))]
        if (kind.track) selection.push(...[11, 12].map((tag) => entityAt(before, kind, 4, tag, 2)))
        for (const order of [selection, [...selection].reverse()]) {
            const text = copyText(before, order)
            const pasted = pasteText(before, text, 8)
            assertKept(pasted, kind, 12, [1, 2])
            if (kind.track) assertKept(pasted, kind, 12, [12, 11], 2)
            // The source is untouched.
            assertKept(pasted, kind, 4, [1, 2])
        }
    }
})

/** A state with a same-beat triple in an unsorted order on each track of every kind. */
const triples = () =>
    edits(
        baseState(),
        ...kinds.flatMap((kind) => [
            (t: Transaction) => add(t, kind, 4, 3),
            (t: Transaction) => add(t, kind, 4, 1),
            (t: Transaction) => add(t, kind, 4, 2),
            ...(kind.track
                ? [
                      (t: Transaction) => add(t, kind, 4, 11, 2),
                      (t: Transaction) => add(t, kind, 4, 13, 2),
                      (t: Transaction) => add(t, kind, 4, 12, 2),
                  ]
                : []),
        ]),
    )

const assertTriples = (source: State, restored: State, name: string) => {
    for (const kind of kinds) {
        assert.deepEqual(
            seen(restored, kind, 4, sameTrack(kind, source, restored, 1)),
            [3, 1, 2],
            `${name}: ${kind.name}`,
        )
        if (kind.track)
            assert.deepEqual(
                seen(restored, kind, 4, sameTrack(kind, source, restored, 2)),
                [11, 13, 12],
                `${name}: ${kind.name}`,
            )
    }
}

test('the auto save, the journal’s level data and the clipboard keep same-beat order', () => {
    const source = triples()
    for (const kind of kinds) assertKept(source, kind, 4, [3, 1, 2])
    const levelData = levelDataOf(source)
    const metadata = serializeEditorMetadata(levelData.entities, source.store)

    // The auto save (history/autoSave): written as JSON text, read back as the app reads it.
    const autoSave = parseAutoSave(
        JSON.parse(JSON.stringify(serializeAutoSave(levelData, 'chart.json', metadata))),
    )
    assertTriples(
        source,
        openLevelData(
            autoSave.levelData.entities,
            autoSave.levelData.bgmOffset,
            autoSave.defaultGuideColors,
        ),
        'auto save',
    )

    // The journal's levelDataGz: gzip level 1, base64, decoded into level data.
    const bytes = gzip(JSON.stringify(levelData), { level: 1 })
    const base64 = Buffer.from(bytes).toString('base64')
    const decoded = JSON.parse(
        new TextDecoder().decode(ungzip(Buffer.from(base64, 'base64'))),
    ) as typeof levelData
    assertTriples(
        source,
        openLevelData(decoded.entities, decoded.bgmOffset, metadata.defaultGuideColors),
        'journal level data',
    )

    // The records a journal's state is stored as (the flush), and the clipboard.
    assertTriples(source, stateFromRecords(toRecords(source)), 'records')
    const selection = kinds.flatMap((kind) => [
        ...[3, 1, 2].map((tag) => entityAt(source, kind, 4, tag)),
        ...(kind.track ? [11, 13, 12].map((tag) => entityAt(source, kind, 4, tag, 2)) : []),
    ])
    const text = copyText(source, selection.reverse())
    const clipboard = parseLevelDataChart(parseClipboardData(JSON.parse(text)).entities)
    for (const kind of kinds) {
        const tracks = [...(kind.track === 'groupId' ? clipboard.groups : clipboard.stages).keys()]
        const track = kind.track ? (tracks[0] as number) : 1
        assert.deepEqual(chartOrder(clipboard, kind, 4, track), [3, 1, 2], kind.name)
    }
    assertTriples(source, pasteText(baseState(), text, 0), 'clipboard')
})
