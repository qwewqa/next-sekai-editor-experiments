import assert from 'node:assert/strict'
import test from 'node:test'
import { MEDIA_RETRY_MS, removeBadMedia, type MediaRemoval } from '../../../src/local/check/finish'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { unpackHashes } from '../../../src/local/records/rows'
import { RECORDS_V } from '../../../src/local/records/version'
import { stillBad } from '../../../src/local/save/bodies'
import { COVER } from '../nxsp/helpers'
import { Fixture, heldRows, save } from '../save/fixture'
import {
    checker,
    checkFile,
    checkStored,
    damageChunkRow,
    damageFileChunk,
    dump,
    finish,
    keptFlags,
    ownChunk,
    rowsReaching,
    runCheck,
    savedChain,
} from './harness'

// Check File and History's worker side: the
// file read in full with no stored shortcut, stored damage repaired from the file before anything
// is marked, only the rows that need a bad body marked, a bad media row removed only when it still
// fails under `nse-maint` exclusive, and read-only storage left untouched.

const allKept = (flags: Map<string, boolean>) => [...flags.values()].every(Boolean)

test('a chunk damaged in the file that storage holds intact: the file is damaged, nothing is marked', async () => {
    const fixture = await Fixture.create()
    const saved = await savedChain(fixture)
    const { file } = await damageFileChunk(saved)
    const check = await checker(fixture)

    assert.equal(await checkFile(check, saved), 'clean')
    const { file: state, result } = await runCheck(check, fixture.chainId, file)
    assert.equal(state, 'damaged')
    assert.equal(result.repaired, 0)
    assert.equal(result.damaged, 0)
    assert.deepEqual(result.media, [])
    assert.ok(allKept(await keptFlags(fixture)))
})

test('a stored chunk damaged, the file intact: repaired from the file, nothing marked', async () => {
    const fixture = await Fixture.create()
    const file = await savedChain(fixture)
    const { chunk } = await ownChunk(fixture)
    const needing = await rowsReaching(fixture, chunk)
    assert.ok(needing.size > 0 && needing.size < (await keptFlags(fixture)).size)
    await damageChunkRow(fixture, chunk)

    const { file: state, result } = await runCheck(await checker(fixture), fixture.chainId, file)
    assert.equal(state, 'clean')
    assert.equal(result.repaired, needing.size)
    assert.equal(result.damaged, 0)
    assert.equal(result.markFailed, undefined)
    assert.ok(allKept(await keptFlags(fixture)))
    assert.equal((await stillBad(fixture.store, [chunk])).size, 0)
    assert.equal((await fixture.chain()).badChunks, undefined)
})

test('a stored root damaged, the file intact: repaired through the records path', async () => {
    const fixture = await Fixture.create()
    const file = await savedChain(fixture)
    const { hex } = await ownChunk(fixture)
    const needing = await rowsReaching(fixture, hex)
    await fixture.store.write(['nodes'], async (tx) => {
        const key = hashKey(fromHex16(hex))
        const row = (await tx.get('nodes', key)) as Record<string, unknown> & { noteCount: number }
        await tx.put('nodes', { ...row, noteCount: row.noteCount + 1 }, key)
    })
    assert.equal((await stillBad(fixture.store, [hex])).size, 1)

    const { result } = await runCheck(await checker(fixture), fixture.chainId, file)
    assert.equal(result.repaired, needing.size)
    assert.equal(result.damaged, 0)
    assert.ok(allKept(await keptFlags(fixture)))
    assert.equal((await stillBad(fixture.store, [hex])).size, 0)
})

test('a stored chunk damaged with no file: exactly the rows that need it are marked', async () => {
    const fixture = await Fixture.create()
    await savedChain(fixture)
    const { chunk } = await ownChunk(fixture)
    const needing = await rowsReaching(fixture, chunk)
    await damageChunkRow(fixture, chunk)

    const { result } = await runCheck(await checker(fixture), fixture.chainId)
    assert.equal(result.repaired, 0)
    assert.equal(result.damaged, needing.size)
    assert.equal(result.marked, needing.size)
    const flags = await keptFlags(fixture)
    for (const [key, kept] of flags) assert.equal(kept, !needing.has(key), key)
    const bad = (await fixture.chain()).badChunks as Uint8Array
    assert.deepEqual(unpackHashes(bad).map(toHex), [chunk])

    // A second check finds the same rows, already marked, and marks nothing more.
    const again = await runCheck(await checker(fixture), fixture.chainId)
    assert.equal(again.result.damaged, 0)
    assert.equal(again.result.marked, undefined)
})

/** Replaces the stored cover's bytes with others under its key. */
const damageCover = (fixture: Fixture) =>
    fixture.store.write(['media'], async (tx) => {
        const key = hashKey(fromHex16(COVER.ref.hash))
        const row = (await tx.get('media', key)) as Record<string, unknown>
        await tx.put('media', { ...row, blob: new Blob([new Uint8Array([1, 2, 3])]) }, key)
        return row
    })

const coverRow = (fixture: Fixture) =>
    fixture.store.read(['media'], (tx) => tx.get('media', hashKey(fromHex16(COVER.ref.hash))))

test('a stored cover damaged with no copy is removed; one stored again meanwhile is kept', async () => {
    const fixture = await Fixture.create()
    await savedChain(fixture)
    const good = await damageCover(fixture)

    const { result } = await runCheck(await checker(fixture), fixture.chainId)
    assert.deepEqual(result.media, [{ hash: COVER.ref.hash, kinds: ['cover'], outcome: 'removed' }])
    assert.equal(await coverRow(fixture), undefined)
    assert.ok(allKept(await keptFlags(fixture)))

    // Stored again whole between the stored phase and the finish (a flush's re-store): kept.
    await fixture.store.write(['media'], (tx) =>
        tx.put('media', good, hashKey(fromHex16(COVER.ref.hash))),
    )
    await damageCover(fixture)
    const check = await checker(fixture)
    const id = await checkStored(check, fixture.chainId)
    await fixture.store.write(['media'], (tx) =>
        tx.put('media', good, hashKey(fromHex16(COVER.ref.hash))),
    )
    const later = await finish(check, id)
    assert.deepEqual(later.media, [{ hash: COVER.ref.hash, kinds: ['cover'], outcome: 'repaired' }])
    assert.deepEqual(await coverRow(fixture), good)
})

test('after Check removes a damaged cover with no copy, the next Save writes that state without it', async () => {
    const fixture = await Fixture.create()
    await savedChain(fixture)
    await damageCover(fixture)
    const { result } = await runCheck(await checker(fixture), fixture.chainId)
    assert.equal(result.media[0]?.outcome, 'removed')

    const { built, file } = await save(fixture, { kind: 'copy' })
    assert.ok(!('refused' in built) && file)
    assert.deepEqual(built.without, ['cover'])
    const { read } = await heldRows(file)
    assert.equal(read.open, 'full')
    assert.equal(read.media.cover, undefined)
    assert.notEqual(read.media.preview, undefined)
    // The state still names it, as metadata only.
    const cover = read.project?.metadata?.cover
    assert.ok(cover && cover.file === undefined)
    assert.equal(cover.hash, COVER.ref.hash)
})

test('read-only storage (?safe): the same report, and nothing written', async () => {
    const report = async (flags?: { readOnly: true }) => {
        const fixture = await Fixture.create()
        await savedChain(fixture)
        const { chunk } = await ownChunk(fixture)
        await damageChunkRow(fixture, chunk)
        await damageCover(fixture)
        const stores = ['entries', 'chains', 'nodes', 'chunks', 'media']
        const before = await dump(fixture, stores)
        const { result } = await runCheck(await checker(fixture, flags), fixture.chainId)
        return { result, before, after: await dump(fixture, stores) }
    }
    const stored = await report()
    const safe = await report({ readOnly: true })
    assert.equal(safe.result.readOnly, true)
    assert.equal(safe.result.markFailed, undefined)
    assert.ok(safe.result.media.every(({ outcome }) => outcome === 'left'))
    assert.equal(safe.result.damaged, stored.result.damaged)
    assert.equal(safe.result.repaired, stored.result.repaired)
    assert.ok(safe.result.damaged > 0)
    assert.deepEqual(
        safe.result.media.map(({ hash, kinds }) => ({ hash, kinds })),
        stored.result.media.map(({ hash, kinds }) => ({ hash, kinds })),
    )
    assert.deepEqual(safe.after, safe.before)
    assert.notDeepEqual(stored.after, stored.before)
})

/** `nse-maint` exclusive held elsewhere `busy` times, then free: each removal runs on the store. */
const busyRemoval = (fixture: Fixture, busy: number) => {
    const sleeps: number[] = []
    let calls = 0
    const removal: MediaRemoval = {
        sleep: (ms) => {
            sleeps.push(ms)
            return Promise.resolve()
        },
        exclusive: async (body) => {
            if (calls++ < busy) return { ran: false }
            const value = await body((hash) =>
                fixture.store.write(['media'], (tx) =>
                    tx.delete('media', hashKey(fromHex16(hash))),
                ),
            )
            return { ran: true, value }
        },
    }
    return { removal, sleeps, calls: () => calls }
}

test('a bad media row waits out a busy nse-maint 200 ms apart, six tries at most, and is left when it stays busy', async () => {
    const fixture = await Fixture.create()
    await savedChain(fixture)
    await damageCover(fixture)

    const always = busyRemoval(fixture, Infinity)
    assert.equal(await removeBadMedia(fixture.store, COVER.ref.hash, always.removal), 'left')
    assert.equal(always.calls(), 6)
    assert.deepEqual(always.sleeps, Array(5).fill(MEDIA_RETRY_MS))
    assert.notEqual(await coverRow(fixture), undefined)

    const twice = busyRemoval(fixture, 2)
    assert.equal(await removeBadMedia(fixture.store, COVER.ref.hash, twice.removal), 'removed')
    assert.deepEqual(twice.sleeps, [MEDIA_RETRY_MS, MEDIA_RETRY_MS])
    assert.equal(await coverRow(fixture), undefined)
})

test('a damaged root rewritten by a newer build before the finish: the finish refuses, marking nothing', async () => {
    const fixture = await Fixture.create()
    await savedChain(fixture)
    const { chunk, hex } = await ownChunk(fixture)
    await damageChunkRow(fixture, chunk)
    const check = await checker(fixture)
    const id = await checkStored(check, fixture.chainId)
    await fixture.store.write(['nodes'], async (tx) => {
        const key = hashKey(fromHex16(hex))
        const row = (await tx.get('nodes', key)) as Record<string, unknown>
        await tx.put('nodes', { ...row, v: RECORDS_V + 1 }, key)
    })
    const result = await check.tab.run(() => check.handlers.checkFinish({ id }))
    assert.deepEqual(result, { kind: 'refused', reason: 'needsNewer' })
    assert.ok(allKept(await keptFlags(fixture)))
})

test('marks that cannot be stored say so: the result is never a clean one', async () => {
    const fixture = await Fixture.create()
    await savedChain(fixture)
    const { chunk } = await ownChunk(fixture)
    await damageChunkRow(fixture, chunk)
    const { result } = await runCheck(
        await checker(fixture, undefined, { failWrites: true }),
        fixture.chainId,
    )
    assert.equal(result.markFailed, true)
    assert.equal(result.marked, undefined)
    assert.ok(result.damaged > 0)
    assert.ok(allKept(await keptFlags(fixture)))
})
