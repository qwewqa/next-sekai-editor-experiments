import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { parseAutoSave } from '../../src/history/autoSave/parse'
import { serializeAutoSave } from '../../src/history/autoSave/serialize'
import { serializeToLevelData } from '../../src/levelData/serialize'
import { toRecoveryFile } from '../../src/local/startup/legacy'
import { parseAutoSaveSlot } from '../../src/local/startup/steps'
import { goldenChart, stateOf } from '../local/records/charts'

test('large compressed recovery data round trips without exceeding the argument limit', () => {
    const levelData = {
        bgmOffset: 0.125,
        entities: Array.from({ length: 2000 }, () => ({
            name: randomBytes(100).toString('hex'),
            archetype: 'NormalNote',
            data: [{ name: 'style', value: 3 }],
        })),
    }
    const saved = serializeAutoSave(levelData, 'large-chart')
    assert.ok(atob(saved.levelData).length > 128 * 1024)
    assert.deepEqual(parseAutoSave(saved), { filename: 'large-chart', levelData })
})

test('a recovery with a null guide alpha, as older editors saved, restores it as 1', () => {
    const levelData = (value: number | null) => ({
        bgmOffset: 0,
        entities: [
            {
                archetype: 'AnchorNote',
                data: [
                    { name: 'segmentAlpha', value },
                    { name: 'size', value: 1 },
                ],
            },
        ],
    })
    const saved = serializeAutoSave(levelData(null) as never, 'guide')
    assert.deepEqual(parseAutoSave(saved), { filename: 'guide', levelData: levelData(1) })
    // The unversioned format is the level data itself.
    assert.deepEqual(parseAutoSave(levelData(null)), { levelData: levelData(1) })
})

// The old auto save's side of recovery (Part 1 §1.8): what a recovery file is, and which slots the
// migration reads.

const gzipBase64 = (value: unknown) => gzipSync(JSON.stringify(value)).toString('base64')

test('a recovery file is the journal’s or the slot’s gzipped level data as .nsld, raw level data as .json', async () => {
    const levelData = { bgmOffset: 0, entities: [] }
    const journal = {
        journalVersion: 1,
        kind: 'journal',
        levelDataGz: gzipBase64(levelData),
        descriptor: { name: 'Coconut', sourceName: 'coconut' },
    }
    const fromJournal = toRecoveryFile(JSON.stringify(journal))
    assert.equal(fromJournal.name, 'Coconut.nsld')
    assert.deepEqual(
        Buffer.from(await fromJournal.blob.arrayBuffer()),
        Buffer.from(journal.levelDataGz, 'base64'),
    )
    const unnamed = { ...journal, descriptor: { sourceName: 'coconut' } }
    assert.equal(toRecoveryFile(JSON.stringify(unnamed)).name, 'coconut.nsld')
    assert.equal(
        toRecoveryFile(JSON.stringify({ ...journal, descriptor: {} })).name,
        'Untitled.nsld',
    )
    const slot = serializeAutoSave(levelData, 'old')
    const fromSlot = toRecoveryFile(JSON.stringify(slot))
    assert.equal(fromSlot.name, 'old.nsld')
    assert.deepEqual(
        Buffer.from(await fromSlot.blob.arrayBuffer()),
        Buffer.from(slot.levelData, 'base64'),
    )
    const raw = JSON.stringify(levelData)
    const fromRaw = toRecoveryFile(raw)
    assert.equal(fromRaw.name, 'Recovery.json')
    assert.equal(await fromRaw.blob.text(), raw)
    assert.equal(toRecoveryFile('{"broken').name, 'Recovery.txt')
})

test('the migration reads a slot this build reads whole, and leaves one it doesn’t', () => {
    const state = stateOf(goldenChart())
    const levelData = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        0.5,
        state.store,
        state.groups,
        state.stages,
    )
    const slot = parseAutoSaveSlot(JSON.stringify(serializeAutoSave(levelData, 'mine')))
    assert.ok(slot)
    assert.equal(slot.offset, 0.5)
    assert.equal(slot.filename, 'mine')
    // An archetype this build doesn't know: never migrated, so never lost.
    const unknown = {
        ...levelData,
        entities: [...levelData.entities, { archetype: 'FutureNote', data: [] }],
    }
    assert.equal(parseAutoSaveSlot(JSON.stringify(serializeAutoSave(unknown, 'x'))), undefined)
    assert.equal(parseAutoSaveSlot('not json'), undefined)
})
