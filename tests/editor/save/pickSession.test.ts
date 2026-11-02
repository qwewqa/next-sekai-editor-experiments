import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activation } from '../saveMatrix/env'

const { createMockPlatform } = await import('../../../src/platform/mock')
const { FileError, setPlatformForTests } = await import('../../../src/platform')
const { FakeLockManager } = await import('../../../src/local/testing/locks')
const { setSaveEnvironment } = await import('../../../src/editor/save/binding')
const { rememberHandle, forgetHandle } = await import('../../../src/editor/save/env')
const { withPickSession } = await import('../../../src/editor/save/pickSession')
const { clearExportMemory } = await import('../../../src/editor/commands/exportLevel/memory')
const { assembleZip, prepareEntry } = await import('../../../src/zip')
const { resetStates } = await import('../../../src/history/stack')
const { chartState } = await import('../chartFixture')
const { initialStep } = await import('../../helpers/historySteps')

const nxsp = async (revision: string) =>
    new Blob(
        assembleZip([
            await prepareEntry({
                name: 'project.json',
                method: 'store',
                data: new TextEncoder().encode(JSON.stringify({ revision: { id: revision } })),
            }),
        ]),
    )

const bytesOf = async (blob: Blob | undefined) =>
    blob ? new Uint8Array(await blob.arrayBuffer()) : undefined

/** What a session's UI and the world around it recorded. */
const setup = async () => {
    localStorage.clear()
    clearExportMemory()
    activation.active = true
    // The state a read of the file compares its media against.
    resetStates({ isDirty: true, step: initialStep(), state: chartState([[]]) })
    const manager = new FakeLockManager()
    const ours = manager.scheduler.main
    const mock = createMockPlatform({ locks: manager.client(ours) })
    setPlatformForTests(mock)
    const log: string[] = []
    const lockHeld = () =>
        manager.snapshot().held.some((l) => l.name === 'nse-bind' && l.clientId === ours.name)
    // The picker, logged with the activation at the moment it opens.
    const open = mock.pickSaveFile!
    ;(mock as { pickSaveFile?: unknown }).pickSaveFile = (request: never) => {
        log.push(`picker:${activation.active ? 'active' : 'lapsed'}`)
        return open(request)
    }

    const session = {
        id: 's1',
        chainId: 'c1',
        nextSeq: 5,
        stored: true,
        atOnce: false,
        reserved: undefined as unknown,
        chain: {
            chainId: 'c1',
            docId: 'doc',
            file: {
                name: 'a.nxsp',
                event: 'saved',
                at: 1,
                hash: new Uint8Array(16),
            },
        } as Record<string, unknown>,
    }
    const worker = {
        call: async (method: string) => {
            if (method === 'openPendingImports' || method === 'listHandleOwners') return []
            return undefined
        },
    }
    const flusher = {
        session,
        reserveSave: () => undefined,
        endSave: () => Promise.resolve('ended'),
        release: () => Promise.resolve('ended'),
        flush: () => Promise.resolve(),
        reservationEnded: () => Promise.resolve(),
    }
    const env = {
        worker: worker as never,
        flusher: flusher as never,
        session: session as never,
        chainId: 'c1',
    }
    setSaveEnvironment(() => env)

    // The chain's own file, as the dialog left it.
    mock.writeFile('a.nxsp', await nxsp('rev-1'))
    const handle = mock.createHandle('a.nxsp')
    forgetHandle('c1')
    rememberHandle('c1', handle)
    const original = await bytesOf(mock.files.get('a.nxsp'))!
    const ui = {
        preparing: () => ({
            signal: new AbortController().signal,
            importing: () => undefined,
            built: () => undefined,
            ready: () => {
                log.push('ready')
                activation.active = true
                return Promise.resolve(true)
            },
            close: () => undefined,
        }),
    }
    const spec = (more: Record<string, unknown> = {}) => ({
        env,
        name: 'out.nxsp',
        surface: 'save' as const,
        commitFirst: false,
        checkEmptied: true,
        ui,
        ...more,
    })
    /** The last session `run` ran, as its body ended. */
    const seen = { emptied: false }
    const run: typeof withPickSession = (spec, body) =>
        withPickSession(spec, (session) =>
            body(session).finally(() => {
                seen.emptied = session.emptied
            }),
        )
    const picker = { id: 'p', types: [], excludeAll: true, startIn: 'documents' as const }
    return {
        mock,
        env,
        flusher,
        session,
        worker,
        log,
        ui,
        spec,
        picker,
        handle,
        original: original!,
        seen,
        run,
        lockHeld,
    }
}

test('once the picker returned a file, a cancel changes nothing and the write lands', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    const dialog = new AbortController()
    const next = await nxsp('rev-2')
    const done = await withPickSession(t.spec({ signal: dialog.signal }), (session) =>
        session.pick(t.picker, 'out.nxsp', async (picked) => {
            dialog.abort()
            const result = await picked.write({ kind: 'nxsp', blob: next })
            return result.status
        }),
    )
    assert.equal(done, 'saved')
    assert.deepEqual(await bytesOf(t.mock.files.get('a.nxsp')), await bytesOf(next))
})

test('a failed read-back of a nonempty file does not report it as empty', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    t.mock.fault = (point) => {
        if (point === 'closed')
            throw new FileError('io', 'The read-back failed', undefined, 'readBack')
    }
    const grown = new Blob([t.original, 'and what this Save added'])
    const outcome = await t.run(t.spec(), (session) =>
        session.pick(t.picker, 'out.nxsp', async (picked) => {
            try {
                await picked.write({ kind: 'nxsp', blob: grown })
                return 'written'
            } catch (error) {
                return (error as { step?: string }).step
            }
        }),
    )
    assert.equal(outcome, 'readBack')
    assert.deepEqual(await bytesOf(t.mock.files.get('a.nxsp')), await bytesOf(grown))
    assert.equal(t.seen.emptied, false)
})

test("Recent Sessions' Save writes its prepared project without restoring the old file", async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    const other = await nxsp('rev-other')
    await t.run(t.spec(), (session) =>
        session.pick(t.picker, 'out.nxsp', (picked) => picked.write({ kind: 'nxsp', blob: other })),
    )
    // The selected session replaces the file.
    assert.deepEqual(await bytesOf(t.mock.files.get('a.nxsp')), await bytesOf(other))
    assert.equal(t.seen.emptied, false)
})

test('level data is never written over bytes that arrive between the two looks at the empty file', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    const inspect = t.mock.inspect
    // A sync client writes into the picked file just before the write's own look at it.
    t.mock.inspect = (target, kind) => {
        if (kind === 'nsld') t.mock.writeFile('a.nxsp', new Blob(['a sync client wrote this']))
        return inspect(target, kind)
    }
    const code = await withPickSession(t.spec(), (session) =>
        session.pick(t.picker, 'out.nsld', async (picked) => {
            try {
                await picked.write({ kind: 'nsld', blob: new Blob(['level']) })
                return 'written'
            } catch (error) {
                return (error as { code?: string }).code
            }
        }),
    )
    assert.equal(code, 'conflict')
    assert.equal(await t.mock.files.get('a.nxsp')!.text(), 'a sync client wrote this')
})

test('Save opens its picker without reading the bound file first', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    const next = await nxsp('new-document')
    await t.run(t.spec(), (session) =>
        session.pick(t.picker, 'a.nxsp', (picked) => picked.write({ kind: 'nxsp', blob: next })),
    )
    assert.deepEqual(t.log, ['picker:active'])
    assert.deepEqual(await bytesOf(t.mock.files.get('a.nxsp')), await bytesOf(next))
    assert.equal(t.seen.emptied, false)
})

for (const state of ['empty', 'filled', 'missing', 'unreadable'] as const)
    test('a failed Save reports emptiness only when confirmed: ' + state, async () => {
        const t = await setup()
        t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
        const result = await t
            .run(t.spec(), (session) =>
                session.pick(t.picker, 'a.nxsp', async () => {
                    if (state === 'filled') t.mock.writeFile('a.nxsp', new Blob(['changed']))
                    if (state === 'missing') t.mock.files.delete('a.nxsp')
                    if (state === 'unreadable')
                        t.mock.read = () => Promise.reject(new Error('unreadable'))
                    throw new FileError('io', 'failed')
                }),
            )
            .catch((error) => error)
        assert.equal(t.seen.emptied, state === 'empty')
        assert.ok(result.error instanceof FileError)
    })

test('a picked project filled before the write is refused as changed', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    const next = await nxsp('new-document')
    const result = await t
        .run(t.spec(), (session) =>
            session.pick(t.picker, 'a.nxsp', async (picked) => {
                t.mock.writeFile('a.nxsp', new Blob(['changed']))
                return picked.write({ kind: 'nxsp', blob: next })
            }),
        )
        .catch((error) => error)
    assert.equal(result.error.code, 'conflict')
    assert.equal(await t.mock.files.get('a.nxsp')?.text(), 'changed')
    assert.equal(t.seen.emptied, false)
})

test('preparation can expire activation and the picker then asks for Ready', async () => {
    const t = await setup()
    t.mock.saveTargets.push('cancel')
    await withPickSession(t.spec(), async (session) => {
        await session.preparing(async () => {
            activation.active = false
        })
        return session.pick(t.picker, 'out.nxsp', () => Promise.resolve('none'))
    })
    assert.deepEqual(t.log, ['ready', 'picker:active'])
})
