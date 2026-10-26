import type { LevelDataEntity } from '@sonolus/core'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { serializeToLevelDataEntities } from '../../src/levelData/entities/serialize'
import { toRecords } from '../../src/local/records/records'
import { encodeSnapshot } from '../../src/local/records/snapshot'
import { createState } from '../../src/state'
import { fullLevel, minimalLevel } from './levelDataSynthetic'

// Names of the Object prototype's members, which a lookup in a plain object would find.
const inherited = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']

/** The level with each entity name and each ref to it renamed. */
const renamed = (entities: LevelDataEntity[], names: Record<string, string>) =>
    entities.map((entity) => ({
        ...entity,
        ...(entity.name === undefined ? {} : { name: names[entity.name] ?? entity.name }),
        data: entity.data.map((item) =>
            'ref' in item ? { ...item, ref: names[item.ref] ?? item.ref } : item,
        ),
    }))

const roundTrip = (entities: LevelDataEntity[]) => {
    const chart = parseLevelDataChart(entities)
    const state = createState(chart, 0)
    // Saving encodes the snapshot; Export writes the level data.
    encodeSnapshot(toRecords(state))
    const written = serializeToLevelDataEntities(
        state.initialLife,
        state.isDynamicStages,
        state.store,
        state.groups,
        state.stages,
    )
    return { chart, written }
}

for (const name of inherited) {
    test(`a group and a stage named ${name} are ordinary names`, () => {
        const { chart, written } = roundTrip(
            renamed(fullLevel(), { g0: name, s0: name === '__proto__' ? 'constructor' : name }),
        )
        assert.equal(chart.groups.size, 1)
        assert.equal(chart.stages.size, 1)
        assert.equal(written.filter((entity) => entity.archetype === '#TIMESCALE_GROUP').length, 1)
        assert.equal(written.filter((entity) => entity.archetype === 'Stage').length, 1)
    })

    test(`a note in a group named ${name} stays in it`, () => {
        const { chart, written } = roundTrip(renamed(minimalLevel(), { g0: name }))
        assert.equal(chart.groups.size, 1)
        const group = written.find((entity) => entity.archetype === '#TIMESCALE_GROUP')
        const note = written.find((entity) => entity.archetype === 'NormalTapNote')
        const link = note?.data.find((item) => item.name === '#TIMESCALE_GROUP')
        assert.ok(group?.name !== undefined)
        assert.deepEqual(link, { name: '#TIMESCALE_GROUP', ref: group.name })
    })
}

for (const name of inherited) {
    test(`a ref to ${name}, which no group or stage has, is refused`, () => {
        const refer = (entities: LevelDataEntity[], field: string) =>
            entities.map((entity) => ({
                ...entity,
                data: entity.data.map((item) =>
                    item.name === field ? { name: field, ref: name } : item,
                ),
            }))
        for (const field of ['#TIMESCALE_GROUP', 'stage'])
            assert.throws(() => parseLevelDataChart(refer(fullLevel(), field)), {
                reason: 'refNotFound',
            })
    })
}
