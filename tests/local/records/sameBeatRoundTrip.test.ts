import type { LevelData } from '@sonolus/core'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parseLevelDataChart } from '../../../src/chart/parse/levelData'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import { toHex } from '../../../src/local/hash'
import { extractChart } from '../../../src/local/records/extract'
import {
    levelDataMatchesState,
    normalisedRecords,
    normalisedText,
} from '../../../src/local/records/normalised'
import { stateFromRecords, toRecords } from '../../../src/local/records/records'
import { decodeSnapshot, encodeSnapshot } from '../../../src/local/records/snapshot'
import { createState, type State } from '../../../src/state'
import { recordsText } from './charts'
import { allSameBeatGroups, playOrder, playOrderDifferences, sameBeatCounts } from './playOrder'
import { coconutPath, hasCoconut, readLevelData, samplePaths } from './samples'
import { stateOrderDifferences } from './stateOrder'

// No round trip changes the order in which same-beat events, BPMs or time-scale changes play.

const levelDataOf = (state: State): LevelData =>
    serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )

/** Records through the snapshot encoding and back, as the flush stores and a reload reads them. */
const throughSnapshot = (records: ReturnType<typeof toRecords>) => {
    const encoded = encodeSnapshot(records)
    const byHash = new Map<string, unknown>()
    for (const item of [encoded.header, ...encoded.chunks, ...encoded.nodes])
        byHash.set(toHex(item.hash), item.json)
    const read = (hash: string) => byHash.get(hash)
    return decodeSnapshot(encoded.root.json, { node: read, chunk: read })
}

/**
 * Level data → parse → state → records → snapshot → state → level data → parse → state, checking
 * the play order of every same-beat group at both level-data ends, the chains against the grid
 * in every state, and the records across the second round.
 */
export const assertSameBeatRoundTrip = (path: string) => {
    const { bgmOffset, entities } = readLevelData(path)
    const original = playOrder(entities)

    const first = createState(parseLevelDataChart(entities), bgmOffset)
    const records = toRecords(first)
    const restored = stateFromRecords(throughSnapshot(records))
    const saved = levelDataOf(restored)
    const { defaultGuideColors } = serializeEditorMetadata(saved.entities, restored.store)
    const reopened = createState(
        parseLevelDataChart(saved.entities, defaultGuideColors),
        saved.bgmOffset,
    )
    const resaved = levelDataOf(reopened)
    const again = createState(
        parseLevelDataChart(
            resaved.entities,
            serializeEditorMetadata(resaved.entities, reopened.store).defaultGuideColors,
        ),
        resaved.bgmOffset,
    )

    const after = playOrder(saved.entities)
    assert.deepEqual(playOrderDifferences(original, after), [], path)
    // Once saved, a second round changes nothing at all.
    assert.deepEqual(
        playOrderDifferences(after, playOrder(resaved.entities), { whole: true }),
        [],
        path,
    )

    for (const [name, state] of [
        ['opened', first],
        ['restored', restored],
        ['reopened', reopened],
    ] as const)
        assert.deepEqual(stateOrderDifferences(state), [], `${path} (${name})`)
    assert.deepEqual(restored.bpms, first.bpms, path)

    const text = recordsText(records)
    assert.equal(recordsText(toRecords(restored)), text, path)
    // Level data gives groups and stages new ids, so a reopened state compares renumbered. Its
    // events, BPMs and time scales match at once; an attached tick's lane is recomputed on open
    // and can move by rounding once, so slides match from the second reopening.
    const normalised = (state: State, withSlides = true) => {
        const { header, kinds } = normalisedRecords(extractChart(state), state.bgm.offset)
        return normalisedText({
            header,
            kinds: kinds.filter(({ kind }) => withSlides || kind !== 'slides'),
        })
    }
    assert.equal(normalised(reopened, false), normalised(first, false), path)
    assert.equal(normalised(again), normalised(reopened), path)

    return {
        original,
        groups: allSameBeatGroups(original).length,
        counts: sameBeatCounts(original),
    }
}

test('same-beat events, BPMs and time scales of every sample level play in one order after a round trip', () => {
    for (const path of samplePaths) assertSameBeatRoundTrip(path)
})

test(
    'coconut’s same-beat mask pair, byte order the reverse of its chain, survives a round trip',
    { skip: !hasCoconut && 'no coconut' },
    () => {
        assert.ok(assertSameBeatRoundTrip(coconutPath).counts.mask, 'a same-beat mask group')
    },
)

// The corpus is third-party and never committed; this runs only where it exists.
const corpus = [3, 4, 5]
    .map((up) => join(import.meta.dirname, '../'.repeat(up), 'work/step0/corpus'))
    .find((path) => existsSync(path))

test(
    'same-beat order survives the round trip in every corpus level',
    { skip: !corpus && 'no corpus' },
    () => {
        if (!corpus) return
        const paths = readdirSync(corpus, { recursive: true, encoding: 'utf8' })
            .filter((path) => path.endsWith('.gz'))
            .map((path) => join(corpus, path))
        assert.ok(paths.length)
        let groups = 0
        for (const path of paths) groups += assertSameBeatRoundTrip(path).groups
        assert.ok(groups > 0)
    },
)

test(
    'a level.json whose same-beat pair plays in the other order does not match the state',
    { skip: !hasCoconut && 'no coconut' },
    () => {
        const { bgmOffset, entities } = readLevelData(coconutPath)
        const state = createState(parseLevelDataChart(entities), bgmOffset)
        const saved = levelDataOf(state)
        const { defaultGuideColors } = serializeEditorMetadata(saved.entities, state.store)
        assert.ok(levelDataMatchesState(saved.entities, saved.bgmOffset, defaultGuideColors, state))

        // Coconut's two mask changes at beat 129 swap their values, keeping the chain's refs.
        const swapped = structuredClone(saved.entities)
        type Entity = (typeof swapped)[number]
        const atBeat = swapped.filter(
            (entity) =>
                entity.archetype === 'StageMaskChange' &&
                entity.data.some(
                    (data) => data.name === '#BEAT' && 'value' in data && data.value === 129,
                ),
        )
        const next = (entity: Entity) =>
            entity.data.find((data) => data.name === 'next' && 'ref' in data) as
                { ref: string } | undefined
        // The two at beat 129 on one chain: the first's next is the second.
        const a = atBeat.find((entity) => atBeat.some((other) => other.name === next(entity)?.ref))
        const b = atBeat.find((entity) => entity.name === (a && next(a)?.ref))
        assert.ok(a && b)
        const values = (entity: Entity) => entity.data.filter((data) => data.name !== 'next')
        const refs = (entity: Entity) => entity.data.filter((data) => data.name === 'next')
        ;[a.data, b.data] = [
            [...values(b), ...refs(a)],
            [...values(a), ...refs(b)],
        ]
        assert.deepEqual(
            playOrderDifferences(playOrder(saved.entities), playOrder(swapped)).length,
            1,
        )
        assert.equal(
            levelDataMatchesState(swapped, saved.bgmOffset, defaultGuideColors, state),
            false,
        )
    },
)
