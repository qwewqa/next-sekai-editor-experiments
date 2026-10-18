import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import { fromHex16 } from '../../../src/local/hash'
import { PlanError } from '../../../src/local/nxsp/plan'
import { setSaveHooksForTests } from '../../../src/local/save/build'
import { buildSave, setBuiltHookForTests } from '../../../src/local/save/execute'
import { headInput } from '../../../src/local/save/pending'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { unzip, zipItems } from '../nxsp/craft'
import { Fixture, heldRows, save, saveOptions, sourceOf, stateAt } from './fixture'

// What a write reads of the pinned files, and the refusals: only the append source is read, so a
// 0-byte target (R9) or another file is never a conflict or damage; a change under the built file
// is a conflict; and the guards no other test pins (§1.11.6's Exit, review minor 12).

const ok = <T extends object>(value: T) => {
    assert.ok(!('refused' in value), JSON.stringify(value))
    return value as Exclude<T, { refused: string }>
}

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

const chain = async () => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    await fixture.flush()
    return fixture
}

const bound = async () => {
    const fixture = await chain()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    ok(first.built)
    assert.ok(first.file)
    await fixture.edit(2)
    await fixture.flush()
    return { fixture, file: first.file }
}

/** A file pinned as the platform pins it, with its `damaged:` or `zip:` fingerprint. */
const pinned = async (file: File, token = 'target') => ({
    token,
    role: 'target' as const,
    file,
    fingerprint: (await diskOf(file)).fingerprint,
})

test('a write-back over a 0-byte target writes the chain from storage, never a conflict (R9)', async () => {
    const { fixture } = await bound()
    const empty = new File([], 'coconut.nxsp', { lastModified: 123 })
    const files = [await pinned(empty)]
    assert.equal(files[0]?.fingerprint, 'damaged:0:123')
    const chainBefore = await fixture.chain()
    for (const target of [{ kind: 'copy' }, { kind: 'append', source: 'target' }] as const) {
        const { options } = saveOptions(fixture)
        const built = ok(await buildSave(fixture.store, fixture.chainId, target, options, files))
        // The identity is kept: the chain's docId, its revision as parent.
        assert.equal(built.identity.docId, chainBefore.docId)
        assert.equal(
            built.identity.revision.ancestors[0],
            (chainBefore.revision as { id: string }).id,
        )
        const { history } = await heldRows(built.blob)
        assert.equal(history.entries[0]?.kind, 'init')
    }
})

test('a pinned file other than the append source is never read, so never damage', async () => {
    const { fixture, file } = await bound()
    // A ZIP whose project.json doesn't parse: reading it would throw with it unchanged.
    const { items, modified } = await unzip(file)
    const project = items.find((item) => item.name === 'project.json')
    assert.ok(project)
    project.data = new TextEncoder().encode('{ not json')
    const broken = new File([await zipItems(items, modified)], 'coconut.nxsp', { lastModified: 9 })
    const truncated = new File([file.slice(0, 100)], 'coconut.nxsp', { lastModified: 9 })
    for (const other of [broken, truncated]) {
        for (const target of [{ kind: 'copy' }, { kind: 'replace', replaces: 'theirs' }] as const) {
            const { options } = saveOptions(fixture)
            const built = await buildSave(fixture.store, fixture.chainId, target, options, [
                await pinned(other),
            ])
            ok(built)
        }
    }
})

test('an append source that changed after its check and doesn’t read is a conflict, not damage', async () => {
    const { fixture, file } = await bound()
    const source = await sourceOf(file)
    // Replaced by bytes that aren't a ZIP: its fingerprint now isn't the pinned one.
    const replaced = new File([new Uint8Array(500).fill(7)], 'coconut.nxsp', { lastModified: 5 })
    const { options } = saveOptions(fixture)
    const built = await buildSave(
        fixture.store,
        fixture.chainId,
        { kind: 'append', source: 'target' },
        options,
        [{ ...source, file: replaced }],
    )
    assert.ok('refused' in built)
    assert.equal(built.refused, 'conflict')
})

/** A Blob whose reads fail as Chromium's do once the file under it changed. */
class ChangedBlob extends Blob {
    override slice(): Blob {
        return new ChangedBlob([])
    }

    override arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new DOMException('The file changed', 'NotReadableError'))
    }
}

test('a pinned file that changed under the built file is a conflict at the post-build check', async () => {
    const { fixture, file } = await bound()
    setBuiltHookForTests({ built: () => new ChangedBlob([new Uint8Array(64)]) })
    try {
        const { built } = await save(
            fixture,
            { kind: 'append', source: 'target' },
            { files: [await sourceOf(file)], binds: false },
        )
        assert.ok('refused' in built)
        assert.equal(built.refused, 'conflict')
    } finally {
        setBuiltHookForTests({})
    }
})

test('a write-back to a file whose completeFrom can’t be placed writes the target’s own id', async () => {
    const { fixture, file: first } = await bound()
    // A second revision, so the target has an older ancestor a clamp would take instead.
    const second = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(first)], disk: diskOf },
    )
    ok(second.built)
    const file = second.file
    assert.ok(file)
    await fixture.edit(3)
    await fixture.flush()
    const { items, modified } = await unzip(file)
    const projectItem = items.find((item) => item.name === 'project.json')
    assert.ok(projectItem)
    const project = JSON.parse(new TextDecoder().decode(projectItem.data)) as {
        revision: { id: string; ancestors: string[]; completeFrom?: string }
    }
    assert.equal(project.revision.ancestors.length, 1)
    project.revision.completeFrom = 'zz'
    projectItem.data = new TextEncoder().encode(JSON.stringify(project))
    const placed = new File([await zipItems(items, modified)], 'coconut.nxsp', {
        lastModified: 77,
    })
    // The binding follows the file, as an open of it would.
    const chainRecord = await fixture.chain()
    await fixture.putChain({
        file: { ...(chainRecord.file as object), disk: await diskOf(placed) },
    })
    const { built } = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(placed)], binds: false },
    )
    assert.equal(ok(built).identity.completeFrom, project.revision.id)
})

test('a head input for another state is ignored: the file holds the stack’s head', async () => {
    const fixture = await chain()
    const stale = headInput(stateAt(5).state)
    const { built } = await save(
        fixture,
        { kind: 'copy' },
        { event: 'downloaded', binds: false, extra: { head: stale } },
    )
    const plan = ok(built)
    assert.equal(plan.saveEntry.snapshot, stateAt(1).hex)
    assert.equal(plan.saveEntry.noteCount, headInput(stateAt(1).state).summary.noteCount)
    assert.notEqual(plan.saveEntry.noteCount, stale.summary.noteCount)
    const summary = plan.project.summary as { noteCount: number; durationMs: number }
    assert.deepEqual(
        { noteCount: summary.noteCount, durationMs: summary.durationMs },
        headInput(stateAt(1).state).summary,
    )
})

test('a chain whose open is still importing refuses until the import is done', async () => {
    const fixture = await chain()
    const session = fixture.session
    await fixture.store.write(['sessions'], async (tx) => {
        const row = (await tx.get('sessions', session.id)) as Record<string, unknown>
        await tx.put('sessions', { ...row, importPending: true })
    })
    const { built } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok('refused' in built)
    assert.equal(built.refused, 'importing')
})

test('a root of a version this build doesn’t read refuses with "Needs a newer version"', async () => {
    const fixture = await chain()
    const key = hashKey(fromHex16(stateAt(0).hex))
    await fixture.store.write(['nodes'], async (tx) => {
        const row = (await tx.get('nodes', key)) as Record<string, unknown>
        await tx.put('nodes', { ...row, v: 99 }, key)
    })
    const { built } = await save(fixture, { kind: 'copy' }, { binds: false })
    assert.ok('refused' in built)
    assert.equal(built.refused, 'needsNewer')
})

test('damage is marked in storage before the plan is final, even when the plan then fails', async () => {
    const fixture = await chain()
    await fixture.edit(2)
    await fixture.flush()
    // State 1's root is gone: its edit row is damage.
    await fixture.store.write(['nodes'], (tx) =>
        tx.delete('nodes', hashKey(fromHex16(stateAt(1).hex))),
    )
    setSaveHooksForTests({
        plan: () => {
            throw new PlanError('A later step failed')
        },
    })
    try {
        const { built } = await save(fixture, { kind: 'copy' }, { binds: false })
        assert.ok('refused' in built)
        assert.equal(built.refused, 'plan')
    } finally {
        setSaveHooksForTests({})
    }
    const stored = await fixture.entries()
    const edit1 = stored.find((row) => row.kind === 'edit' && row.label === 'Edit 1')
    assert.equal(edit1?.kept, false)
})
