import assert from 'node:assert/strict'
import { hashKey } from '../../../src/local/db'
import { fromHex16, toHex } from '../../../src/local/hash'
import { KeyRange } from '../../../src/local/kv/types'
import { inspectNxsp } from '../../../src/local/nxsp/inspect'
import { distinctRootChunks } from '../../../src/local/nxsp/manifest'
import { readNxsp } from '../../../src/local/nxsp/read'
import { loadBodies, reachedHashes } from '../../../src/local/save/bodies'
import type { Tab } from '../../../src/local/testing/world'
import { checkHandlers, type CheckHandlers } from '../../../src/local/worker/checkHandlers'
import type { StorageCore, TestFlags } from '../../../src/local/worker/core'
import { workerCore } from '../flush/harness'
import { save, type Fixture } from '../save/fixture'

// Check File and History…'s worker side driven as the page drives it (Part 1 §1.4.21): the file
// phase, the stored phase, then the finish, each call a task of the checking tab, over the real
// storage core and handlers of a fixture's profile.

let tabs = 0

/** A chain with five states over two sessions, its media stored, saved to a file. */
export const savedChain = async (fixture: Fixture) => {
    await fixture.storeMedia()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.edit(2)
    fixture.undo()
    await fixture.flush()
    await fixture.start()
    await fixture.edit(3)
    await fixture.edit(4)
    await fixture.flush()
    const { built, file } = await save(fixture, { kind: 'copy' })
    assert.ok(!('refused' in built) && file)
    return file
}

/**
 * A tab of the fixture's profile with its own storage worker running the check handlers. Each
 * transaction starts as a task of that tab, as the fixture's store does: the test core's rule.
 */
export const checker = async (fixture: Fixture, flags?: TestFlags): Promise<Checker> => {
    const tab = fixture.world.tab(`check-${tabs++}`)
    const core = workerCore(fixture.world, tab, flags ? { flags } : {})
    await tab.run(() => core.start())
    const scheduled = Object.create(core) as StorageCore
    scheduled.read = (stores, fn, progress) => tab.run(() => core.read(stores, fn, progress))
    scheduled.write = (stores, fn, options) => tab.run(() => core.write(stores, fn, options))
    const handlers = checkHandlers(
        { core: scheduled, test: true, emit: () => undefined },
        { locks: tab.locks },
    )
    return { tab, core, handlers }
}

export type Checker = { tab: Tab; core: StorageCore; handlers: CheckHandlers }

/** The file phase: whether the file is damaged, by the open's checks and every chunk. */
export const checkFile = async ({ tab, handlers }: Checker, file: Blob) => {
    const opened = await tab.run(() => handlers.checkFileOpen(file))
    if (opened.kind !== 'read') return opened.kind
    const { id } = opened
    let damaged = false
    for (let n = 0; n < opened.batches; n++) {
        const batch = await tab.run(() => handlers.checkFileBatch({ id, n }))
        assert.equal(batch.kind, 'done')
        if (batch.kind === 'done' && batch.bad.length) damaged = true
    }
    await tab.run(() => handlers.checkDrop(id))
    return damaged ? 'damaged' : 'clean'
}

/** The stored phase; resolves the id the finish takes. */
export const checkStored = async ({ tab, handlers }: Checker, chainId: string) => {
    const opened = await tab.run(() => handlers.checkStoredOpen(chainId))
    assert.equal(opened.kind, 'opened')
    if (opened.kind !== 'opened') throw new Error('Not opened')
    const { id } = opened
    for (let n = 0; n < opened.batches; n++)
        assert.equal((await tab.run(() => handlers.checkStoredBatch({ id, n }))).kind, 'done')
    return id
}

export const finish = async ({ tab, handlers }: Checker, id: string, file?: Blob) => {
    const result = await tab.run(() => handlers.checkFinish({ id, ...(file ? { file } : {}) }))
    assert.equal(result.kind, 'done')
    if (result.kind !== 'done') throw new Error('Not done')
    return result
}

/** A whole check: the file (when given), the stored history, then the finish. */
export const runCheck = async (check: Checker, chainId: string, file?: Blob) => {
    const fileState = file ? await checkFile(check, file) : undefined
    const id = await checkStored(check, chainId)
    return { file: fileState, result: await finish(check, id, file) }
}

/** The stored rows' `kept` flags, by `sessionId:seq`. */
export const keptFlags = async (fixture: Fixture) =>
    new Map(
        (await fixture.entries()).map((row) => [`${row.sessionId}:${row.seq}`, row.kept !== false]),
    )

/** Every stored row of these stores, by key, for comparing before and after. */
export const dump = (fixture: Fixture, stores: readonly string[]) =>
    fixture.store.read(stores, async (tx) => {
        const out: Record<string, unknown[]> = {}
        for (const store of stores)
            out[store] = await tx.getAll(
                store,
                store === 'entries' ? KeyRange.bound(['', -Infinity], ['￿', Infinity]) : undefined,
            )
        return out
    })

/** A chunk one stored state needs and some other kept row's state doesn't, with that state. */
export const ownChunk = async (fixture: Fixture) => {
    const rows = (await fixture.entries()).filter((row) => row.kept !== false)
    const hexes = [...new Set(rows.map((row) => toHex(row.snapshot)))]
    for (const hex of hexes) {
        const own = await loadBodies(fixture.store, [hex])
        const others = await loadBodies(
            fixture.store,
            hexes.filter((each) => each !== hex),
        )
        const chunk = [...own.chunks.keys()].find((key) => !others.chunks.has(key))
        if (chunk) return { chunk, hex }
    }
    throw new Error('Every chunk is shared')
}

/** The kept rows whose states reach `hash`, by `sessionId:seq`: an oracle from the stored rows. */
export const rowsReaching = async (fixture: Fixture, hash: string) => {
    const out = new Set<string>()
    for (const row of await fixture.entries()) {
        if (row.kept === false) continue
        const roots = [
            toHex(row.snapshot),
            ...(row.stack?.push.map((slot) => toHex(slot.snapshot)) ?? []),
        ]
        if (roots.includes(hash) || (await reachedHashes(fixture.store, roots)).has(hash))
            out.add(`${row.sessionId}:${row.seq}`)
    }
    return out
}

/** Flips a byte of a stored chunk row: it then fails its key-bound CRC. */
export const damageChunkRow = (fixture: Fixture, hash: string) =>
    fixture.store.write(['chunks'], async (tx) => {
        const key = hashKey(fromHex16(hash))
        const row = (await tx.get('chunks', key)) as Record<string, unknown> & { bytes: Uint8Array }
        const bytes = row.bytes.slice()
        bytes[0] = (bytes[0] ?? 0) ^ 0x5a
        await tx.put('chunks', { ...row, bytes }, key)
    })

/** A file with a byte flipped in one chunk that neither its head nor any header uses. */
export const damageFileChunk = async (file: File) => {
    const read = await readNxsp(file)
    assert.ok(read.kind === 'nxsp' && read.history && read.project?.history)
    const { history } = read
    const used = new Set(distinctRootChunks(history, [history.head]))
    for (const root of history.roots.values()) used.add(root[1] as string)
    const hash = [...history.index.keys()].find((each) => !used.has(each))
    assert.ok(hash, 'a chunk outside the head')
    const place = history.index.get(hash)!
    const source = await inspectNxsp(file, { token: 't', role: 'target', fingerprint: '' })
    const entry = source.entries.find((each) => each.name === read.project?.history?.chunks)
    assert.ok(entry && entry.method === 0)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const at = entry.dataOffset + place.offset + Math.floor(place.length / 2)
    bytes[at] = (bytes[at] ?? 0) ^ 0xff
    return { file: new File([bytes], file.name, { lastModified: file.lastModified }), hash }
}
