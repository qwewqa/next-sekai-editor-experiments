import assert from 'node:assert/strict'
import test from 'node:test'
import { bumpEpoch, hashKey } from '../../../src/local/db'
import { fromHex16, sha256Sync, toHex } from '../../../src/local/hash'
import { captureMedia, sniffAudioType } from '../../../src/local/media'
import { unpackHashes } from '../../../src/local/records/rows'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld } from '../../../src/local/testing/world'
import type { StorageStatus } from '../../../src/local/worker/core'
import { setMediaReadBackHookForTests } from '../../../src/local/worker/flushHandlers'
import type { State } from '../../../src/state'
import {
    editStep,
    futureFixtureOperation,
    initialLife,
    originOperation,
} from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'
import { openPage, openSplitPage, rows, testId, workerCore, type Page } from './harness'

// Media follows the head: a picked BGM is stored with the entry first naming it, read
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
        operation: originOperation('import'),
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
    page.flusher.append(
        {
            kind: 'edit',
            step: editStep(futureFixtureOperation('picked-bgm-transport', {}, 'Changed BGM')),
        },
        picked,
        true,
    )
    // The pick flushes at once, without waiting for the delay.
    await page.flusher.flush()
    const batch = page.batches.at(-1)
    assert.equal(batch?.durability, 'strict')
    assert.equal(batch?.media.length, 1)

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
    page.flusher.append(
        { kind: 'edit', step: editStep(initialLife(picked.initialLife, 900)) },
        { ...picked, initialLife: 900 },
        true,
    )
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

    const crossed = editStep(initialLife(picked.initialLife, picked.initialLife + 1))
    page.flusher.append(
        { kind: 'edit', step: crossed },
        { ...picked, initialLife: picked.initialLife + 1 },
        true,
    )
    await page.flusher.flush()

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
    page.flusher.append({ kind: 'undo', step: crossed }, picked, false)
    await page.flusher.flush()
    assert.deepEqual(
        page.results.map((result) => result.kind),
        ['stored', 'stored', 'missing', 'stored'],
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

test('a media row that reads back wrong twice is removed and pending, and the history is stored', async () => {
    const world = createWorld({ seed: 5 })
    const page = await openPage(world, world.tab('a'))
    const statuses: StorageStatus[] = []
    page.core.onStatus((status) => statuses.push(status))
    const picked = await withSong(stateOf(goldenChart()), 5)
    const hash = picked.bgm.meta!.hash
    setMediaReadBackHookForTests((bytes) => bytes.slice(1))
    try {
        begin(page, picked)
        await page.flusher.flush()
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
    // Storing is not paused: the status says stored, with the media pending beside it.
    assert.deepEqual(page.core.status, { mode: 'stored', mediaPending: [hash] })
    assert.ok(statuses.every((status) => status.mode === 'stored' && !status.reason))
    // The bad row went, and the entries are stored all the same: the root names a BGM not held.
    assert.equal(rows(world, 'media').size, 0)
    assert.equal(page.flusher.hasPending, false)
    assert.equal(rows(world, 'entries').size, 1)
    assert.deepEqual(checkStored(world.memory), [])
    // Another write that succeeds leaves it pending.
    await page.tab.run(() => page.handlers.countDay())
    assert.deepEqual(page.core.status, { mode: 'stored', mediaPending: [hash] })
    // The media is stored again on its own, from the page's bytes.
    await page.flusher.retryMedia()
    assert.deepEqual(page.core.status, { mode: 'stored' })
    assert.equal(rows(world, 'media').size, 1)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a BGM that never reads back right blocks no history, and later flushes don’t carry it', async () => {
    const world = createWorld({ seed: 10 })
    const page = await openPage(world, world.tab('a'))
    let reads = 0
    setMediaReadBackHookForTests((bytes) => {
        reads++
        return bytes.slice(1)
    })
    try {
        const base = await withSong(stateOf(goldenChart()), 10)
        begin(page, base)
        for (let i = 0; i < 100; i++)
            page.flusher.append(
                {
                    kind: 'edit',
                    step: editStep(initialLife(i ? 999 + i : base.initialLife, 1000 + i)),
                },
                { ...base, initialLife: 1000 + i },
                true,
            )
        for (let i = 0; i < 5; i++) await page.flusher.flush()
        assert.equal(rows(world, 'entries').size, 101)
        assert.equal(page.flusher.hasPending, false)
        // Read back twice once; no later flush carried the bytes again, or named them held.
        assert.equal(reads, 2)
        assert.equal(page.batches.filter((batch) => batch.media.length > 0).length, 1)
        assert.ok(page.batches.every((batch) => batch.held.length === 0))
        assert.equal(rows(world, 'meta').get('epoch')?.value ?? 0, 0)
        // A retry of the media alone writes it once and reads it back twice, no more.
        await page.flusher.retryMedia()
        assert.equal(reads, 4)
        assert.equal(rows(world, 'media').size, 0)
        assert.equal(page.core.status.reason, undefined)
        assert.equal(page.core.status.mediaPending?.length, 1)
        assert.equal(rows(world, 'meta').get('epoch')?.value ?? 0, 0)
        assert.deepEqual(checkStored(world.memory), [])
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
})

test('a Blob the database refuses, as WebKit’s private windows do, blocks no history and pauses nothing', async () => {
    const world = createWorld({ seed: 40 })
    const page = await openPage(world, world.tab('a'))
    const statuses: StorageStatus[] = []
    page.core.onStatus((status) => statuses.push(status))
    world.memory.faults.refuseBlobs = true
    const picked = await withSong(stateOf(goldenChart()), 40)
    const hash = picked.bgm.meta!.hash
    begin(page, picked)
    page.flusher.append(
        { kind: 'edit', step: editStep(initialLife(picked.initialLife, 900)) },
        { ...picked, initialLife: 900 },
        true,
    )
    await page.flusher.flush()
    // The entries are stored; the root names a BGM not held, pending beside a stored status.
    assert.equal(page.flusher.hasPending, false)
    assert.equal(page.flusher.failed, false)
    assert.equal(rows(world, 'entries').size, 2)
    assert.equal(rows(world, 'media').size, 0)
    assert.deepEqual(page.core.status, { mode: 'stored', mediaPending: [hash] })
    assert.ok(statuses.every((status) => status.mode === 'stored' && !status.reason))
    assert.deepEqual(checkStored(world.memory), [])
    // Stored alone, it's refused again without pausing, and later flushes don't carry it.
    await page.flusher.retryMedia()
    assert.equal(rows(world, 'media').size, 0)
    assert.deepEqual(page.core.status, { mode: 'stored', mediaPending: [hash] })
    page.flusher.append(
        { kind: 'edit', step: editStep(initialLife(900, 901)) },
        { ...picked, initialLife: 901 },
        true,
    )
    await page.flusher.flush()
    assert.equal(page.batches.at(-1)?.media.length, 0)
    assert.equal(rows(world, 'entries').size, 3)
    assert.ok(statuses.every((status) => status.mode === 'stored' && !status.reason))
    // Once the database takes Blobs, the retry stores it.
    world.memory.faults.refuseBlobs = false
    await page.flusher.retryMedia()
    assert.deepEqual(page.core.status, { mode: 'stored' })
    assert.equal(rows(world, 'media').size, 1)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a media row that can’t be read is kept, and read back again later', async () => {
    const world = createWorld({ seed: 11 })
    const page = await openPage(world, world.tab('a'))
    setMediaReadBackHookForTests(() => {
        throw new DOMException('Unreadable', 'NotReadableError')
    })
    try {
        begin(page, await withSong(stateOf(goldenChart()), 11))
        await page.flusher.flush()
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
    assert.equal(rows(world, 'media').size, 1)
    assert.equal(page.core.status.reason, undefined)
    assert.equal(page.core.status.mediaPending?.length, 1)
    assert.equal(page.flusher.hasPending, false)
    await page.flusher.retryMedia()
    assert.deepEqual(page.core.status, { mode: 'stored' })
    assert.equal(rows(world, 'media').size, 1)
})

test('a BGM an earlier load stored and read back is not read back again', async () => {
    const world = createWorld({ seed: 12 })
    const picked = await withSong(stateOf(goldenChart()), 12)
    const first = await openPage(world, world.tab('a'))
    begin(first, picked)
    await first.flusher.flush()
    let reads = 0
    setMediaReadBackHookForTests((bytes) => {
        reads++
        return bytes
    })
    try {
        // A reload: a new worker and page, the BGM held again and found stored.
        const second = await openPage(world, world.tab('b'))
        begin(second, picked)
        await second.flusher.flush()
        assert.equal(second.batches.at(-1)?.media.length, 1)
        assert.equal(second.results.at(-1)?.kind, 'stored')
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
    assert.equal(reads, 0)
})

test('a worker killed between a media flush’s commit and its read-back reads it back once restarted', async () => {
    const world = createWorld({ seed: 7 })
    const page = await openSplitPage(world)
    let reads = 0
    setMediaReadBackHookForTests((bytes) => {
        if (++reads === 1) page.host.worker.kill()
        return bytes
    })
    try {
        page.flusher.begin({
            id: testId(),
            docId: testId(),
            origin: 'import',
            state: await withSong(stateOf(goldenChart()), 9),
            operation: originOperation('import'),
            dirty: false,
        })
        await page.flusher.flush()
        await world.clock.run()
        await world.idle()
    } finally {
        setMediaReadBackHookForTests(undefined)
    }
    assert.equal(page.host.starts, 2)
    assert.equal(reads, 2)
    assert.equal(rows(world, 'media').size, 1)
    assert.equal(page.flusher.hasPending, false)
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

test('a kill at every await of a flush with a picked BGM stores the BGM with its entry or not at all', async () => {
    const picked = await withSong(stateOf(goldenChart()), 8)
    const result = await crashSweep({
        seeds: [undefined, CI_SEEDS[0]],
        scenario: async ({ world, victim }) => {
            const page = await openPage(world, victim)
            begin(page, picked)
            await page.flusher.flush()
        },
        check: ({ world }) => {
            assert.deepEqual(checkStored(world.memory), [])
            const media = rows(world, 'media').size
            const sessions = rows(world, 'sessions').size
            assert.equal(media, sessions)
        },
    })
    assert.ok(result.every(({ points }) => points > 10))
})

test('a media put that fails by anything but the Blob refusal fails the flush, which stores nothing', async () => {
    const world = createWorld({ seed: 41 })
    const page = await openPage(world, world.tab('a'))
    const picked = await withSong(stateOf(goldenChart()), 41)
    // A quota reported on the request, as an engine may instead of on the commit.
    world.memory.faults.put = (store) =>
        store === 'media' ? new DOMException('Full', 'QuotaExceededError') : undefined
    begin(page, picked)
    await page.flusher.flush()
    assert.equal(page.flusher.failed, true)
    assert.equal(page.flusher.hasPending, true)
    assert.equal(rows(world, 'entries').size, 0)
    assert.deepEqual(page.core.status, { mode: 'stored', reason: 'full' })
    // Stored once the put goes through: the entry with its BGM.
    world.memory.faults.put = undefined
    await page.flusher.flush()
    assert.equal(page.flusher.failed, false)
    assert.equal(rows(world, 'entries').size, 1)
    assert.equal(rows(world, 'media').size, 1)
    assert.deepEqual(page.core.status, { mode: 'stored' })
    assert.deepEqual(checkStored(world.memory), [])
})

test('a media item stored alone that fails by anything but the Blob refusal pauses storing', async () => {
    const world = createWorld({ seed: 42 })
    const page = await openPage(world, world.tab('a'))
    const picked = await withSong(stateOf(goldenChart()), 42)
    world.memory.faults.refuseBlobs = true
    begin(page, picked)
    await page.flusher.flush()
    assert.equal(rows(world, 'media').size, 0)
    world.memory.faults.refuseBlobs = false
    world.memory.faults.put = (store) =>
        store === 'media' ? new DOMException('Bad', 'DataError') : undefined
    await page.flusher.retryMedia()
    assert.equal(page.core.status.reason, 'failed')
    world.memory.faults.put = undefined
})

test('an UnknownError on a Blob row is the refusal whatever its message, and on any other row it isn’t', async () => {
    const world = createWorld({ seed: 43 })
    const page = await openPage(world, world.tab('a'))
    const picked = await withSong(stateOf(goldenChart()), 43)
    // A WebKit whose message names no Blob.
    world.memory.faults.put = (store) =>
        store === 'media'
            ? new DOMException('An internal error occurred', 'UnknownError')
            : undefined
    begin(page, picked)
    await page.flusher.flush()
    assert.equal(page.flusher.failed, false)
    assert.equal(rows(world, 'entries').size, 1)
    assert.deepEqual(page.core.status, { mode: 'stored', mediaPending: [picked.bgm.meta!.hash] })
    world.memory.faults.put = undefined
    // The same error on a row with no Blob fails its transaction.
    const failed = await page.tab
        .run(() =>
            page.core.write(['meta'], async (tx) => {
                world.memory.faults.put = () =>
                    new DOMException('An internal error occurred', 'UnknownError')
                return tx.tryPut('meta', { key: 'probe', value: 1 })
            }),
        )
        .then(
            () => false,
            () => true,
        )
    world.memory.faults.put = undefined
    assert.equal(failed, true)
})
