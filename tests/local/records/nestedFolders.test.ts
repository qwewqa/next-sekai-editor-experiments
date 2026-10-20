import type { LevelData } from '@sonolus/core'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildFolderTree,
    flattenFolderTree,
    normalizeFolders,
    stageFolderArchetype,
    type FolderId,
    type FolderTreeItem,
} from '../../../src/chart/folders'
import { parseLevelDataChart } from '../../../src/chart/parse/levelData'
import { serializeEditorMetadata } from '../../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../../src/levelData/serialize'
import { toHex } from '../../../src/local/hash'
import { stateFromRecords, toRecords } from '../../../src/local/records/records'
import { decodeSnapshot, encodeSnapshot } from '../../../src/local/records/snapshot'
import { createState, type State } from '../../../src/state'
import { folder, goldenChart, stage, stateOf } from './charts'

// Nested folders in v1 (owner decision, 2026-10-19; plan §1.6.11.1): the record schema keeps
// `folder.folderId` on purpose, and a later nesting feature writes v1 roots. This build never sets
// it, so what it does with one is pinned here: the state loads, shows its folders flat (each at
// the top level with its own members), edits and saves without throwing, and the link survives a
// round trip through records. `level.json` has no nesting to carry, so it shows the folders flat.

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

/** Records through the snapshot encoding and back, as a stored root is read. */
const throughSnapshot = (state: State) => {
    const encoded = encodeSnapshot(toRecords(state))
    const byHash = new Map<string, unknown>()
    for (const item of [encoded.header, ...encoded.chunks, ...encoded.nodes])
        byHash.set(toHex(item.hash), item.json)
    const read = (hash: string) => byHash.get(hash)
    return {
        encoded,
        state: stateFromRecords(decodeSnapshot(encoded.root.json, { node: read, chunk: read })),
    }
}

const nested = () => stateOf(goldenChart())

const show = (tree: readonly FolderTreeItem<number>[]) =>
    tree.map((item) =>
        item.type === 'entry' ? `${item.id}` : `[${item.id}: ${item.members.join(' ')}]`,
    )

test('the golden state holds a stage folder nested in another', () => {
    const state = nested()
    assert.equal(state.stageFolders.get(folder(3))?.folderId, folder(2))
    assert.equal(state.stageFolders.get(folder(2))?.folderId, undefined)
})

test('a nested folder loads from its records and re-encodes to the same root', () => {
    const state = nested()
    const { encoded, state: back } = throughSnapshot(state)
    assert.equal(back.stageFolders.get(folder(3))?.folderId, folder(2))
    assert.equal(toHex(encodeSnapshot(toRecords(back)).root.hash), toHex(encoded.root.hash))
})

test('the Manager’s tree shows nested folders flat, each with its own members, and loses nothing', () => {
    const { state } = throughSnapshot(nested())
    // Inner has no member: it is listed at the top level, after the folder that holds it.
    let tree = buildFolderTree(state.stages, state.stageFolders)
    assert.deepEqual(show(tree), ['1', '[2: 2]', '[3: ]'])
    // With a member of its own it shows at the top level with it, beside its parent.
    const stages = new Map(state.stages)
    stages.set(stage(1), { ...state.stages.get(stage(1))!, folderId: folder(3) })
    tree = buildFolderTree(stages, state.stageFolders)
    assert.deepEqual(show(tree), ['[3: 1]', '[2: 2]'])
    // No tree item is a folder in a folder, and every stage and folder is still shown.
    for (const item of tree) assert.ok(item.type === 'folder' || item.type === 'entry')
    assert.deepEqual(
        tree.flatMap((item) => (item.type === 'folder' ? item.members : [item.id])).sort(),
        [...stages.keys()].sort(),
    )
    assert.deepEqual(
        tree.flatMap((item) => (item.type === 'folder' ? [item.id] : [])).sort(),
        [...state.stageFolders.keys()].sort(),
    )
})

test('an edit through the tree keeps both folders and the nesting link', () => {
    const { state } = throughSnapshot(nested())
    const flat = normalizeFolders(state.stages, state.stageFolders)
    assert.deepEqual([...flat.folders.keys()].sort(), [folder(2), folder(3)])
    assert.equal(flat.folders.get(folder(3))?.folderId, folder(2))
    assert.deepEqual([...flat.entries.keys()], [stage(1), stage(2)])
    // Moving the loose stage into Inner and writing the tree back is an ordinary edit.
    const tree = buildFolderTree(state.stages, state.stageFolders)
    const moved: FolderTreeItem<ReturnType<typeof stage>>[] = [
        { type: 'folder', id: folder(3), members: [stage(1)] },
        ...tree.filter((item) => item.type === 'folder' && item.id === folder(2)),
    ]
    const written = flattenFolderTree(moved, state.stages, state.stageFolders)
    assert.equal(written.entries.get(stage(1))?.folderId, folder(3))
    assert.equal(written.folders.get(folder(3))?.folderId, folder(2))
    // And the result saves: a chart with it encodes, and reads back with the link and the move.
    const fixture = goldenChart()
    fixture.chart.stages = written.entries
    fixture.chart.stageFolders = written.folders
    const saved = throughSnapshot(stateOf(fixture)).state
    assert.equal(saved.stageFolders.get(folder(3))?.folderId, folder(2))
    assert.equal(saved.stages.get(stage(1))?.folderId, folder(3))
})

test('level data shows the folders flat: no folder entity names another, and it parses back whole', () => {
    const state = nested()
    const { entities } = levelDataOf(state)
    const folderEntities = entities.filter((e) => e.archetype === stageFolderArchetype)
    assert.equal(folderEntities.length, 2)
    for (const entity of folderEntities)
        assert.ok(!entity.data.some((field) => field.name === 'editorFolder'))
    const { defaultGuideColors } = serializeEditorMetadata(entities, state.store)
    const chart = parseLevelDataChart(entities, defaultGuideColors)
    // Both folders come back at the top level; the stage that was in Stage folder still is.
    const stageFolders = chart.stageFolders ?? new Map()
    assert.equal(stageFolders.size, 2)
    for (const folderObject of stageFolders.values()) assert.equal(folderObject.folderId, undefined)
    const sides = [...chart.stages.values()].find((s) => s.name === 'Side')
    assert.ok(sides?.folderId !== undefined)
    assert.equal(stageFolders.get(sides.folderId)?.name, 'Stage folder')
    // Re-serializing the flat chart is stable: nothing was lost that level data can hold.
    const again = levelDataOf(createState(chart, state.bgm.offset, { levelInfo: state.levelInfo }))
    assert.equal(again.entities.filter((e) => e.archetype === stageFolderArchetype).length, 2)
})

test('a nested state’s file opens: the history head keeps the nesting, level.json is flat and matches it', async () => {
    const { executePlan, planNxsp, readNxsp } = await import('../../../src/local/nxsp')
    const { fresh } = await import('../nxsp/chain')
    const { levelDataMatchesState } = await import('../../../src/local/records/normalised')
    const file = await executePlan(planNxsp(fresh().input).plan, new Map())
    const read = await readNxsp(file)
    assert.equal(read.kind, 'nxsp')
    if (read.kind !== 'nxsp' || !read.history) throw new Error('not a file with history')
    assert.equal(read.open, 'full')
    const head = stateFromRecords(read.history.headRecords)
    assert.equal(head.stageFolders.get(folder(3) as FolderId)?.folderId, folder(2))
    const level = read.level as { bgmOffset: number; entities: LevelData['entities'] }
    // The level in the file has no nesting, and still matches the head: the open keeps the head.
    assert.ok(
        !level.entities.some((e) =>
            e.data.some((d) => d.name === 'editorFolder' && e.archetype === stageFolderArchetype),
        ),
    )
    assert.equal(
        levelDataMatchesState(
            level.entities,
            level.bgmOffset,
            read.project?.editor.defaultGuideColors,
            head,
        ),
        true,
    )
})
