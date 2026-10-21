import type { FlushSession, SaveReservation } from '../../../src/local/flush'
import type { MockPlatform } from '../../../src/platform/mock'
import './env'
import { activation } from './env'

// The fault-matrix harness's world (B0, work/soundness/architecture-review.md §B.6): the Save
// core's real flow.ts and Export's real flow over the existing mock platform and its lock manager,
// with the storage side replaced by in-memory fakes that keep the facts the six invariants need:
// every reservation and how it ended, every write to a picked file and the locks held then, every
// picker opening with the activation and import state at that moment, every dialog and whether the
// lock was held while it showed. Nothing under src/ is changed: the singletons the browser's
// startup sets are the stubs in ./stubs, and the dialogs are `saveUi`'s test seam.

const { createMockPlatform } = await import('../../../src/platform/mock')
const { setPlatformForTests } = await import('../../../src/platform')
const { FakeLockManager } = await import('../../../src/local/testing/locks')
const { setStorageWorkerForMatrix } = await import('./stubs/start')
const { setFlusherForMatrix } = await import('./stubs/storing')
const { setSaveUiForTests } = await import('./stubs/dialogs')
const flow = await import('../../../src/editor/save/flow')
const { rootOf } = await import('../../../src/editor/save/build')
const env = await import('../../../src/editor/save/env')
const { session: currentSession, createSessionDescriptor } =
    await import('../../../src/history/session')
const { nxspDiskState } = await import('../../../src/platform/fingerprint')
const { assembleZip, prepareEntry } = await import('../../../src/zip')
const { liveState, resetStates } = await import('../../../src/history/stack')
const { chartState } = await import('../chartFixture')
const { initialStep } = await import('../../helpers/historySteps')
const { clearExportMemory, exportMemory, setExportPersister, setExportTargetReader } =
    await import('../../../src/editor/commands/exportLevel/memory')
const exportPick = await import('../../../src/editor/commands/exportLevel/pick')
const { startImport, isImporting } = await import('../../../src/local/open/importLoop')
const { markFirstSaveDone } = await import('../../../src/editor/file/flags')
const { useRealDoor } = await import('./door')

export { activation, exportMemory, exportPick, flow }

type Row = Record<string, unknown>
type FileTarget = { kind: 'handle'; handle: FileSystemFileHandle }

const encoder = new TextEncoder()
const NOW = 1_700_000_000_000

export const bytesOf = async (blob: Blob | undefined) =>
    blob ? new Uint8Array(await blob.arrayBuffer()) : undefined

export const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
    bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte)

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && startsWith(a, b)

/** A small valid ZIP with a `project.json` revision, so disk states compare as a `.nxsp`'s do. */
export const nxsp = async (revision: string, text: string) =>
    new Blob(
        assembleZip([
            await prepareEntry({
                name: 'project.json',
                method: 'store',
                data: encoder.encode(JSON.stringify({ revision: { id: revision } })),
            }),
            await prepareEntry({
                name: 'payload.txt',
                method: 'store',
                data: encoder.encode(text),
            }),
        ]),
    )

/** Level data as Export writes it: gzip is not needed, the mock never verifies. */
export const levelData = (text: string) => new Blob([`level:${text}`])

// What a scenario sets up (the keys are all optional).
export type Setup = {
    /** `download`: a browser without a save picker. */
    platform?: 'picker' | 'download'
    /** `bound`: bound to own.nxsp; `unbound`: no file; `missing`: bound, the file gone. */
    own?: 'bound' | 'unbound' | 'missing'
    /** Whether storage holds all the own file holds (the read-first is then not needed). */
    storage?: 'holds' | 'lacks'
    /** `ahead`: the own file changed on disk since the binding. */
    ownDisk?: 'base' | 'ahead'
    /** This tab holds the own handle in memory (else it is read from storage, as after a reload). */
    held?: boolean
    /** Read permission on the own handle. */
    read?: 'granted' | 'prompt' | 'denied'
    /** Another chain bound to other.nxsp. */
    other?: boolean
    /** Another chain's Export target, target.nsld. */
    target?: boolean
    /** The session was opened from opened.nsld: a chart, level data, or a partial import. */
    opened?: 'notProject' | 'levelData' | 'partial'
    /** The build reports damage in storage (SP-1): the own file is read again before the picker. */
    damaged?: boolean
    /**
     * `afterReload`: the session was opened from opened.nsld and the page has reloaded since, so
     * only storage knows the file: its handle is kept (D26) and its bytes are the OPFS copy.
     */
    kept?: 'afterReload'
}

export type Dialog = {
    kind: string
    args: unknown[]
    /** Whether this session held `nse-bind` while it showed. */
    lockHeld: boolean
}

export type Write = { name: string; exclusive: boolean; shared: boolean; picked: boolean }

export type PickerOpening = {
    name: string
    activation: boolean
    importing: boolean
    importPending: boolean
    dialogOpen: boolean
}

type ReservationLog = { reservation: SaveReservation; ends: { kept: boolean; entry: boolean }[] }

const OWN = 'own.nxsp'

/**
 * The bytes a partial open copied into the origin private file system, by chain (`nse-kept`): a
 * browser API that Node lacks, so the matrix gives `navigator.storage` the one folder the kept
 * copy is read from (`readKeptCopy`).
 */
const keptCopies = new Map<string, Blob>()
Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
        getDirectory: () =>
            Promise.resolve({
                getDirectoryHandle: (name: string) =>
                    name === 'nse-kept' && keptCopies.size
                        ? Promise.resolve({
                              getFileHandle: (chainId: string) => {
                                  const blob = keptCopies.get(chainId)
                                  return blob
                                      ? Promise.resolve({ getFile: () => Promise.resolve(blob) })
                                      : Promise.reject(
                                            new DOMException('Not found', 'NotFoundError'),
                                        )
                              },
                          })
                        : Promise.reject(new DOMException('Not found', 'NotFoundError')),
            }),
    },
})

// A flow that throws is caught by the Save's `exclusive`, which logs it: the world keeps those.
let current: { errors: unknown[] } | undefined
const realError = console.error.bind(console)
const realWarn = console.warn.bind(console)
console.error = (...args: unknown[]) => {
    if (args[0] === 'A Save failed' || args[0] === 'The import stopped')
        current?.errors.push(args[1])
    else realError(...args)
}
console.warn = (...args: unknown[]) => {
    if (args[0] !== 'A Save failed') realWarn(...args)
}

/** The fake storage worker and its records. */
const createWorld = async (setup: Setup = {}) => {
    const s = {
        platform: setup.platform ?? 'picker',
        own: setup.own ?? 'bound',
        storage: setup.storage ?? 'lacks',
        ownDisk: setup.ownDisk ?? 'base',
        held: setup.held ?? true,
        read: setup.read ?? 'granted',
        other: setup.other ?? true,
        target: setup.target ?? true,
        opened: setup.opened,
        damaged: setup.damaged ?? false,
        kept: setup.kept,
    }
    localStorage.clear()
    env.forgetHandle('chain-own')
    window.nseSaveTest = undefined
    activation.active = true
    flow.endExportRead()
    flow.exportFlowRunning(false)
    clearExportMemory()

    const manager = new FakeLockManager()
    const ours = manager.scheduler.main
    const mock: MockPlatform = createMockPlatform({
        locks: manager.client(ours),
        ...(s.platform === 'download' ? { capabilities: { writeBack: false } } : {}),
    })
    setPlatformForTests(mock)

    /** Knobs a fault turns: the own handle's read delay and the answer to a write permission. */
    const tune = {
        readDelayMs: 0,
        readWaitsForDialog: false,
        buildMs: 5,
        writePermission: 'granted' as PermissionState,
    }
    const log: string[] = []
    const dialogs: Dialog[] = []
    const writes: Write[] = []
    const openings: PickerOpening[] = []
    const reservations: ReservationLog[] = []
    const errors: unknown[] = []
    current = { errors }
    const preparing: { name: string; kind?: string; open: boolean; controller: AbortController }[] =
        []
    const pickedHandles = new Set<string>()
    const readFails = new Set<string>()

    // The lock facts: whether this session holds `nse-bind` in a mode now.
    const holds = (mode: 'exclusive' | 'shared') =>
        manager
            .snapshot()
            .held.some((l) => l.name === 'nse-bind' && l.mode === mode && l.clientId === ours.name)
    const lockHeld = () =>
        manager.snapshot().held.some((l) => l.name === 'nse-bind' && l.clientId === ours.name)

    // Every commit of a write, with the locks this session held at that moment (I2).
    const push = mock.calls.push.bind(mock.calls)
    mock.calls.push = (...items: string[]) => {
        for (const item of items)
            if (item.startsWith('write:'))
                writes.push({
                    name: item.slice(6),
                    exclusive: holds('exclusive'),
                    shared: holds('shared'),
                    picked: pickedHandles.has(item.slice(6)),
                })
        return push(...items)
    }

    // Handles ----------------------------------------------------------------------------
    const handles = new Map<string, FileSystemFileHandle>()
    const readState = new Map<string, 'granted' | 'prompt' | 'denied'>()
    const handle = (name: string) => {
        const known = handles.get(name)
        if (known) return known
        const inner = mock.createHandle(name) as FileSystemFileHandle & Record<string, unknown>
        const wrapped = Object.assign(Object.create(null), {
            kind: 'file',
            name,
            isSameEntry: (other: FileSystemHandle) => Promise.resolve(other.name === name),
            queryPermission: ({ mode }: { mode?: string } = {}) =>
                Promise.resolve(
                    mode === 'read' && (readState.get(name) ?? 'granted') !== 'granted'
                        ? 'prompt'
                        : 'granted',
                ),
            requestPermission: (options: { mode?: string } = {}) => {
                if (options.mode === 'read') {
                    log.push(`requestRead:${name}`)
                    return Promise.resolve(readState.get(name) === 'denied' ? 'denied' : 'granted')
                }
                if (tune.writePermission !== 'granted') {
                    mock.calls.push(`requestPermission:${name}`)
                    return Promise.resolve(tune.writePermission)
                }
                return (inner.requestPermission as (o: unknown) => Promise<PermissionState>)(
                    options,
                )
            },
            getFile: async () => {
                log.push(`getFile:${name}`)
                if (tune.readDelayMs && name === OWN)
                    await new Promise((resolve) => setTimeout(resolve, tune.readDelayMs))
                if (tune.readWaitsForDialog && name === OWN)
                    await world.until(() => preparing.some((p) => p.open), 'Preparing…', 8000)
                if (readFails.has(name)) throw new DOMException('Not readable', 'NotReadableError')
                return inner.getFile()
            },
            createWritable: (options?: unknown) =>
                (inner.createWritable as (o?: unknown) => Promise<FileSystemWritableFileStream>)(
                    options,
                ),
        }) as FileSystemFileHandle
        handles.set(name, wrapped)
        return wrapped
    }

    // The picker: a target shifted off `saveTargets` is an opening. The mock empties the pick itself (D5).
    const targets = mock.saveTargets
    const shift = targets.shift.bind(targets)
    targets.shift = () => {
        const next = shift()
        const name = next && next !== 'cancel' && next !== 'download' ? targetName(next) : '?'
        openings.push({
            name,
            activation: activation.active,
            importing: isImporting(ownSession.id),
            importPending: pendingImports.has(ownSession.id),
            dialogOpen: preparing.some((p) => p.open),
        })
        if (next && next !== 'cancel' && next !== 'download') {
            before.set(name, mock.files.get(name))
            pickedHandles.add(name)
        }
        return next
    }
    const targetName = (target: { kind: string; handle?: FileSystemFileHandle }) =>
        target.handle?.name ?? '?'
    const before = new Map<string, Blob | undefined>()

    // Files ------------------------------------------------------------------------------
    const files: Record<string, Uint8Array> = {}
    const put = async (name: string, blob: Blob) => {
        mock.writeFile(name, blob)
        files[name] = (await bytesOf(blob))!
    }

    // Records ----------------------------------------------------------------------------
    const ownSession: FlushSession = {
        id: 'session-own',
        chainId: 'chain-own',
        docId: 'doc-own',
        lineageId: 'lineage-own',
        origin: 'new',
        startedAt: NOW,
        stored: true,
        nextSeq: 10,
        pending: [],
        memoryOnly: [],
        ready: Promise.resolve(),
        stack: undefined as never,
        ackedSeq: 9,
        edited: true,
    } as unknown as FlushSession
    const chains = new Map<string, Row>()
    const handleRows = new Map<string, FileSystemFileHandle>()
    const pendingImports = new Set<string>()
    const counts = new Map<string, number>()
    const hooks = new Map<string, ((n: number, arg: unknown) => void | Promise<void>)[]>()
    /** Runs the actions registered for a point of the world (worker calls, dialogs). */
    const fire = async (point: string, arg?: unknown) => {
        const n = (counts.get(point) ?? 0) + 1
        counts.set(point, n)
        for (const hook of hooks.get(point) ?? []) await hook(n, arg)
    }
    const on = (point: string, hook: (n: number, arg: unknown) => void | Promise<void>) => {
        hooks.set(point, [...(hooks.get(point) ?? []), hook])
    }

    /** How a worker method behaves, by call number; undefined runs the fake. */
    const behaviour = new Map<
        string,
        (n: number, arg: unknown) => 'throw' | { refuse: string; limit?: unknown } | undefined
    >()
    let buildCount = 0
    const builtLog: { target: string; sources: number; bytes: Uint8Array }[] = []

    const worker = {
        call: async (method: string, arg?: unknown) => {
            await fire(`worker:${method}`, arg)
            const n = counts.get(`worker:${method}`) ?? 0
            const how = behaviour.get(method)?.(n, arg)
            if (how === 'throw') throw new Error(`The storage worker restarted (${method} #${n})`)
            const result = await fake(method, arg, how)
            await fire(`worker:${method}:after`, result)
            return result
        },
    }

    // The worker methods that stay fakes of our own code (E-1): the real build, import and session
    // reads need a stored session and its snapshot rows, which the matrix's session fake does not
    // have (E3 moves them to the real flusher). The record and handle methods run the real
    // handlers behind `useRealDoor` (./door), so no case below touches a chain or a handle row.
    const fake = async (method: string, arg: unknown, how: unknown): Promise<unknown> => {
        const a = arg as Row
        switch (method) {
            case 'openPendingImports':
                return [...pendingImports].map((sessionId) => ({ sessionId }))
            case 'saveNeeds':
                return s.storage === 'holds'
                    ? { carries: true, lacking: [] }
                    : { carries: false, lacking: [] }
            case 'buildSave':
                return build(a, how)
            case 'readSessionStarts':
                return {}
            case 'mediaHeld':
                return []
            case 'estimateSaveSize':
                return undefined
            case 'readSession':
                return {
                    kind: 'open',
                    session: { chainId: 'chain-other', updatedAt: NOW },
                    chain: chains.get('chain-other') ?? {},
                }
            case 'finishOwnSave':
                return true
            case 'replaceDecision':
                return { relation: 'unrelated', holdsBase: false }
            default:
                throw new Error(`The harness does not fake ${method}`)
        }
    }

    const build = async (a: Row, how: unknown) => {
        buildCount++
        // The worker's round trip: no build is instant.
        await new Promise((resolve) => setTimeout(resolve, tune.buildMs))
        const target = a.target as Row
        const options = a.options as Row
        const sources = (a.sources as { token: string; file: Blob }[] | undefined) ?? []
        // A pending import that never started: the build refuses it as importing (SF2-6).
        if (pendingImports.has(ownSession.id) && options.sessionId === ownSession.id)
            return { refused: 'importing' }
        if (how && typeof how === 'object' && 'refuse' in how)
            return { refused: how.refuse, ...('limit' in how ? { limit: how.limit } : {}) }
        const revision = `rev-${buildCount}`
        let blob = await nxsp(revision, `built ${buildCount} ${String(target.kind)}`)
        const append =
            target.kind === 'append' ? sources.find((x) => x.token === target.source) : undefined
        if (append) blob = new Blob([append.file, blob])
        const bytes = (await bytesOf(blob))!
        builtLog.push({ target: String(target.kind), sources: sources.length, bytes })
        const record = chains.get(ownSession.chainId)
        const parent = (record?.revision as Row | undefined)?.id
        const snapshot = rootOf(liveState.value)
        return {
            blob,
            plan: {} as never,
            revisionId: revision,
            project: {},
            storageChunks: [],
            someStepsNotKept: false,
            without: [],
            tooLarge: [],
            identity: {
                docId:
                    target.kind === 'new'
                        ? String(target.docId)
                        : String(record?.docId ?? 'doc-own'),
                revision: {
                    id: revision,
                    n: 2,
                    ancestors: target.kind === 'append' && parent ? [String(parent)] : [],
                },
                marks: [],
                ...(options.history ? { entry: { count: 1, notKept: 0 } } : {}),
            },
            saveEntry: {
                kind: 'save',
                snapshot,
                noteCount: 0,
                operation: { id: 'nse.file.save', data: {} },
            },
            damaged: s.damaged ? ['hash-damaged'] : [],
            marked: 0,
            markStored: true,
        }
    }

    // The flusher: reservations as the real one hands and ends them -----------------------
    let clock = NOW
    const flusher = {
        session: ownSession,
        current: ownSession,
        sessions: [ownSession],
        hasPending: false,
        now: () => (clock += 10),
        reserveSave(): SaveReservation | undefined {
            const session = ownSession as FlushSession & { reserved?: number }
            if (session.reserved !== undefined) return
            const seq = session.nextSeq++
            session.reserved = seq
            const reservation = { session, seq, wall: flusher.now() }
            reservations.push({ reservation, ends: [] })
            return reservation
        },
        endSave(
            reservation: SaveReservation,
            entry?: Row,
            identity?: Row,
            keep = false,
        ): Promise<void> {
            const record = reservations.find((r) => r.reservation === reservation)
            record?.ends.push({ kept: keep, entry: !!entry })
            const session = reservation.session as FlushSession & {
                reserved?: number
                gaps?: Set<number>
            }
            if (session.reserved === reservation.seq) session.reserved = undefined
            if (entry) {
                if (identity) {
                    ;(session as { identity?: unknown }).identity = {
                        ...identity,
                        seq: reservation.seq,
                    }
                    const file = { ...(identity.file as Row) }
                    const picked = file.handle as FileSystemFileHandle | undefined
                    delete file.handle
                    const chain = chains.get(session.chainId) ?? {}
                    chains.set(session.chainId, {
                        ...chain,
                        docId: identity.docId,
                        revision: identity.revision,
                        file,
                    })
                    if (picked) handleRows.set(`${session.chainId}:file`, picked)
                }
            } else if (keep) (session.gaps ??= new Set()).add(reservation.seq)
            else if (session.nextSeq - 1 === reservation.seq) session.nextSeq--
            return Promise.resolve()
        },
        flush: () => Promise.resolve(),
        unstored: () => ({ entries: [], stack: undefined }),
        keptSaveBelow: () => ({ kind: 'stored' as const }),
        keptSave: () => Promise.resolve(),
        setChainFields: () => Promise.resolve(),
        setChainFieldsNow: () => Promise.resolve(true),
    }

    // The dialogs: what a user would answer, queued by the scenario ----------------------
    const answers = {
        saveDialog: [] as (Row | undefined)[],
        refused: [] as ('chooseAnother' | 'export' | undefined)[],
        conflict: [] as ('separate' | 'openOther' | 'replace' | undefined)[],
        notPutBack: [] as ('download' | undefined)[],
        notFound: [] as ('saveAs' | undefined)[],
        denied: [] as ('saveAs' | 'tryAgain' | undefined)[],
        failed: [] as ('saveAs' | undefined)[],
    }
    const shown = <T>(kind: string, args: unknown[], queue: T[], fallback: T) => {
        dialogs.push({ kind, args, lockHeld: lockHeld() })
        log.push(`dialog:${kind}`)
        // A person takes a moment to answer: reads started with the dialog settle meanwhile.
        return new Promise<T>((resolve) =>
            setTimeout(() => resolve(queue.length ? queue.shift()! : fallback), userMs),
        )
    }
    let userMs = 30
    let readyAutomatic = true
    const pendingReady: ((go: boolean) => void)[] = []
    /** The press a lapsed activation needs: a new tap, or Cancel. */
    const askReady = (action: string) => {
        log.push(`ready:${action}`)
        return new Promise<boolean>((resolve) => {
            const answer = (go: boolean) => {
                if (go) activation.active = true
                resolve(go)
            }
            pendingReady.push(answer)
            void fire('ui:ready', action)
            if (readyAutomatic) setTimeout(() => answer(true), 0)
        })
    }
    const exportAnswers = {
        notLevelData: [] as ('chooseAnother' | undefined)[],
        unsupportedParts: [] as ('chooseAnother' | undefined)[],
        conflict: [] as ('replace' | 'chooseAnother' | undefined)[],
        notFound: [] as ('chooseAnother' | undefined)[],
        denied: [] as ('tryAgain' | 'chooseAnother' | undefined)[],
        failed: [] as ('chooseAnother' | undefined)[],
        notPutBack: [] as ('download' | undefined)[],
    }
    const exportUi = {
        conflict: (name: string) =>
            shown('export.conflict', [name], exportAnswers.conflict, undefined),
        notLevelData: (name: string) =>
            shown('export.notLevelData', [name], exportAnswers.notLevelData, undefined),
        unsupportedParts: (name: string) =>
            shown('export.unsupportedParts', [name], exportAnswers.unsupportedParts, undefined),
        notPutBack: (name: string, emptied: boolean) =>
            shown('notPutBack', [name, emptied], exportAnswers.notPutBack, 'download' as const),
        notFound: (name: string) =>
            shown('export.notFound', [name], exportAnswers.notFound, undefined),
        denied: (name: string) => shown('export.denied', [name], exportAnswers.denied, undefined),
        failed: (name: string) => shown('export.failed', [name], exportAnswers.failed, undefined),
        exported: (name: string) => {
            log.push(`exported:${name}`)
        },
        downloadStarted: (name: string) => {
            log.push(`exportDownload:${name}`)
        },
        markExported: () => undefined,
    }
    setSaveUiForTests({
        saveDialog: async (input) => {
            await fire('ui:saveDialog', input)
            return shown('saveDialog', [input.kind], answers.saveDialog, undefined) as never
        },
        preparing: (name, kind) => {
            const controller = new AbortController()
            const entry = { name, ...(kind ? { kind } : {}), open: true, controller }
            preparing.push(entry)
            log.push(`preparing:${name}`)
            return {
                signal: controller.signal,
                importing: () => undefined,
                built: () => undefined,
                ready: (action) => {
                    if (controller.signal.aborted || !entry.open) return Promise.resolve(false)
                    return askReady(action)
                },
                close: () => {
                    entry.open = false
                },
            }
        },
        conflict: (input) => shown('conflict', [input.name], answers.conflict, undefined),
        notFound: (name) => shown('notFound', [name], answers.notFound, undefined),
        denied: (name) => shown('denied', [name], answers.denied, undefined),
        readOnly: (name) => shown('readOnly', [name], [], undefined),
        failed: (name) => shown('failed', [name], answers.failed, undefined),
        refused: (name, reason) => shown('refused', [name, reason], answers.refused, undefined),
        notPutBack: (name, emptied) =>
            shown('notPutBack', [name, emptied], answers.notPutBack, 'download'),
        saved: (feedback) => {
            dialogs.push({ kind: 'saved', args: [feedback.name], lockHeld: lockHeld() })
            log.push(`saved:${feedback.name}`)
        },
        noChanges: (name) => {
            dialogs.push({ kind: 'noChanges', args: [name], lockHeld: lockHeld() })
        },
        error: (message) => {
            dialogs.push({ kind: 'error', args: [message()], lockHeld: lockHeld() })
            log.push('error')
        },
    })

    // Wiring -----------------------------------------------------------------------------
    setStorageWorkerForMatrix(worker)
    setFlusherForMatrix(flusher, { rewrite: () => undefined })
    setExportPersister(() => Promise.resolve(true))
    setExportTargetReader(() => Promise.resolve({}))
    exportPick.setProjectPickCheck((picked) => flow.projectPick(picked))
    exportPick.setPickLock((run) => env.withBind('exclusive', run))
    exportPick.setTargetLock((run) => env.withBind('shared', run))
    const later = (run: () => void) => void Promise.resolve().then(run)
    exportPick.setExportReads({
        start: () => later(() => flow.startExportRead()),
        end: () => later(() => flow.endExportRead()),
        picker: () => later(() => flow.exportPickerOpening()),
        flow: (running) => later(() => flow.exportFlowRunning(running)),
        importWait: (name, size) => flow.exportImportWait(name, size),
    })
    currentSession.value = {
        ...createSessionDescriptor(),
        sessionId: ownSession.id,
        docId: ownSession.docId,
    }
    markFirstSaveDone()
    resetStates({ isDirty: true, step: initialStep(), state: chartState([[]]) })

    // Initial files and records.
    const ownBlob = await nxsp('rev-own', 'own file as last saved')
    const ownAhead = await nxsp('rev-own-2', 'own file with more than storage holds')
    const otherBlob = await nxsp('rev-other', 'another chain’s file')
    const targetBlob = levelData('another chain’s export')
    if (s.own !== 'unbound') {
        await put(OWN, ownBlob)
        const disk = await nxspDiskState(await handle(OWN).getFile(), 0)
        // The binding's disk is the file as saved; `ahead` changes the file after it.
        if (s.ownDisk === 'ahead') await put(OWN, ownAhead)
        else mock.files.set(OWN, ownBlob)
        chains.set(ownSession.chainId, {
            chainId: ownSession.chainId,
            docId: 'doc-own',
            head: ownSession.id,
            revision: { id: 'rev-own', n: 1, ancestors: [] },
            file: {
                name: OWN,
                event: 'saved',
                at: 1000,
                hash: new Uint8Array(16).fill(7),
                disk,
                entry: {
                    sessionId: 'session-old',
                    seq: 3,
                    startedAt: NOW - 1000,
                    count: 4,
                    notKept: 0,
                },
                options: { history: true, bgm: true },
            },
        })
        handleRows.set(`${ownSession.chainId}:file`, handle(OWN))
        if (s.held) env.rememberHandle(ownSession.chainId, handle(OWN))
        readState.set(OWN, s.read)
        if (s.own === 'missing') mock.files.delete(OWN)
    } else {
        chains.set(ownSession.chainId, {
            chainId: ownSession.chainId,
            docId: 'doc-own',
            head: ownSession.id,
        })
    }
    ;(ownSession as { identity?: unknown }).identity = undefined
    if (s.other) {
        await put('other.nxsp', otherBlob)
        const disk = await nxspDiskState(await handle('other.nxsp').getFile(), 0)
        chains.set('chain-other', {
            chainId: 'chain-other',
            docId: 'doc-other',
            file: {
                name: 'other.nxsp',
                event: 'saved',
                at: 2000,
                hash: new Uint8Array(16).fill(9),
                disk,
                options: { history: true, bgm: true },
            },
        })
        handleRows.set('chain-other:file', handle('other.nxsp'))
    }
    if (s.target) {
        await put('target.nsld', targetBlob)
        chains.set('chain-target', {
            chainId: 'chain-target',
            docId: 'doc-target',
            exportTarget: {
                name: 'target.nsld',
                disk: { fingerprint: 'x', size: 1, lastModified: 0 },
            },
        })
        handleRows.set('chain-target:exportTarget', handle('target.nsld'))
    }
    await put('unknown.nxsp', await nxsp('rev-unknown', 'a file nobody knows'))
    await put('fresh.nxsp', new Blob([])) // a new file the picker creates
    // Kept rows the door stores with `keepHandle` (D26): the file a partial open came from.
    const kept: { chainId: string; name: string; handle: FileSystemFileHandle }[] = []
    keptCopies.clear()
    if (s.kept === 'afterReload') {
        const openedBlob = levelData('opened level')
        await put('opened.nsld', openedBlob)
        kept.push({
            chainId: ownSession.chainId,
            name: 'opened.nsld',
            handle: handle('opened.nsld'),
        })
        // A browser API: the OPFS folder the open copied its bytes into (src/local/open/kept.ts).
        keptCopies.set(ownSession.chainId, openedBlob)
    }
    if (s.opened && !s.kept) {
        const openedBlob =
            s.opened === 'notProject' ? new Blob(['a chart file']) : levelData('opened level')
        await put('opened.nsld', openedBlob)
        exportMemory.opened = {
            handle: handle('opened.nsld'),
            levelData: s.opened !== 'notProject',
            partial: s.opened === 'partial',
            // Export refuses (and puts back) only what it may not write over.
            ...(s.opened === 'levelData' ? {} : { bytes: await openedBlob.arrayBuffer() }),
            kept: await openedBlob.arrayBuffer(),
        } as never
    }

    // Reads the own file's bytes the way a user would see them now.
    const fileBytes = async (name: string) => bytesOf(mock.files.get(name))

    const world = {
        setup: s,
        /** The door's page, flusher and core (set below). */
        door: undefined as unknown as Awaited<ReturnType<typeof useRealDoor>>,
        tune,
        exportAnswers,
        exportUi,
        exportBuild: () => {
            world.exportBuildHook?.()
            return levelData('exported')
        },
        exportReady: () => askReady('save'),
        exportBuildHook: undefined as (() => void) | undefined,
        exportAbort: undefined as AbortController | undefined,
        cancelled: false,
        committed: false,
        committedWrite: () => writes.length > 0,
        mock,
        manager,
        ours,
        flusher,
        worker,
        session: ownSession,
        chains,
        handleRows,
        handles,
        handle,
        files,
        before,
        log,
        dialogs,
        writes,
        openings,
        reservations,
        errors,
        preparing,
        pickedHandles,
        readFails,
        pendingImports,
        builtLog,
        answers,
        behaviour,
        hooks,
        on,
        fire,
        put,
        fileBytes,
        holds,
        lockHeld,
        /** The next picker returns this file, or is dismissed. */
        pick: (...names: (string | 'cancel')[]) => {
            for (const name of names)
                mock.saveTargets.push(
                    name === 'cancel'
                        ? 'cancel'
                        : ({ kind: 'handle', handle: handle(name) } as FileTarget),
                )
        },
        /** Presses Cancel in the open "Preparing…" dialog, if one is open. */
        cancel: () => {
            const open = preparing.filter((p) => p.open).at(-1)
            if (!open) return false
            open.controller.abort()
            for (const answer of pendingReady.splice(0)) answer(false)
            return true
        },
        userDelay: (ms: number) => {
            userMs = ms
        },
        readyByHand: () => {
            readyAutomatic = false
        },
        press: () => {
            for (const answer of pendingReady.splice(0)) answer(true)
        },
        /** Another tab's lock on `nse-bind`, held until released. */
        otherTab: (mode: 'exclusive' | 'shared', name = 'tabB') => {
            const client = manager.client(manager.scheduler.actor(name))
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            let granted!: () => void
            const got = new Promise<void>((resolve) => {
                granted = resolve
            })
            const done = client.request('nse-bind', { mode }, async () => {
                granted()
                await gate
            })
            return { release, got, done }
        },
        /** Resolves once a condition holds, checked each turn. */
        until: async (condition: () => boolean, label = 'a condition', ms = 4000) => {
            const start = Date.now()
            while (!condition()) {
                if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`)
                await new Promise((resolve) => setTimeout(resolve, 1))
            }
        },
        /** Runs `action` once the named save point is reached, then lets the Save go on. */
        atPoint: (name: string, action: () => void | Promise<void>) => {
            localStorage.setItem('nse.test.savePause', name)
            const watch = (async () => {
                await world
                    .until(
                        () => (window.nseSaveTest?.reached ?? []).includes(name),
                        `save point ${name}`,
                        8000,
                    )
                    .catch(() => undefined)
                if (!(window.nseSaveTest?.reached ?? []).includes(name)) return
                try {
                    await action()
                } finally {
                    localStorage.removeItem('nse.test.savePause')
                    window.nseSaveTest?.release()
                }
            })()
            return watch
        },
        reached: () => [...(window.nseSaveTest?.reached ?? [])],
        /** An import of this session that runs until `finish` (real `startImport`). */
        startImport: (outcome: 'done' | 'damaged' = 'done') => {
            let finish!: () => void
            const gate = new Promise<void>((resolve) => {
                finish = resolve
            })
            const importWorker = {
                call: async (method: string) => {
                    if (method === 'openBatch') {
                        await gate
                        return outcome === 'done'
                            ? { kind: 'done' }
                            : { kind: 'damaged', hashes: ['h'] }
                    }
                    return undefined
                },
            }
            pendingImports.add(ownSession.id)
            const run = startImport({
                worker: importWorker as never,
                sessionId: ownSession.id,
                chainId: ownSession.chainId,
                id: 'import-1',
                batches: 1,
                source: { file: new Blob([]) } as never,
                locks: mock.locks,
                appVersion: '0.6.0',
            } as never)
            void run.then(() => pendingImports.delete(ownSession.id))
            return { finish, run }
        },
        /** The revocations storage could not take, kept in localStorage (R11). */
        revocations: () => env.pendingRevocations(),
        /** The own binding's name as the record holds it, or undefined. */
        boundName: () => (chains.get(ownSession.chainId)?.file as Row | undefined)?.name,
        setup0: s,
    }
    // The real storage handlers under the record and handle methods; the maps above are the view.
    world.door = await useRealDoor(world, kept)
    ownSession.chain = chains.get(ownSession.chainId)
    return world
}

export type World = Awaited<ReturnType<typeof createWorld>>
export { createWorld }

/** Settles fire-and-forget work a flow leaves behind (refreshes, broadcasts, lock releases). */
export const settle = async (ms = 20) => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, ms / 5))
}
