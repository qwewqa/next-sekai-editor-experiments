import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { activation } from '../saveMatrix/env'

// The packages this tab opened, where nothing else places a picked file: refused, and their bytes
// put back if the save picker emptied the file. Wherever the save's own rules place the file,
// they decide, exactly as they do without a package. Every write of this tab to a handle forgets
// the file's package first, through the platform; a put-back of the package's own bytes registers
// it again. The register, the session's source, the binding, the platform and the pick session's
// hold, write and put-back are the real ones, on the in-memory platform, whose save picker empties
// a file as Chromium's does.

const { createMockPlatform } = await import('../../../src/platform/mock')
const platformModule = await import('../../../src/platform')
const { FileError, setPlatformForTests } = platformModule
const { levelDataDiskState } = await import('../../../src/platform/fingerprint')
const { FakeLockManager } = await import('../../../src/local/testing/locks')
const { setSaveEnvironment } = await import('../../../src/editor/save/binding')
const { rememberHandle, forgetHandle } = await import('../../../src/editor/save/env')
const { withPickSession } = await import('../../../src/editor/save/pickSession')
const packages = await import('../../../src/editor/save/openedPackages')
const { exportToTarget } = await import('../../../src/editor/commands/exportLevel/flow')
const { clearExportMemory, exportMemory, KEPT_BYTES_LIMIT } =
    await import('../../../src/editor/commands/exportLevel/memory')
const { resetStates } = await import('../../../src/history/stack')
const { chartState } = await import('../chartFixture')
const { initialStep } = await import('../../helpers/historySteps')

const PATH = 'x'
type Purpose = 'save' | 'saveToFile' | 'export'
const purposes: Purpose[] = ['save', 'saveToFile', 'export']
type Outcome = { refused: boolean; file: string }

/** A level data file's bytes, gzipped as Export writes it. */
const levelBytes = (n: number) =>
    new Blob([gzipSync(JSON.stringify({ bgmOffset: 0, entities: [{ n }] }))])

/** One tab, one session at a time, and the path. */
const world = () => {
    localStorage.clear()
    clearExportMemory()
    packages.resetOpenedPackagesForTests()
    activation.active = true
    resetStates({ isDirty: true, step: initialStep(), state: chartState([[]]) })
    const manager = new FakeLockManager()
    const mock = createMockPlatform({ locks: manager.client(manager.scheduler.main) })
    setPlatformForTests(mock)
    const envOf = (chainId: string, bound?: string) => ({
        worker: {
            call: async (method: string) => {
                if (method === 'openPendingImports' || method === 'listHandleOwners') return []
                if (method === 'saveNeeds') return { carries: false, lacking: [] }
                return undefined
            },
        } as never,
        flusher: {
            session: { id: chainId, chainId, nextSeq: 5, stored: true },
            reserveSave: () => undefined,
            endSave: () => Promise.resolve('ended'),
            release: () => Promise.resolve('ended'),
            flush: () => Promise.resolve(),
            reservationEnded: () => Promise.resolve(),
        } as never,
        session: {
            id: chainId,
            chainId,
            nextSeq: 5,
            stored: true,
            atOnce: false,
            chain: {
                chainId,
                docId: 'doc',
                ...(bound
                    ? { file: { name: bound, event: 'opened', at: 1, hash: new Uint8Array(16) } }
                    : {}),
            },
        } as never,
        chainId,
    })
    let env = envOf('blank')
    setSaveEnvironment(() => env)
    let chains = 0
    const file = async () => (await mock.files.get(PATH)?.text()) ?? '(none)'
    const self = {
        mock,
        file,
        /** New, Reopen or Recent Sessions: another session, its source cleared as a switch clears it. */
        switch: (bound?: FileSystemFileHandle) => {
            clearExportMemory()
            const chainId = `c${++chains}`
            env = envOf(chainId, bound?.name)
            if (bound) {
                forgetHandle(chainId)
                rememberHandle(chainId, bound)
            }
        },
        /** Another program writes the path. */
        replace: (content: string | Blob) => mock.writeFile(PATH, new Blob([content])),
        /** Open finds a package at the path: registered before anything else is read of it. */
        package: (content: string, size?: number) => {
            self.replace(content)
            packages.registerOpenedPackage(
                mock.createHandle(PATH),
                size === undefined ? new File([content], PATH) : ({ size } as Blob),
            )
        },
        /** Open opens plain level data at the path: a new session whose source it is. */
        levelData: async (content: string) => {
            self.replace(content)
            const handle = mock.createHandle(PATH)
            self.switch()
            exportMemory.opened = {
                handle,
                levelData: true,
                partial: false,
                kept: await new Blob([content]).arrayBuffer(),
            }
        },
        /** Open opens a project file at the path whole: a new session bound to it. */
        project: (content: string) => {
            self.replace(content)
            self.switch(mock.createHandle(PATH))
        },
        /** A save picker: a refusal puts back what it chose; anything else writes. */
        pick: async (purpose: Purpose): Promise<Outcome> => {
            // The kept bytes are read at registration.
            await new Promise((resolve) => setTimeout(resolve, 0))
            mock.saveTargets.push({ kind: 'handle', handle: mock.createHandle(PATH) })
            const ui = {
                preparing: () => ({
                    signal: new AbortController().signal,
                    importing: () => undefined,
                    built: () => undefined,
                    ready: () => Promise.resolve(true),
                    close: () => undefined,
                }),
                notPutBack: () => Promise.resolve(undefined),
                download: () => Promise.resolve(),
            }
            let refused = false
            await withPickSession(
                {
                    env,
                    name: 'out',
                    surface: purpose === 'export' ? 'export' : 'save',
                    purpose,
                    commitFirst: false,
                    read: 'start',
                    ui,
                } as never,
                (session) =>
                    session.pick(
                        { id: 'p', types: [], excludeAll: true, startIn: 'documents' },
                        PATH,
                        async (picked) => {
                            if (picked.identity.kind === 'refused') {
                                refused = true
                                return 'refused'
                            }
                            // The pick session's own write, as Save and Export make it.
                            await picked
                                .write({
                                    kind: purpose === 'export' ? 'nsld' : 'nxsp',
                                    blob: new Blob([purpose === 'export' ? 'EXPORTED' : 'SAVED']),
                                })
                                .catch(() => undefined)
                            return 'written'
                        },
                    ),
            )
            return { refused, file: await file() }
        },
    }
    return self
}

const refused = (file: string): Outcome => ({ refused: true, file })
const SAVED: Outcome = { refused: false, file: 'SAVED' }
const EXPORTED: Outcome = { refused: false, file: 'EXPORTED' }
const written = (purpose: Purpose) => (purpose === 'export' ? EXPORTED : SAVED)

for (const purpose of purposes) {
    test(`a package alone: ${purpose} is refused and puts it back`, async () => {
        const w = world()
        w.package('P1')
        assert.deepEqual(await w.pick(purpose), refused('P1'))
    })

    test(`the same file opened as a package twice: ${purpose} puts back the newest`, async () => {
        const w = world()
        w.package('P1')
        w.package('P2')
        assert.deepEqual(await w.pick(purpose), refused('P2'))
    })

    test(`a package put back is still the package: a second ${purpose} after a switch`, async () => {
        const w = world()
        w.package('P1')
        assert.deepEqual(await w.pick(purpose), refused('P1'))
        w.switch()
        assert.deepEqual(await w.pick(purpose), refused('P1'))
    })

    test(`a package, then session switches: ${purpose} still refuses it`, async () => {
        const w = world()
        w.package('P1')
        w.switch()
        w.switch()
        assert.deepEqual(await w.pick(purpose), refused('P1'))
    })

    test(`a package over 64 MiB: ${purpose} is refused, nothing put back`, async () => {
        const w = world()
        w.package('P1', KEPT_BYTES_LIMIT + 1)
        assert.deepEqual(await w.pick(purpose), refused(''))
    })

    test(`level data, then a package at the same path: ${purpose} by the source's rule`, async () => {
        // A file replaced outside the editor: the session's source puts back what it read.
        const w = world()
        await w.levelData('L1')
        w.package('P2')
        assert.deepEqual(await w.pick(purpose), purpose === 'export' ? EXPORTED : refused('L1'))
    })

    test(`a project, then a package at the same path: ${purpose} by the binding`, async () => {
        const w = world()
        w.project('J1')
        w.package('P2')
        assert.deepEqual(await w.pick(purpose), written(purpose))
    })

    test(`a package at the session's Export target: ${purpose} by the save's own rules`, async () => {
        const w = world()
        w.package('P1')
        const handle = w.mock.createHandle(PATH)
        exportMemory.target = {
            name: PATH,
            handle,
            disk: { fingerprint: 'f', size: 2, lastModified: 0 },
            exported: false,
        }
        assert.deepEqual(await w.pick(purpose), written(purpose))
    })
}

test('a project, a package in its place, a Save over the bound file, a switch: Save As writes', async () => {
    const w = world()
    w.project('J1')
    w.package('P2')
    // The binding places the file: the pick session's write goes over it.
    assert.deepEqual(await w.pick('save'), SAVED)
    w.switch()
    // The write forgot the package: nothing places the file now.
    assert.deepEqual(await w.pick('save'), SAVED)
})

test('level data, a package in its place, the source put back, New: never the package', async () => {
    const w = world()
    await w.levelData('L1')
    w.package('P2')
    // The source's rule puts back what it read, over the package.
    assert.deepEqual(await w.pick('save'), refused('L1'))
    w.switch()
    // That put-back forgot the package: nothing places the file now.
    assert.deepEqual(await w.pick('save'), SAVED)
})

test('an Export whose read-back fails after it committed forgets the package too', async () => {
    const w = world()
    await w.levelData('L1')
    w.package('P2')
    w.mock.fault = (point) => {
        if (point === 'closed')
            throw new FileError('io', 'The read-back failed', undefined, 'readBack')
    }
    // Export may write over its own source: the write commits, then its read-back fails.
    assert.deepEqual(await w.pick('export'), EXPORTED)
    w.mock.fault = undefined
    w.switch()
    assert.deepEqual(await w.pick('save'), SAVED)
})

test('an Export to its target forgets a package registered for that file', async () => {
    const w = world()
    w.replace(levelBytes(0))
    const handle = w.mock.createHandle(PATH)
    const target = {
        name: PATH,
        handle,
        disk: await levelDataDiskState(await handle.getFile()),
        exported: false,
    }
    exportMemory.target = target
    // A package read at that path earlier, by another handle.
    packages.registerOpenedPackage(w.mock.createHandle(PATH), new File(['P1'], PATH))
    const ui = { exported: () => undefined, markExported: () => undefined }
    const outcome = await exportToTarget(
        {
            ui: ui as never,
            build: () => levelBytes(1),
            suggestedName: PATH,
            types: [],
            leave: () => undefined,
        },
        target,
    )
    assert.equal(outcome, 'done')
    assert.equal(await packages.openedPackageOf(w.mock.createHandle(PATH)), undefined)
})

/** A handle whose comparisons wait for `release`, as a slow `isSameEntry` does. */
const slowHandle = (mock: ReturnType<typeof createMockPlatform>) => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const handle = mock.createHandle(PATH)
    const isSameEntry = handle.isSameEntry.bind(handle)
    Object.assign(handle, {
        isSameEntry: async (other: FileSystemHandle) => {
            await gate
            return isSameEntry(other)
        },
    })
    return { handle, release }
}

test('a lookup never uses an entry the register replaced or forgot while it compared', async () => {
    packages.resetOpenedPackagesForTests()
    const mock = createMockPlatform()
    packages.registerOpenedPackage(mock.createHandle(PATH), new File(['P1'], PATH))
    const first = slowHandle(mock)
    const looking = packages.openedPackageBytes(first.handle)
    // Meanwhile the file is opened as a package again.
    packages.registerOpenedPackage(mock.createHandle(PATH), new File(['P2'], PATH))
    first.release()
    assert.equal(await (await looking)?.text(), 'P2')

    const second = slowHandle(mock)
    const lookingAgain = packages.openedPackageOf(second.handle)
    // Meanwhile it is opened as something else.
    const forgetting = packages.forgetOpenedPackage(mock.createHandle(PATH))
    second.release()
    await forgetting
    assert.equal(await lookingAgain, undefined)
})

test('bytes still being read when a newer package registers are not the ones put back', async () => {
    packages.resetOpenedPackagesForTests()
    const mock = createMockPlatform()
    // The first package's bytes are read slowly.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = {
        size: 2,
        arrayBuffer: async () => {
            await gate
            return new TextEncoder().encode('P1').buffer
        },
    } as Blob
    packages.registerOpenedPackage(mock.createHandle(PATH), slow)
    const looking = packages.openedPackageBytes(mock.createHandle(PATH))
    // The lookup now waits for those bytes; the file is opened as a package again.
    await new Promise((resolve) => setTimeout(resolve, 0))
    packages.registerOpenedPackage(mock.createHandle(PATH), new File(['P2'], PATH))
    release()
    assert.equal(await (await looking)?.text(), 'P2')
})
