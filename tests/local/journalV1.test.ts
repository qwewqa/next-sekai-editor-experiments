import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gzip } from 'pako'
import { readDump } from '../../src/local/dump'
import { journalLevelData, journalState } from '../../src/local/journal/content'
import { JOURNAL_VERSION, readJournal, type Journal } from '../../src/local/journal/format'
import { MemoryStorage } from '../../src/local/journal/store'
import { RECORDS_V, SESSION_V } from '../../src/local/records/version'
import { seedDump } from '../../src/local/seed'
import { createWorld } from '../../src/local/testing/world'
import { rows } from './flush/harness'
import { replayAll } from './journal/harness'

// The v1 journals (`tests/fixtures/web-storage-v1/`): the pending journal of the dump, and a
// journal written while storage was unavailable, read as every later build must read them. The "left in place" cases
// are copies made here, relative to the running build's constants, so the test stays right after
// a version rises. Each test names the bug it catches.

const root = join(import.meta.dirname, '..', 'fixtures', 'web-storage-v1')
const prefix = 'sonolus-next-sekai-editor.'
const wholeDump: unknown = JSON.parse(readFileSync(join(root, 'nse-local-data.json'), 'utf8'))
const dump = wholeDump as { localStorage: Record<string, string> }
const unavailableText = readFileSync(join(root, 'journal-unavailable.json'), 'utf8')

const journalKey = Object.keys(dump.localStorage).filter((key) =>
    key.startsWith(`${prefix}journal.`),
)
assert.equal(journalKey.length, 1)
const pendingId = journalKey[0]!.slice(`${prefix}journal.`.length)
const pendingText = dump.localStorage[journalKey[0]!]!
const unavailableId = (JSON.parse(unavailableText) as Journal).sessionId

const samples = [
    { name: 'the dump’s pending journal', id: pendingId, text: pendingText },
    {
        name: 'a journal written while storage was unavailable',
        id: unavailableId,
        text: unavailableText,
    },
]

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

test('both journals read as v1 journals, and their state has the ids and header they recorded', () => {
    // Catches a later build whose reader rejects a v1 journal (the last edits lost, or a recovery
    // chain made in place of the session), or builds a state that is not the one recorded.
    for (const { name, id, text } of samples) {
        const reading = readJournal(text, id)
        assert.equal(reading.kind, 'journal', name)
        if (reading.kind !== 'journal') return
        const { journal } = reading
        const read = journalState(journal)
        assert.equal(read.kind, 'state', name)
        if (read.kind !== 'state') return
        assert.equal(read.idsKept, true, name)
        const { state } = read
        const { ids } = journal.header
        assert.deepEqual([...state.groups.keys()], ids.groups, name)
        assert.deepEqual([...state.stages.keys()], ids.stages, name)
        assert.deepEqual([...state.groupFolders.keys()], ids.groupFolders, name)
        assert.deepEqual(
            state.isDynamicStages ? [...state.stageFolders.keys()] : [],
            ids.stageFolders,
            name,
        )
        // The header's level info record: title, artists, author, description.
        const info = journal.header.levelInfo as string[]
        assert.deepEqual(
            [
                state.levelInfo.title,
                state.levelInfo.artists,
                state.levelInfo.author,
                state.levelInfo.description,
            ],
            info.slice(0, 4),
            name,
        )
        assert.equal(Boolean(state.bgm.meta), journal.header.bgm !== undefined, name)
    }
    // The pending journal is chain A's, written with a stack the committed stack keeps part of; the
    // other has nothing committed.
    const pending = readJournal(pendingText, pendingId)
    assert.ok(pending.kind === 'journal' && pending.journal.stack.keep > 0)
    const unavailable = readJournal(unavailableText, unavailableId)
    assert.ok(unavailable.kind === 'journal' && unavailable.journal.stack.keep === 0)
})

/** A copy of the pending journal with its level data changed. */
const withLevelData = (
    change: (levelData: {
        entities: { archetype: string; data: { name: string; value?: unknown }[] }[]
    }) => void,
) => {
    const journal = JSON.parse(pendingText) as Journal
    const levelData = journalLevelData(journal) as unknown as Parameters<typeof change>[0]
    change(levelData)
    journal.levelDataGz = base64(gzip(JSON.stringify(levelData), { level: 1 }))
    return JSON.stringify(journal)
}

const copy = (change: (journal: Journal) => void) => {
    const journal = JSON.parse(pendingText) as Journal
    change(journal)
    return JSON.stringify(journal)
}

/** A journal in a fresh world's storage, replayed as the next load does. */
const replay = async (text: string) => {
    const world = createWorld()
    const storage = new MemoryStorage()
    storage.setItem(`nse.journal.${pendingId}`, text)
    const { outcomes } = await replayAll(world, storage)
    return { world, storage, outcomes }
}

test('the journal of a later build, or level data this build does not read, is left in place', async () => {
    // Catches a later build that applies a journal it cannot fully read (a newer build's data
    // dropped without a word) or moves it aside as damaged, and one that loses it: it stays for a
    // build that can read it, in the key it was written under.
    const later: Record<string, string> = {
        'recordsV above this build’s': copy((journal) => (journal.recordsV = RECORDS_V + 1)),
        'a descriptor v above this build’s': copy(
            (journal) => (journal.descriptor.v = SESSION_V + 1),
        ),
        'a journalVersion above this build’s': copy(
            (journal) => (journal.journalVersion = JOURNAL_VERSION + 1),
        ),
        'an unknown archetype': withLevelData((levelData) =>
            levelData.entities.push({ archetype: 'ArchetypeOfALaterBuild', data: [] }),
        ),
        'an unknown choice value': withLevelData((levelData) => {
            const field = levelData.entities
                .flatMap((entity) => entity.data)
                .find((each) => each.name === 'direction' || each.name === 'flick')
            assert.ok(field, 'level data with a choice field')
            field.value = 99
        }),
    }
    for (const [name, text] of Object.entries(later)) {
        const reading = readJournal(text, pendingId)
        assert.notEqual(reading.kind, 'unreadable', name)
        const { world, storage, outcomes } = await replay(text)
        assert.deepEqual(
            outcomes.map((outcome) => outcome.kind),
            ['later'],
            name,
        )
        assert.equal(storage.getItem(`nse.journal.${pendingId}`), text, name)
        assert.equal(rows(world, 'recovered').size, 0, name)
        assert.equal(rows(world, 'sessions').size, 0, name)
    }
})

test('a journalVersion of 0 goes to the recovered store, and the v1 journals are applied', async () => {
    // Catches a later build that applies or drops a journal it cannot read (its bytes must stay in
    // the `recovered` store), and one that no longer applies a v1 journal to its session.
    const zero = copy((journal) => (journal.journalVersion = 0))
    assert.equal(readJournal(zero, pendingId).kind, 'unreadable')
    const bad = await replay(zero)
    assert.deepEqual(
        bad.outcomes.map((outcome) => outcome.kind),
        ['unreadable'],
    )
    assert.equal(bad.storage.getItem(`nse.journal.${pendingId}`), null)
    const kept = [...rows(bad.world, 'recovered').values()]
    assert.equal(kept.length, 1)
    assert.equal(kept[0]?.source, 'journal')
    assert.equal(kept[0]?.sessionId, pendingId)
    const blob = kept[0]?.bytes as Blob
    assert.equal(await blob.text(), zero)

    // The v1 journals themselves. The pending one is applied to its session in the seeded database
    // (a recovered entry on it); the one written while storage was unavailable has no session
    // anywhere, so it makes one from its descriptor.
    const world = createWorld()
    const seed = world.tab('seed')
    const seeded = await seed.run(() =>
        seedDump(seed.kv, readDump(wholeDump), { setItem: () => undefined }),
    )
    assert.deepEqual(seeded, { seeded: true })
    const storage = new MemoryStorage()
    storage.setItem(`nse.journal.${pendingId}`, pendingText)
    const { outcomes } = await replayAll(world, storage)
    assert.deepEqual(
        outcomes.map((outcome) => outcome.kind),
        ['applied'],
    )
    assert.equal(storage.getItem(`nse.journal.${pendingId}`), null)
    const entries = [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === pendingId)
        .sort((x, y) => (x.seq as number) - (y.seq as number))
    assert.equal(entries.at(-1)?.kind, 'recovered')

    const empty = createWorld()
    const alone = new MemoryStorage()
    alone.setItem(`nse.journal.${unavailableId}`, unavailableText)
    const next = await replayAll(empty, alone)
    assert.ok(['applied', 'recovery'].includes(next.outcomes[0]?.kind ?? ''))
    assert.equal(alone.getItem(`nse.journal.${unavailableId}`), null)
})
