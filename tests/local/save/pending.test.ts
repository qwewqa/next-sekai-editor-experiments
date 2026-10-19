import assert from 'node:assert/strict'
import test from 'node:test'
import { captureEntryDescription } from '../../../src/history/operations'
import type { IdentityInput, SaveTarget } from '../../../src/local/save/build'
import { buildSave, type BuiltSave } from '../../../src/local/save/execute'
import { pendingInput } from '../../../src/local/save/pending'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { noteAdd } from '../../helpers/historySteps'
import {
    asFile,
    checkFiles,
    Fixture,
    hasUv,
    heldRows,
    save,
    saveOptions,
    sourceOf,
    stateAt,
} from './fixture'

// This tab's unflushed rows (`pending`) and the binding in memory while storing is paused or full
// (§1.3.2, §1.4.7 "Storage unavailable or paused"): rows the file holds are never written twice,
// and a second rescue Save is an append that keeps its ancestry. A write-back's history follows
// its file.

const ok = <T extends object>(value: T) => {
    assert.ok(!('refused' in value), JSON.stringify(value))
    return value as Exclude<T, { refused: string }>
}

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const rowsOf = async (file: Blob) =>
    (await heldRows(file)).history.entries.map(
        (entry) => `${entry.kind}|${entry.time}|${entry.snapshot}`,
    )

test('pending rows the bound file already holds are not appended again (major 2)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, noteAdd(1))
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(!('refused' in first.built) && first.file)
    const old = fixture.session.rows[1]!
    // A row the file holds, still in the tab's unflushed list (a flush landed after the snapshot).
    const pending = pendingInput([
        {
            seq: old.seq,
            time: old.time,
            ...captureEntryDescription(old),
            state: stateAt(1).state,
            dirty: false,
        },
    ])
    const { built, file } = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(first.file)], disk: diskOf, extra: { pending } },
    )
    ok(built)
    assert.ok(file)
    const rows = await rowsOf(file)
    assert.equal(new Set(rows).size, rows.length, rows.join('\n'))
    assert.equal(rows.length, (await rowsOf(first.file)).length + 1)
})

test('a download never writes a stored row twice from pending', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, noteAdd(1))
    await fixture.flush()
    await fixture.edit(2, noteAdd(1))
    // Rows 2 and 3: row 2 is stored, row 3 isn't.
    const pending = fixture.pending(1)
    await fixture.store.write(['entries'], async (tx) => {
        const row = fixture.session.rows[1]!
        await tx.put('entries', { ...row })
    })
    const { built, file } = await save(
        fixture,
        { kind: 'copy' },
        { event: 'downloaded', binds: false, extra: { pending } },
    )
    ok(built)
    assert.ok(file)
    const rows = await rowsOf(file)
    assert.equal(new Set(rows).size, rows.length, rows.join('\n'))
    assert.deepEqual(
        rows.map((row) => row.split('|')[0]),
        ['init', 'edit', 'edit', 'save'],
    )
})

/** A Save while storing is paused: built from storage and `pending`, its binding kept in memory. */
const pausedSave = async (
    fixture: Fixture,
    target: SaveTarget,
    {
        identity,
        stored,
        files = [],
        downloaded = false,
    }: {
        identity?: IdentityInput
        stored: number
        files?: Awaited<ReturnType<typeof sourceOf>>[]
        downloaded?: boolean
    },
) => {
    const { options, reserved } = saveOptions(fixture, {
        pending: fixture.pending(stored),
        ...(identity ? { identity } : {}),
    })
    const built = ok(await buildSave(fixture.store, fixture.chainId, target, options, files))
    const file = asFile(built.blob)
    fixture.recordSave(built, reserved)
    const next: IdentityInput = {
        docId: built.identity.docId,
        revision: built.identity.revision,
        file: {
            ...(built.identity.entry
                ? {
                      entry: {
                          sessionId: reserved.sessionId,
                          seq: reserved.seq,
                          startedAt: reserved.startedAt,
                          ...built.identity.entry,
                      },
                  }
                : {}),
            ...(built.identity.completeFrom === undefined
                ? {}
                : { completeFrom: built.identity.completeFrom }),
            ...(downloaded ? {} : { disk: await diskOf(file) }),
        },
        marks: built.identity.marks,
    }
    return { built, file, identity: next }
}

test('with storing paused, a second Save appends to the first’s file through the binding in memory (major 4)', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, noteAdd(1))
    await fixture.flush()
    // Storing pauses: nothing more is stored, the binding included.
    const stored = fixture.session.rows.at(-1)!.seq
    await fixture.edit(2, noteAdd(1))
    const first = await pausedSave(fixture, { kind: 'copy' }, { stored })
    await fixture.edit(3, noteAdd(1))
    const second = await pausedSave(
        fixture,
        { kind: 'append', source: 'target' },
        { stored, identity: first.identity, files: [await sourceOf(first.file)] },
    )
    assert.equal(second.built.identity.revision.ancestors[0], first.built.revisionId)
    assert.equal(second.built.identity.completeFrom, first.built.identity.completeFrom)
    assert.equal(second.built.someStepsNotKept, false)
    const before = await rowsOf(first.file)
    const after = await rowsOf(second.file)
    assert.deepEqual(after.slice(0, before.length), before)
    assert.deepEqual(
        after.slice(before.length).map((row) => row.split('|')[0]),
        ['edit', 'save'],
    )
    assert.equal(after.at(-2)?.split('|')[2], stateAt(3).hex)
    // The earlier `save` entry keeps its revision and device.
    const { history } = await heldRows(second.file)
    const saves = history.entries.filter((entry) => entry.kind === 'save')
    assert.equal(saves[0]?.revisionId, first.built.revisionId)
    assert.ok(saves[0]?.device)
    if (hasUv) {
        const result = await checkFiles([first.file, second.file])
        assert.equal(result.status, 0, result.output)
    }
})

test('with storing paused, successive downloads keep their ancestry and carry', async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, noteAdd(1))
    await fixture.flush()
    const stored = fixture.session.rows.at(-1)!.seq
    await fixture.edit(2, noteAdd(1))
    const d1 = await pausedSave(fixture, { kind: 'copy' }, { stored, downloaded: true })
    await fixture.edit(3, noteAdd(1))
    const d2 = await pausedSave(
        fixture,
        { kind: 'copy' },
        { stored, identity: d1.identity, downloaded: true },
    )
    assert.deepEqual(d2.built.identity.revision.ancestors, [d1.built.revisionId])
    assert.equal(d2.built.identity.revision.n, 2)
    assert.equal(d2.built.someStepsNotKept, false)
    assert.equal(d2.built.identity.completeFrom, d1.built.identity.completeFrom)
    const rows = await rowsOf(d2.file)
    assert.equal(new Set(rows).size, rows.length)
    if (hasUv) {
        const result = await checkFiles([d1.file, d2.file])
        assert.equal(result.status, 0, result.output)
    }
})

const boundWith = async (history: boolean) => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1, noteAdd(1))
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf, extra: { history } })
    ok(first.built)
    assert.ok(first.file)
    await fixture.edit(2, noteAdd(1))
    await fixture.flush()
    return { fixture, file: first.file }
}

const writeBack = async (
    fixture: Fixture,
    file: File,
    history: boolean,
): Promise<[BuiltSave, File]> => {
    const { built, file: written } = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], disk: diskOf, extra: { history } },
    )
    assert.ok(written)
    return [ok(built), written]
}

test('a write-back with History unticked keeps its file’s history (minor 6)', async () => {
    const { fixture, file } = await boundWith(true)
    const [built, written] = await writeBack(fixture, file, false)
    assert.ok(built.identity.entry)
    const before = await rowsOf(file)
    const after = await rowsOf(written)
    assert.deepEqual(after.slice(0, before.length), before)
    assert.equal(after.length, before.length + 2)
})

test('a write-back with History ticked to a file without history writes none, never a conflict (nit 17)', async () => {
    const { fixture, file } = await boundWith(false)
    const [built, written] = await writeBack(fixture, file, true)
    assert.equal(built.identity.entry, undefined)
    const read = await (await import('../../../src/local/nxsp/read')).readNxsp(written)
    assert.ok(read.kind === 'nxsp')
    assert.equal(read.history, undefined)
})
