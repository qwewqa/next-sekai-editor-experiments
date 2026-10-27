import assert from 'node:assert/strict'
import test from 'node:test'
import { gzip } from 'pako'
import type { NoteObject } from '../../../src/chart/note'
import { journalContent, journalLevelData, journalState } from '../../../src/local/journal/content'
import type { Journal } from '../../../src/local/journal/format'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import { addNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import '../../helpers/lockChecks'
import { goldenChart, note, stateOf } from '../records/charts'
import { sampleState } from '../records/samples'

// The journal's whole state: level data on its own, the header's records and the
// ids, and what replay builds back from them.

const rootOf = (state: State) => encodeSnapshot(toRecords(state)).root.hash

const recover = (state: State, change?: (journal: Journal) => void) => {
    const journal = { ...journalContent(state) } as Journal
    change?.(journal)
    const read = journalState(journal)
    assert.equal(read.kind, 'state')
    if (read.kind !== 'state') throw new Error('not recovered')
    return read
}

test('a chart read from level data recovers with its ids, hashing as it did', () => {
    const state = sampleState('tests/fixtures/generated-large.json')
    const read = recover(state)
    assert.ok(read.idsKept)
    assert.deepEqual(rootOf(read.state), rootOf(state))
    // Decoded, the level data is a valid .nsld.
    assert.equal(journalLevelData(journalContent(state)).entities.length > 1000, true)
})

test('a chart at lane division 3 recovers with its ids and a different root', () => {
    const state = stateOf(goldenChart())
    const read = recover(state)
    assert.ok(read.idsKept)
    assert.deepEqual([...read.state.groups.keys()], [...state.groups.keys()])
    assert.deepEqual([...read.state.stages.keys()], [...state.stages.keys()])
    assert.deepEqual([...read.state.groupFolders.keys()], [...state.groupFolders.keys()])
    assert.deepEqual(
        [...read.state.stageFolders.keys()].sort(),
        [...state.stageFolders.keys()].sort(),
    )
    assert.notDeepEqual(rootOf(read.state), rootOf(state))
    // Level info and the BGM's metadata come from the header.
    assert.deepEqual(read.state.levelInfo, state.levelInfo)
    assert.deepEqual(read.state.bgm.meta, state.bgm.meta)
    const notes = (s: State) =>
        [...s.store.slides.note.values()].flat().map((n: NoteObject) => [n.groupId, n.stageId])
    assert.deepEqual(notes(read.state).sort(), notes(state).sort())
})

test("ids whose counts don't match the level give fresh ids, and the state is still recovered", () => {
    const state = stateOf(goldenChart())
    const read = recover(state, (journal) => {
        journal.header.ids.groups.push(99)
    })
    assert.equal(read.idsKept, false)
    assert.equal(read.state.groups.size, state.groups.size)
    // Only the groups' ids are fresh: stages and folders keep theirs.
    assert.notDeepEqual([...read.state.groups.keys()], [...state.groups.keys()])
    assert.deepEqual([...read.state.stages.keys()], [...state.stages.keys()])
    assert.deepEqual([...read.state.groupFolders.keys()], [...state.groupFolders.keys()])
    const twice = recover(state, (journal) => {
        journal.header.ids.groups = [5, 5]
    })
    assert.equal(twice.idsKept, false)
})

test('two guides, the default-coloured one created second and earlier, keep their colours', () => {
    const fixture = goldenChart()
    fixture.chart.slides = []
    let state = stateOf(fixture)
    for (const [beat, connectorStyle] of [
        [8, 'red'],
        [6, 'default'],
    ] as const) {
        const transaction = createTransaction(state)
        const slideId = createSlideId()
        addNote(transaction, slideId, note(beat, { connectorType: 'guide', connectorStyle }))
        addNote(transaction, slideId, note(beat + 1, { connectorType: 'guide', connectorStyle }))
        state = transaction.commit([])
    }
    const content = journalContent(state)
    assert.equal(content.editorMetadata?.defaultGuideColors?.length, 2)
    const styles = (s: State) =>
        [...s.store.slides.note.values()]
            .map((notes) => `${notes[0]?.beat}:${notes[0]?.connectorStyle}`)
            .sort()
    assert.deepEqual(styles(recover(state).state), ['6:default', '8:red'])
})

test("level data with content this build doesn't read is left for a later build", () => {
    const state = stateOf(goldenChart())
    const journal = { ...journalContent(state) } as Journal
    const levelData = journalLevelData(journal)
    levelData.entities.push({ archetype: 'FutureThing', data: [] })
    journal.levelDataGz = Buffer.from(gzip(JSON.stringify(levelData))).toString('base64')
    assert.equal(journalState(journal).kind, 'later')
    journal.levelDataGz = 'not base64 gzip'
    assert.equal(journalState(journal).kind, 'unreadable')
})
