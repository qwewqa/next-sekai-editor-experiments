import assert from 'node:assert/strict'
import test from 'node:test'
import { bumpEpoch, hashKey } from '../../../src/local/db'
import { fromHex16, sha256Sync, toHex } from '../../../src/local/hash'
import { captureMedia, sniffAudioType } from '../../../src/local/media'
import { unpackHashes } from '../../../src/local/records/rows'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld } from '../../../src/local/testing/world'
import { setMediaReadBackHookForTests } from '../../../src/local/worker/flushHandlers'
import type { State } from '../../../src/state'
import { goldenChart, stateOf } from '../records/charts'
import { openPage, rows, testId, workerCore, type Page } from './harness'

// Media follows the head (§1.6.8.4): a picked BGM is stored with the entry first naming it, read
// back once, and stored again when it went missing while this tab holds it.

/** A small MP3-looking file: an ID3 tag, then bytes. */
const song = (seed: number) => {
    const bytes = new Uint8Array(4096)
    bytes.set([0x49, 0x44, 0x33, 0x04])
    for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff
    return bytes.buffer
}

const withSong = async (state: State, seed: number, held = true): Promise<State> => {
    const captured = await captureMedia(song(seed), { name: `song${seed}.mp3`, type: '' })
    return {
        ...state,
        bgm: {
            ...state.bgm,
            meta: { ...captured.meta, durationMs: 1000 },
            ...(held ? { source: captured.source } : {}),
        },
    }
}

const begin = (page: Page, state: State) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        label: () => 'Initialize',
        dirty: false,
    })

test('capture hashes the bytes before decoding, keeps a copy, and sniffs the type', async () => {
    const data = song(1)
    const captured = await captureMedia(data, { name: 'a.bin', type: 'audio/x-guess' })
    assert.notEqual(captured.source, data)
    assert.equal(captured.meta.hash, toHex(sha256Sync(new Uint8Array(data)).subarray(0, 16)))
    assert.equal(captured.meta.size, 4096)
    assert.equal(captured.meta.type, 'audio/mpeg')
    assert.equal(captured.meta.filename, 'a.bin')
    assert.equal(sniffAudioType(new Uint8Array([1, 2, 3]), 'audio/x-guess'), 'audio/x-guess')
    assert.equal(sniffAudioType(new TextEncoder().encode('OggS....')), 'audio/ogg')
    assert.equal(sniffAudioType(new TextEncoder().encode('fLaC')), 'audio/flac')
    assert.equal(sniffAudioType(new TextEncoder().encode('RIFF\0\0\0\0WAVE')), 'audio/wav')
    assert.equal(sniffAudioType(new TextEncoder().encode('\0\0\0\x18ftypM4A ')), 'audio/mp4')
})

test('a picked BGM is stored with the entry first naming it, at once and strictly', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const base = stateOf(goldenChart())
    begin(page, base)
    await page.flusher.flush()
    const picked = await withSong(base, 1)
    page.flusher.append('edit', () => 'Changed BGM', picked, true)
    // The pick flushes at once, without waiting for the delay.
    await page.flusher.flush()
    const batch = page.batches.at(-1)
    assert.equal(batch?.durability, 'strict')
    assert.equal(batch?.media.length, 1)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const meta = picked.bgm.meta!
    const media = rows(world, 'media')
    assert.equal(media.size, 1)
    const [row] = media.values()
    assert.ok(row)
    assert.equal(row.size, 4096)
    assert.equal(row.type, 'audio/mpeg')
    assert.equal(row.filename, 'song1.mp3')
    assert.equal(row.kind, 'bgm')
    assert.equal(row.day, 1)
    assert.equal((row.sha256 as Uint8Array).length, 32)
    assert.equal(toHex((row.sha256 as Uint8Array).subarray(0, 16)), meta.hash)
    assert.deepEqual(
        new Uint8Array(await (row.blob as Blob).arrayBuffer()),
        new Uint8Array(song(1)),
    )
    // The root's refs end with the BGM.
    const entries = [...rows(world, 'entries').values()]
    const root = rows(world, 'nodes').get(
        [...rows(world, 'nodes').keys()].find(
            (key) => key === `x${toHex(entries.at(-1)?.snapshot as Uint8Array)}`,
        ) ?? '',
    )
    assert.equal(toHex(unpackHashes(root?.refs as Uint8Array).at(-1) as Uint8Array), meta.hash)
    assert.deepEqual(checkStored(world.memory), [])

    // A later flush doesn't carry the bytes again.
    page.flusher.append('edit', () => 'Changed', { ...picked, initialLife: 900 }, true)
    await page.flusher.flush()
    assert.equal(page.batches.at(-1)?.media.length, 0)
    assert.deepEqual(page.batches.at(-1)?.held, [meta.hash])
})

test('the head’s BGM is stored again when it went missing, while this tab holds it', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    const picked = await withSong(stateOf(goldenChart()), 2)
    begin(page, picked)
    await page.flusher.flush()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const hash = picked.bgm.meta!.hash
    // Cleanup removed it as a cache in another tab.
    const other = world.tab('other')
    const otherCore = workerCore(world, other)
    await other.run(() => otherCore.start())
    await other.run(() =>
        otherCore.write(['media', 'meta'], async (tx) => {
            await tx.delete('media', hashKey(fromHex16(hash)))
            await bumpEpoch(tx)
        }),
    )
    assert.equal(rows(world, 'media').size, 0)
    page.flusher.append('undo', () => 'Changed BGM', picked, false)
    await page.flusher.flush()
    assert.deepEqual(
        page.results.map((result) => result.kind),
        ['stored', 'missing', 'stored'],
    )
    assert.equal(page.batches.at(-1)?.media[0]?.hash, hash)
    assert.equal(rows(world, 'media').size, 1)
})

test('a state whose BGM isn’t held stores its metadata only', async () => {
    const world = createWorld({ seed: 3 })
    const page = await openPage(world, world.tab('a'))
    const notLoaded = await withSong(stateOf(goldenChart()), 3, false)
    begin(page, notLoaded)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.equal(rows(world, 'media').size, 0)
    assert.equal(page.results.at(-1)?.kind, 'stored')
    assert.deepEqual(checkStored(world.memory), [])
})

test('a media row that reads back wrong is written again from memory', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openPage(world, world.tab('a'))
    let reads = 0
    setMediaReadBackHookForTests((bytes, attempt) => {
        reads++
        return attempt === 0 ? bytes.slice(1) : bytes
    })
    try {
        begin(page, await withSong(stateOf(goldenChart()), 4))
        await page.flusher.flush()
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
    assert.equal(reads, 2)
    assert.equal(page.core.status.reason, undefined)
    assert.equal(rows(world, 'media').size, 1)
})

test('a media row that reads back wrong twice pauses storing', async () => {
    const world = createWorld({ seed: 5 })
    const page = await openPage(world, world.tab('a'))
    setMediaReadBackHookForTests((bytes) => bytes.slice(1))
    try {
        begin(page, await withSong(stateOf(goldenChart()), 5))
        await page.flusher.flush()
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
    assert.equal(page.core.status.reason, 'failed')
})

test('media bytes that don’t hash to their hash are refused', async () => {
    const world = createWorld({ seed: 6 })
    const page = await openPage(world, world.tab('a'))
    const picked = await withSong(stateOf(goldenChart()), 6)
    const wrong: State = { ...picked, bgm: { ...picked.bgm, source: song(7) } }
    const errors = console.error
    console.error = () => undefined
    try {
        begin(page, wrong)
        await page.flusher.flush()
    } finally {
        console.error = errors
    }
    assert.ok(page.errors.length > 0)
    assert.equal(rows(world, 'media').size, 0)
    assert.equal(rows(world, 'sessions').size, 0)
})
