import assert from 'node:assert/strict'
import test from 'node:test'
import { liveState } from '../../../src/history/stack'
import { hashKey } from '../../../src/local/db'
import { fromHex16 } from '../../../src/local/hash'
import { MemoryStorage } from '../../../src/local/journal/store'
import { captureMedia } from '../../../src/local/media'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import '../../helpers/lockChecks'
import { rows, workerCore } from '../flush/harness'
import { beginSession, openJournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { load } from './load'

// A session whose BGM is in the media store plays after a reload or a new visit, and says
// "not loaded" only for a BGM that neither memory nor the store holds (Part 1 §1.6.8.4, Step 7
// design §3.6).

const song = (seed: number) => {
    const bytes = new Uint8Array(4096)
    bytes.set([0x49, 0x44, 0x33, 0x04])
    for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff
    return bytes.buffer
}

/** A tab that stored a session with a picked BGM, then died. */
const stored = async (seed: number) => {
    const world = createWorld({ seed })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const captured = await captureMedia(song(seed), { name: 'song.mp3', type: '' })
    const base = stateOf(goldenChart())
    const withSong: State = {
        ...base,
        bgm: {
            ...base.bgm,
            meta: { ...captured.meta, durationMs: 1000 },
            source: captured.source,
        },
    }
    beginSession(first, withSong)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    assert.equal(rows(world, 'media').size, 1)
    return { world, storage, captured }
}

/** What a visit says besides that it continued the session. */
const said = (visit: Awaited<ReturnType<typeof load>>) =>
    visit.events.map((event) => event.kind).filter((kind) => kind !== 'continued')

/** Removes the media row, as cleanup in another tab does. */
const dropMedia = async (world: World, hash: string) => {
    const other = world.tab('cleanup')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    await other.run(() =>
        core.write(['media'], (tx) => tx.delete('media', hashKey(fromHex16(hash)))),
    )
    assert.equal(rows(world, 'media').size, 0)
}

test('a new visit of a session whose BGM is in the media store attaches it and says nothing', async () => {
    const { world, storage, captured } = await stored(1)
    const visit = await load(world, 'visit', storage)
    // Today’s bug: the BGM is held, yet the state had no audio and the load said "not loaded".
    assert.deepEqual(said(visit), [])
    const bgm = liveState.value.bgm
    assert.ok(bgm.buffer, 'the audio is attached')
    assert.deepEqual(
        new Uint8Array(bgm.source ?? new ArrayBuffer(0)),
        new Uint8Array(captured.source),
    )
    assert.equal(bgm.meta?.hash, captured.meta.hash)
})

test('a BGM the media store lost is said to be not loaded, once', async () => {
    const { world, storage, captured } = await stored(2)
    await dropMedia(world, captured.meta.hash)
    const visit = await load(world, 'visit', storage)
    assert.deepEqual(said(visit), ['bgmNotLoaded'])
    assert.equal(liveState.value.bgm.buffer, undefined)
})

test('a store that cannot be read says nothing, since that is not a no', async () => {
    const { world, storage } = await stored(3)
    const visit = await load(world, 'visit', storage, {
        media: { read: () => Promise.reject(new Error('could not read')) },
    })
    assert.deepEqual(said(visit), [])
    assert.equal(liveState.value.bgm.buffer, undefined)
})
