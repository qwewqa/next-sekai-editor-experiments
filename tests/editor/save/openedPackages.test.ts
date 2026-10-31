import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activation } from '../saveMatrix/env'

// The packages this tab opened, where nothing else places a picked file: refused, and their bytes
// put back if the save picker emptied the file. Wherever the save's own rules place the file,
// they decide, exactly as they do without a package. The register, the session's source, the
// binding and the pick session's hold and put-back run on the in-memory platform, whose save
// picker empties a file as Chromium's does.

const { createMockPlatform } = await import('../../../src/platform/mock')
const { setPlatformForTests } = await import('../../../src/platform')
const { FakeLockManager } = await import('../../../src/local/testing/locks')
const { setSaveEnvironment } = await import('../../../src/editor/save/binding')
const { rememberHandle, forgetHandle } = await import('../../../src/editor/save/env')
const { withPickSession } = await import('../../../src/editor/save/pickSession')
const packages = await import('../../../src/editor/save/openedPackages')
const { clearExportMemory, exportMemory, KEPT_BYTES_LIMIT } =
    await import('../../../src/editor/commands/exportLevel/memory')
const { resetStates } = await import('../../../src/history/stack')
const { chartState } = await import('../chartFixture')
const { initialStep } = await import('../../helpers/historySteps')

const PATH = 'x'
type Purpose = 'save' | 'saveToFile' | 'export'
const purposes: Purpose[] = ['save', 'saveToFile', 'export']

type Step =
    /** Open finds a package: registered before anything else is read of it. */
    | ['package', string]
    /** As above, for a package over 64 MiB, whose bytes are not kept. */
    | ['largePackage', string]
    /** Open opens level data: the file is forgotten as a package; a new session from it. */
    | ['levelData', string]
    /** Open opens a project file whole: forgotten as a package; a new session bound to it. */
    | ['project', string]
    /** Open reads the file as audio or as data it cannot open: forgotten; the session stays. */
    | ['other', string]
    /** Another program writes the path. */
    | ['replace', string]
    /** This tab writes the path (an Export to its target, a Save over its own file). */
    | ['write', string]
    /** New, Reopen or Recent Sessions: another session. */
    | ['switch']

type Outcome = { refused: boolean; file: string }

const run = async (steps: Step[], purpose: Purpose): Promise<Outcome> => {
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
    const newSession = (bound?: FileSystemFileHandle) => {
        // A switch clears the session's source, as `onResetState` does.
        clearExportMemory()
        const chainId = `c${++chains}`
        env = envOf(chainId, bound?.name)
        if (bound) {
            forgetHandle(chainId)
            rememberHandle(chainId, bound)
        }
    }
    for (const step of steps) {
        // Each open picks the file again: another handle to the same file.
        const handle = mock.createHandle(PATH)
        switch (step[0]) {
            case 'package':
                mock.writeFile(PATH, new Blob([step[1]]))
                packages.registerOpenedPackage(handle, new File([step[1]], PATH))
                break
            case 'largePackage':
                mock.writeFile(PATH, new Blob([step[1]]))
                packages.registerOpenedPackage(handle, {
                    size: KEPT_BYTES_LIMIT + 1,
                } as Blob)
                break
            case 'levelData':
                mock.writeFile(PATH, new Blob([step[1]]))
                await packages.forgetOpenedPackage(handle)
                newSession()
                exportMemory.opened = {
                    handle,
                    levelData: true,
                    partial: false,
                    kept: await new Blob([step[1]]).arrayBuffer(),
                }
                break
            case 'project':
                mock.writeFile(PATH, new Blob([step[1]]))
                await packages.forgetOpenedPackage(handle)
                newSession(handle)
                break
            case 'other':
                mock.writeFile(PATH, new Blob([step[1]]))
                await packages.forgetOpenedPackage(handle)
                break
            case 'replace':
                mock.writeFile(PATH, new Blob([step[1]]))
                break
            case 'write': {
                const result = await mock.saveFile({
                    kind: 'nsld',
                    suggestedName: PATH,
                    target: { kind: 'handle', handle },
                    build: () => Promise.resolve(new Blob([step[1]])),
                })
                await packages.forgetWrittenPackage(result)
                break
            }
            case 'switch':
                newSession()
                break
        }
    }
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
                    await picked.write({
                        kind: purpose === 'export' ? 'nsld' : 'nxsp',
                        blob: new Blob([purpose === 'export' ? 'EXPORTED' : 'SAVED']),
                    })
                    return 'written'
                },
            ),
    )
    return { refused, file: (await mock.files.get(PATH)?.text()) ?? '(none)' }
}

const refused = (file: string): Outcome => ({ refused: true, file })
const each = (outcome: Outcome) => ({ save: outcome, saveToFile: outcome, export: outcome })
const SAVED: Outcome = { refused: false, file: 'SAVED' }
const EXPORTED: Outcome = { refused: false, file: 'EXPORTED' }

const rows: { name: string; steps: Step[]; expect: Record<Purpose, Outcome> }[] = [
    { name: 'a package alone', steps: [['package', 'P1']], expect: each(refused('P1')) },
    {
        name: 'the same file opened as a package twice: the newest bytes',
        steps: [
            ['package', 'P1'],
            ['replace', 'P2'],
            ['package', 'P2'],
        ],
        expect: each(refused('P2')),
    },
    {
        name: 'a package, then the same file opened as level data: its own rules',
        steps: [
            ['package', 'P1'],
            ['replace', 'L2'],
            ['levelData', 'L2'],
        ],
        expect: { save: refused('L2'), saveToFile: refused('L2'), export: EXPORTED },
    },
    {
        name: 'a package, then the same file opened as a project: its own file',
        steps: [
            ['package', 'P1'],
            ['replace', 'J2'],
            ['project', 'J2'],
        ],
        expect: { save: SAVED, saveToFile: SAVED, export: EXPORTED },
    },
    {
        name: 'a package, then the same file read as audio: nothing places it',
        steps: [
            ['package', 'P1'],
            ['replace', 'A2'],
            ['other', 'A2'],
        ],
        expect: { save: SAVED, saveToFile: SAVED, export: EXPORTED },
    },
    {
        // A file replaced outside the editor: the session's source puts back what it read.
        name: 'level data, then a package at the same path: the source decides',
        steps: [
            ['levelData', 'L1'],
            ['replace', 'P2'],
            ['package', 'P2'],
        ],
        expect: { save: refused('L1'), saveToFile: refused('L1'), export: EXPORTED },
    },
    {
        // The session stays bound to the file: its binding decides, as for any file replaced outside.
        name: 'a project, then a package at the same path: the binding decides',
        steps: [
            ['project', 'J1'],
            ['replace', 'P2'],
            ['package', 'P2'],
        ],
        expect: { save: SAVED, saveToFile: SAVED, export: EXPORTED },
    },
    {
        name: 'a package, then this tab writes the file',
        steps: [
            ['package', 'P1'],
            ['write', 'W2'],
        ],
        expect: { save: SAVED, saveToFile: SAVED, export: EXPORTED },
    },
    {
        name: 'a package, then session switches',
        steps: [['package', 'P1'], ['switch'], ['switch']],
        expect: each(refused('P1')),
    },
    {
        name: 'a package over 64 MiB: refused, nothing put back',
        steps: [['largePackage', 'P1']],
        expect: each(refused('')),
    },
]

for (const row of rows)
    for (const purpose of purposes)
        test(`${row.name}: ${purpose}`, async () => {
            assert.deepEqual(await run(row.steps, purpose), row.expect[purpose])
        })

test('a lookup never uses an entry the register replaced or forgot while it compared', async () => {
    packages.resetOpenedPackagesForTests()
    const mock = createMockPlatform()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    // A handle whose comparison waits, as a slow `isSameEntry` does.
    const slow = (name: string) => {
        const handle = mock.createHandle(name)
        const isSameEntry = handle.isSameEntry.bind(handle)
        return Object.assign(handle, {
            isSameEntry: async (other: FileSystemHandle) => {
                await gate
                return isSameEntry(other)
            },
        })
    }
    packages.registerOpenedPackage(mock.createHandle(PATH), new File(['P1'], PATH))
    const looking = packages.openedPackageOf(slow(PATH))
    // Meanwhile the file is opened as a package again.
    packages.registerOpenedPackage(mock.createHandle(PATH), new File(['P2'], PATH))
    release()
    assert.equal(await (await (await looking)?.bytes)?.text(), 'P2')

    let releaseAgain: () => void = () => undefined
    const gateAgain = new Promise<void>((resolve) => (releaseAgain = resolve))
    const slowAgain = mock.createHandle(PATH)
    const compare = slowAgain.isSameEntry.bind(slowAgain)
    Object.assign(slowAgain, {
        isSameEntry: async (other: FileSystemHandle) => {
            await gateAgain
            return compare(other)
        },
    })
    const lookingAgain = packages.openedPackageOf(slowAgain)
    // Meanwhile it is opened as something else.
    const forgetting = packages.forgetOpenedPackage(mock.createHandle(PATH))
    releaseAgain()
    await forgetting
    assert.equal(await lookingAgain, undefined)
})
