import assert from 'node:assert/strict'
import test from 'node:test'
import { addToFolders, type FolderId, type Folders } from '../../../src/chart/folders'
import { addToStages } from '../../../src/chart/stages'
import { stateFromRecords, toRecords } from '../../../src/local/records/records'
import { goldenChart, stateOf } from './charts'

test('a stage or folder added after fromRecords never reuses an id', () => {
    const fixture = goldenChart()
    // Ids far above any counter, as a restored chart from another tab can hold.
    fixture.chart.stages = new Map(
        [...fixture.chart.stages].map(([id, s]) => [(id + 1000) as never, s]),
    )
    fixture.chart.slides = fixture.chart.slides.map((slide) =>
        slide.map((n) => ({ ...n, stageId: (n.stageId + 1000) as never })),
    )
    for (const key of [
        'stageMaskEvents',
        'stagePivotEvents',
        'stageStyleEvents',
        'stageTransformEvents',
    ] as const)
        (fixture.chart[key] as { stageId: number }[]) = fixture.chart[key].map((e) => ({
            ...e,
            stageId: e.stageId + 1000,
        }))
    fixture.chart.groupFolders = new Map([[1001 as FolderId, { name: 'Folder', index: 0 }]])
    fixture.chart.groups = new Map(
        [...fixture.chart.groups].map(([id, g]) => [id, { ...g, folderId: 1001 as FolderId }]),
    )
    const restored = stateFromRecords(toRecords(stateOf(fixture)))

    for (let i = 0; i < 1100; i++) {
        const stages = new Map(restored.stages)
        const [id] = addToStages(stages)
        assert.equal(stages.size, restored.stages.size + 1)
        assert.ok(!restored.stages.has(id))
    }
    for (let i = 0; i < 1100; i++) {
        const stageFolders: Folders = new Map(restored.stageFolders)
        const id = addToFolders(stageFolders, restored.groupFolders, 'Stage folder')
        // A new stage folder never takes a group folder's id, nor the reverse.
        assert.ok(!restored.groupFolders.has(id))
        const groupFolders: Folders = new Map(restored.groupFolders)
        const groupId = addToFolders(groupFolders, stageFolders, 'Group folder')
        assert.ok(!stageFolders.has(groupId))
        assert.equal(groupFolders.size, restored.groupFolders.size + 1)
    }
})
