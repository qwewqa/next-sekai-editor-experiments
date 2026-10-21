import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activation } from '../saveMatrix/env'

// The pick session (spec B rules 3 to 8): the read of the chain's own file awaited, with one retry;
// the activation checked last; the commit point at the picker's return; the hold on `nse-bind`;
// what the editor holds of a file put back, or offered at once. The fakes are the in-memory
// platform with a fake lock manager, a storage worker that answers only what a pick asks, and a
// flusher that does nothing.

const { createMockPlatform } = await import('../../../src/platform/mock')
const { FileError, setPlatformForTests } = await import('../../../src/platform')
const { FakeLockManager } = await import('../../../src/local/testing/locks')
const { nxspDiskState } = await import('../../../src/platform/fingerprint')
const { setSaveEnvironment } = await import('../../../src/editor/save/binding')
const { rememberHandle, forgetHandle } = await import('../../../src/editor/save/env')
const { withPickSession } = await import('../../../src/editor/save/pickSession')
const { keepCopy } = await import('../../../src/local/open/kept')
const { clearExportMemory, exportMemory } =
    await import('../../../src/editor/commands/exportLevel/memory')
const { assembleZip, prepareEntry } = await import('../../../src/zip')
const { resetStates } = await import('../../../src/history/stack')
const { chartState } = await import('../chartFixture')
const { initialStep } = await import('../../helpers/historySteps')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
        reserved: undefined as unknown,
        chain: {
            chainId: 'c1',
            docId: 'doc',
            file: {
                name: 'a.nxsp',
                event: 'saved',
                at: 1,
                hash: new Uint8Array(16),
                options: { history: true, bgm: true },
            },
        } as Record<string, unknown>,
    }
    const calls: string[] = []
    let gate: Promise<void> | undefined
    const worker = {
        call: async (method: string) => {
            calls.push(method)
            if (method === 'keepHandle') await gate
            if (method === 'openPendingImports' || method === 'listHandleOwners') return []
            if (method === 'saveNeeds') return { carries: false, lacking: [] }
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
    const disk = await nxspDiskState(await handle.getFile(), 0)
    const pre = {
        blob: new Blob([original!]),
        disk,
        atBase: false,
        handle,
    }

    const offers: { name: string; emptied: boolean; downloadable: boolean; lockHeld: boolean }[] =
        []
    const downloads: { name: string; bytes: Uint8Array | undefined }[] = []
    const answer: { notPutBack: 'download' | undefined } = { notPutBack: undefined }
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
        notPutBack: (name: string, emptied: boolean, downloadable: boolean) => {
            offers.push({ name, emptied, downloadable, lockHeld: lockHeld() })
            return Promise.resolve(answer.notPutBack)
        },
        download: async (name: string, blob: Blob) => {
            downloads.push({ name, bytes: await bytesOf(blob) })
        },
    }
    const spec = (more: Record<string, unknown> = {}) => ({
        env,
        name: 'out.nxsp',
        surface: 'save' as const,
        purpose: 'save' as const,
        commitFirst: false,
        read: 'start' as const,
        ui,
        ...more,
    })
    const picker = { id: 'p', types: [], excludeAll: true, startIn: 'documents' as const }
    return {
        mock,
        worker,
        log,
        calls,
        ui,
        spec,
        picker,
        handle,
        pre,
        original: original!,
        offers,
        downloads,
        answer,
        lockHeld,
        hold: (open: Promise<void>) => {
            gate = open
        },
    }
}

test('the picker opens only after the read has settled, and a failed read is tried once more', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    let seen: unknown
    // A read that fails first and is slow: the session waits for it, then reads again.
    const read = sleep(150).then(() => ({ kind: 'failed' as const }))
    const running = withPickSession(t.spec({ read }), (session) =>
        session.pick(t.picker, 'out.nxsp', (picked) => {
            seen = picked.pre
            return Promise.resolve('none')
        }),
    )
    await sleep(60)
    assert.deepEqual(t.log, [], 'no picker while the read has not settled')
    await running
    assert.deepEqual(t.log, ['picker:active'])
    assert.deepEqual(await bytesOf((seen as { blob: Blob }).blob), t.original, 'the retry read it')
})

test('a read with no handle or no grant is not tried again', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    forgetHandle('c1')
    await withPickSession(
        t.spec({ read: Promise.resolve({ kind: 'noAccess' as const }) }),
        (session) => session.pick(t.picker, 'out.nxsp', () => Promise.resolve('none')),
    )
    assert.equal(t.calls.includes('readHandle'), false)
})

test('the activation is checked after the last wait, so a press never lapses before the picker', async () => {
    const t = await setup()
    t.mock.saveTargets.push('cancel')
    // A copy of an opened file is still being kept; waiting for it outlasts the press.
    let release!: () => void
    t.hold(new Promise<void>((resolve) => (release = resolve)))
    const copy = keepCopy(t.worker as never, 'c1', new Blob(['opened']), t.handle)
    await withPickSession(t.spec(), async (session) => {
        setTimeout(() => {
            activation.active = false
            release()
        }, 20)
        return session.pick(t.picker, 'out.nxsp', () => Promise.resolve('none'))
    })
    await copy
    assert.deepEqual(t.log, ['ready', 'picker:active'], 'asked for a new press after the wait')
})

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

test('the file is written and its put-back made inside one hold on nse-bind, and the offer after it', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    const heldIn: boolean[] = []
    await withPickSession(
        t.spec({ read: Promise.resolve({ kind: 'read' as const, pre: t.pre }) }),
        (session) =>
            session.pick(t.picker, 'out.nxsp', () => {
                heldIn.push(t.lockHeld())
                // Another program fills the file before the Save puts anything back.
                t.mock.writeFile('a.nxsp', new Blob(['another program']))
                return Promise.resolve('none')
            }),
    )
    assert.deepEqual(heldIn, [true])
    assert.equal(t.lockHeld(), false)
    assert.deepEqual(t.offers, [
        { name: 'a.nxsp', emptied: false, downloadable: true, lockHeld: false },
    ])
})

test('a pick that is not written gets the bytes read of it back, and offers them when it cannot', async () => {
    // Put back while the file is still empty.
    const back = await setup()
    back.mock.saveTargets.push({ kind: 'handle', handle: back.handle })
    await withPickSession(
        back.spec({ read: Promise.resolve({ kind: 'read' as const, pre: back.pre }) }),
        (session) =>
            session.pick(back.picker, 'out.nxsp', () => {
                assert.equal(back.mock.files.get('a.nxsp')?.size, 0, 'the picker emptied it')
                return Promise.resolve('none')
            }),
    )
    assert.deepEqual(await bytesOf(back.mock.files.get('a.nxsp')), back.original)
    assert.deepEqual(back.offers, [])

    // Filled meanwhile: offered at once, before the session returns, and downloaded on request.
    const gone = await setup()
    gone.mock.saveTargets.push({ kind: 'handle', handle: gone.handle })
    gone.answer.notPutBack = 'download'
    const result = await withPickSession(
        gone.spec({ read: Promise.resolve({ kind: 'read' as const, pre: gone.pre }) }),
        async (session) => {
            const outcome = await session.pick(gone.picker, 'out.nxsp', () => {
                gone.mock.writeFile('a.nxsp', new Blob(['another program']))
                return Promise.resolve('conflict')
            })
            assert.equal(gone.offers.length, 1, 'the offer was made before the flow went on')
            return outcome
        },
    )
    assert.equal(result, 'conflict')
    assert.deepEqual(gone.downloads, [{ name: 'a.nxsp', bytes: gone.original }])
})

test('a refused pick with nothing to give back is told the file was emptied, with OK only', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    // The session was opened from this chart file, whose bytes were not kept.
    exportMemory.opened = { handle: t.handle, levelData: false, project: false } as never
    const result = await withPickSession(t.spec(), async (session) => {
        const outcome = await session.pick(t.picker, 'out.nxsp', () => Promise.resolve('refused'))
        return { outcome, offered: session.offered }
    })
    clearExportMemory()
    assert.deepEqual(result, { outcome: 'refused', offered: { emptied: true } })
    assert.deepEqual(t.offers, [
        { name: 'a.nxsp', emptied: true, downloadable: false, lockHeld: false },
    ])
})

test('a write that landed but whose read-back failed is not offered the bytes it holds', async () => {
    const t = await setup()
    t.mock.saveTargets.push({ kind: 'handle', handle: t.handle })
    t.mock.fault = (point) => {
        if (point === 'closed')
            throw new FileError('io', 'The read-back failed', undefined, 'readBack')
    }
    const grown = new Blob([t.original, 'and what this Save added'])
    const outcome = await withPickSession(
        t.spec({ read: Promise.resolve({ kind: 'read' as const, pre: t.pre }) }),
        (session) =>
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
    assert.deepEqual(t.offers, [], 'the file begins with the bytes that were read')
})
