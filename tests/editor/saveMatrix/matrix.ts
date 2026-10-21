import { check, type Facts, type Violation } from './invariants'
import {
    activation,
    bytesOf,
    createWorld,
    exportPick,
    flow,
    settle,
    type Setup,
    type World,
} from './world'

const { exportByPicker } = await import('../../../src/editor/commands/exportLevel/flow')
const { FileError } = await import('../../../src/platform')

// The fault matrix (B0): every picker path, every pick it can meet, every exit point, each cell
// run against the real flows over the fake storage in ./world, then checked against the invariants.

/**
 * `opened`, `chart` and `partial` are the file the session was opened from: level data, a chart
 * that is not level data, and level data with parts left out (the Save core refuses all three).
 */
export type PickName =
    'own' | 'other' | 'unknown' | 'fresh' | 'target' | 'opened' | 'chart' | 'partial' | 'dismiss'

export const FILES: Record<PickName, string> = {
    own: 'own.nxsp',
    other: 'other.nxsp',
    unknown: 'unknown.nxsp',
    fresh: 'fresh.nxsp',
    target: 'target.nsld',
    opened: 'opened.nsld',
    chart: 'opened.nsld',
    partial: 'opened.nsld',
    dismiss: 'cancel',
}

/** What the pickers return in turn: `a>b` is a refused pick `a`, Choose Another…, then `b`. */
export type PickPlan = { id: string; picks: PickName[] }

const plan = (id: string): PickPlan => ({ id, picks: id.split('>') as PickName[] })

const dialogResult = (fileName = 'out.nxsp') => ({
    action: 'save' as const,
    fileName,
    history: true,
    bgm: true,
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The user types a name while Export's read first runs: wait until the door has no call in flight
 * over two timer turns (the gaps between a read's calls are microtasks and one setImmediate), not
 * for a time. A `read-slow` cell keeps its read unsettled, as the R2-slow todo needs.
 */
const typeName = async (w: World) => {
    exportPick.exportDialogOpened()
    if (w.tune.readDelayMs) return sleep(20)
    for (let quiet = 0; quiet < 2;) {
        await sleep(2)
        quiet = w.doorBusy === 0 ? quiet + 1 : 0
    }
}

export type PathDef = {
    id: string
    family: 'save' | 'export' | 'download'
    setup: Setup
    plans: PickPlan[]
    /** Starts with a Save dialog the user answers (once per picker opened). */
    dialog: boolean
    /** Opens a save picker. */
    picker: boolean
    /** Writes a file by the platform (a picked file or the bound one). */
    writes: boolean
    /** The lock a write holds: `exclusive` after a pick, `shared` for a write-back. */
    lock: 'exclusive' | 'shared' | 'none'
    /** Waits for an open's import before its write or picker. */
    importWait: boolean
    /** A build that can be made slow, and cancelled in "Preparing…". */
    build: boolean
    /** What the user answers before the picker: the conflict or not-found choice. */
    answer?: (w: World) => void
    /** Starts the flow; resolves when it ends. */
    run: (w: World) => Promise<unknown>
}

const savePlans = [
    'own',
    'other',
    'unknown',
    'fresh',
    'target',
    'opened',
    'chart',
    'partial',
    'dismiss',
    'opened>own',
    'opened>other',
    'opened>opened>own',
    'opened>dismiss',
].map(plan)
// Export writes over whole level data it was opened from; it refuses a chart and a partial import.
const exportPlans = [
    'own',
    'other',
    'unknown',
    'fresh',
    'target',
    'opened',
    'chart',
    'partial',
    'dismiss',
    'chart>own',
    'chart>other',
    'partial>dismiss',
    'chart>chart>own',
].map(plan)
const noOwn = savePlans.filter((p) => !p.picks.includes('own'))

// The pick plan a cell asks for is queued by `prepare`: pickers, Save dialog answers, refusals.
export const prepare = (w: World, path: PathDef, picks: PickName[]) => {
    if (path.picker) for (const pick of picks) w.pick(FILES[pick])
    const refusals = picks.slice(0, -1).length
    for (let i = 0; i < refusals; i++) {
        w.answers.refused.push('chooseAnother')
        w.exportAnswers.notLevelData.push('chooseAnother')
        w.exportAnswers.unsupportedParts.push('chooseAnother')
    }
    if (path.dialog)
        for (let i = 0; i < picks.length; i++) w.answers.saveDialog.push(dialogResult())
    path.answer?.(w)
}

const exportContext = (w: World) => {
    const controller = new AbortController()
    w.exportAbort = controller
    return {
        ui: w.exportUi,
        build: () => w.exportBuild(),
        suggestedName: 'LevelData.nsld',
        types: [],
        leave: () => undefined,
        ready: () => w.exportReady(),
        signal: controller.signal,
        committed: () => {
            w.committed = true
        },
    }
}

export const PATHS: PathDef[] = [
    {
        id: 'save-first',
        family: 'save',
        setup: { own: 'unbound' },
        plans: noOwn,
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: () => flow.save(),
    },
    {
        id: 'save-as',
        family: 'save',
        setup: { own: 'bound', storage: 'lacks' },
        plans: savePlans,
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: () => flow.saveAs(),
    },
    {
        id: 'save-as/reloaded',
        family: 'save',
        setup: { own: 'bound', storage: 'lacks', held: false },
        plans: ['own', 'other', 'partial', 'opened>own', 'dismiss'].map(plan),
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: () => flow.saveAs(),
    },
    {
        id: 'save-as/stored',
        family: 'save',
        setup: { own: 'bound', storage: 'holds' },
        plans: ['own', 'other', 'unknown', 'dismiss'].map(plan),
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: () => flow.saveAs(),
    },
    {
        id: 'save-as/ahead',
        family: 'save',
        // The own file changed on disk since the binding: a pick of it goes back, then conflicts.
        setup: { own: 'bound', storage: 'lacks', ownDisk: 'ahead' },
        plans: ['own', 'other', 'opened>own', 'dismiss'].map(plan),
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: () => flow.saveAs(),
    },
    {
        id: 'separate',
        family: 'save',
        setup: { own: 'bound', storage: 'lacks', ownDisk: 'ahead' },
        plans: savePlans,
        // The conflict dialog's choice, not a Save dialog, starts it.
        dialog: false,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        answer: (w) => {
            w.answers.conflict.push('separate')
        },
        run: () => flow.save(),
    },
    {
        id: 'notfound-saveas',
        family: 'save',
        setup: { own: 'missing', storage: 'lacks' },
        plans: ['own', 'other', 'unknown', 'fresh', 'dismiss', 'opened>fresh'].map(plan),
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        answer: (w) => {
            w.answers.notFound.push('saveAs')
        },
        run: () => flow.save(),
    },
    {
        id: 'save-to-file',
        family: 'save',
        setup: { own: 'bound', storage: 'lacks' },
        plans: savePlans,
        dialog: true,
        picker: true,
        writes: true,
        lock: 'exclusive',
        // AR-6: Save to File… has no import wait before its picker.
        importWait: false,
        build: true,
        run: () => flow.saveToFile('session-other'),
    },
    {
        id: 'write-back',
        family: 'save',
        setup: { own: 'bound', storage: 'lacks' },
        plans: [plan('own')],
        dialog: false,
        picker: false,
        writes: true,
        lock: 'shared',
        importWait: true,
        build: true,
        run: () => flow.save(),
    },
    {
        id: 'download',
        family: 'download',
        setup: { platform: 'download', own: 'unbound' },
        plans: [plan('dismiss')],
        dialog: true,
        picker: false,
        writes: false,
        lock: 'none',
        importWait: true,
        build: true,
        run: () => flow.save(),
    },
    {
        id: 'download-again',
        family: 'download',
        setup: { platform: 'download', own: 'bound' },
        plans: [plan('dismiss')],
        dialog: false,
        picker: false,
        writes: false,
        lock: 'none',
        importWait: false,
        build: true,
        run: () => flow.fileDownloadAgain(),
    },
    {
        id: 'export',
        family: 'export',
        setup: { own: 'bound', storage: 'lacks' },
        plans: exportPlans,
        dialog: false,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: async (w) => {
            await typeName(w)
            exportPick.exportFlowRunning(true)
            try {
                return await exportByPicker(exportContext(w))
            } finally {
                exportPick.exportDialogClosed()
                exportPick.exportFlowRunning(false)
            }
        },
    },
    {
        id: 'export/reloaded',
        family: 'export',
        setup: { own: 'bound', storage: 'lacks', held: false },
        plans: ['own', 'other', 'partial', 'chart>own', 'dismiss'].map(plan),
        dialog: false,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: async (w) => {
            await typeName(w)
            exportPick.exportFlowRunning(true)
            try {
                return await exportByPicker(exportContext(w))
            } finally {
                exportPick.exportDialogClosed()
                exportPick.exportFlowRunning(false)
            }
        },
    },
    {
        id: 'export/ahead',
        family: 'export',
        setup: { own: 'bound', storage: 'lacks', ownDisk: 'ahead' },
        plans: ['own', 'chart>own', 'dismiss'].map(plan),
        dialog: false,
        picker: true,
        writes: true,
        lock: 'exclusive',
        importWait: true,
        build: true,
        run: async (w) => {
            await typeName(w)
            exportPick.exportFlowRunning(true)
            try {
                return await exportByPicker(exportContext(w))
            } finally {
                exportPick.exportDialogClosed()
                exportPick.exportFlowRunning(false)
            }
        },
    },
]

// ----------------------------------------------------------------------------------------
// Faults: the exit points.

export type Armed = {
    /** Background work the cell joins before it ends. */
    driver?: Promise<unknown>
    facts?: Partial<Facts>
    /** Whether the fault was met in this cell (a statistic: some cells exit before it). */
    observed?: () => boolean
    /** Undoes what the fault set up outside the world, before the invariants are checked. */
    cleanup?: () => void
    /** The fault must have taken effect, else the cell proved nothing (a harness fault). */
    effective?: () => boolean
}

export type FaultDef = {
    id: string
    /** The exit point as the review names it. */
    exit: string
    applies: (path: PathDef, plan: PickPlan) => boolean
    setup?: Partial<Setup>
    arm: (w: World, path: PathDef, plan: PickPlan) => Armed | void
}

const last = (plan: PickPlan) => plan.picks.at(-1)!
const single = (plan: PickPlan) => plan.picks.length === 1
const writesFile = (plan: PickPlan) => ['own', 'other', 'unknown', 'fresh'].includes(last(plan))
const pickerPath = (path: PathDef) => path.picker
/** A picker that reads the chain's own file first (R2): Save to File… reads nothing (R5). */
const readsFirst = (path: PathDef) =>
    path.picker && path.setup.own === 'bound' && path.id !== 'save-to-file'
/** A picker whose pick is built again afterwards: Save to File… builds once. */
const rebuilds = (path: PathDef) =>
    pickerPath(path) && path.family === 'save' && path.id !== 'save-to-file'
const anyPick = (path: PathDef) => path.picker

const refuse = (w: World, n: (call: number) => boolean, refused: string) =>
    w.behaviour.set('buildSave', (call) => (n(call) ? { refuse: refused } : undefined))
const throwOn = (w: World, n: (call: number) => boolean) =>
    w.behaviour.set('buildSave', (call) => (n(call) ? 'throw' : undefined))

/** Waits for our lock request to queue, then runs `during`, then lets the other tab go. */
const holdThen = (
    w: World,
    mode: 'exclusive' | 'shared',
    during: () => void | Promise<void>,
): Armed => {
    const holder = w.otherTab(mode)
    let contended = false
    const driver = (async () => {
        await holder.got
        await w
            .until(
                () => w.manager.snapshot().pending.some((p) => p.clientId === w.ours.name),
                'our lock request',
                6000,
            )
            .then(() => {
                contended = true
            })
            .catch(() => undefined)
        await during()
        holder.release()
        await holder.done
    })()
    return { driver, effective: () => contended }
}

/** Waits for a "Preparing…" dialog to be open, which a slow step opens on a one-second timer. */
const dialogOpen = (w: World) =>
    w
        .until(() => w.preparing.some((entry) => entry.open), 'Preparing…', 8000)
        .catch(() => undefined)

/** A fault at a point of the platform's write: once, or on every write (the put-back too). */
const failWrite = (
    w: World,
    at: 'checked' | 'built' | 'beforeClose' | 'closed',
    error: () => Error,
    sticky: boolean,
): Armed => {
    let fired = false
    w.mock.fault = (point) => {
        if (point !== at || (fired && !sticky)) return
        fired = true
        throw error()
    }
    return { observed: () => fired }
}

/** The name the last picker opening returned. */
const pickedName = (w: World) => w.openings.at(-1)?.name

export const FAULTS: FaultDef[] = [
    {
        id: 'none',
        exit: 'no fault',
        applies: () => true,
        arm: () => undefined,
    },
    {
        id: 'dialog-cancelled',
        exit: 'Save dialog cancelled',
        applies: (path, p) => path.dialog && single(p) && last(p) === 'dismiss',
        arm: (w) => {
            w.answers.saveDialog.length = 0
            w.answers.saveDialog.push(undefined)
            return { facts: { cancelled: true } }
        },
    },
    {
        id: 'identify-fails',
        exit: 'identify fails (storage unavailable)',
        applies: (path, p) => anyPick(path) && single(p) && last(p) !== 'dismiss',
        arm: (w) => {
            w.behaviour.set('listHandleOwners', () => 'throw')
        },
    },
    {
        id: 'read-denied',
        exit: 'read first: access denied',
        applies: (path, p) => readsFirst(path) && single(p) && last(p) === 'own',
        setup: { read: 'denied' },
        arm: (_w, _path) => ({ facts: { inHand: () => false } }),
    },
    {
        id: 'read-fails',
        exit: 'read first: the read fails',
        applies: (path, p) => readsFirst(path) && single(p) && last(p) === 'own',
        arm: (w) => {
            w.readFails.add('own.nxsp')
            return { facts: { inHand: () => false } }
        },
    },
    {
        id: 'read-slow',
        exit: 'read first: not settled when the picker opens',
        applies: (path, p) =>
            readsFirst(path) &&
            ((single(p) && last(p) === 'own') ||
                // A picker with no dialog before it: Choose Another… after a refusal.
                (['separate', 'export'].includes(path.id) &&
                    p.id === (path.id === 'export' ? 'chart>own' : 'opened>own'))),
        arm: (w) => {
            w.tune.readDelayMs = 400
            w.userDelay(2)
        },
    },
    {
        id: 'read-stale',
        exit: 'read first: the file changed after the read',
        applies: (path, p) => readsFirst(path) && single(p) && last(p) === 'own',
        arm: (w, path) => {
            const write = () =>
                w.mock.writeFile('own.nxsp', new Blob(['newer bytes another program wrote']))
            // Between the read and the pick: the Save's build, or for Export the level data's.
            if (path.family === 'export') w.exportBuildHook = write
            else
                w.on('worker:buildSave:after', (n) => {
                    if (n === 1) write()
                })
        },
    },
    {
        id: 'build-refused',
        exit: 'build refused (first)',
        applies: (path, p) => path.build && single(p) && ['own', 'dismiss'].includes(last(p)),
        arm: (w) => refuse(w, (n) => n === 1, 'needsNewer'),
    },
    {
        id: 'build-refused-importing',
        exit: 'build refused as importing',
        applies: (path, p) => path.build && single(p) && last(p) === 'dismiss',
        arm: (w) => refuse(w, (n) => n === 1, 'importing'),
    },
    {
        id: 'build-fails',
        exit: 'build fails (first)',
        applies: (path, p) => path.build && single(p) && ['own', 'dismiss'].includes(last(p)),
        arm: (w) => throwOn(w, (n) => n === 1),
    },
    {
        id: 'rebuild-refused',
        exit: 'build refused after the pick',
        applies: (path, p) => rebuilds(path) && single(p) && writesFile(p),
        arm: (w) => refuse(w, (n) => n === 2, 'plan'),
    },
    {
        id: 'rebuild-damaged',
        exit: 'append refused: the source is damaged',
        applies: (path, p) => rebuilds(path) && single(p) && last(p) === 'own',
        arm: (w) => refuse(w, (n) => n === 2, 'damagedSource'),
    },
    {
        id: 'rebuild-fails',
        exit: 'build fails after the pick (and its retry)',
        applies: (path, p) => rebuilds(path) && single(p) && writesFile(p),
        arm: (w) => throwOn(w, (n) => n >= 2),
    },
    {
        id: 'rebuild-fails-once',
        exit: 'build fails once after the pick (worker restart)',
        applies: (path, p) => rebuilds(path) && single(p) && writesFile(p),
        arm: (w) => throwOn(w, (n) => n === 2),
    },
    {
        id: 'write-check-conflict',
        exit: 'write: precondition fails (check), once',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) =>
            failWrite(
                w,
                'checked',
                () => new FileError('conflict', 'changed on disk', undefined, 'check'),
                false,
            ),
    },
    {
        id: 'write-denied',
        exit: 'write: permission denied',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) => failWrite(w, 'checked', () => new FileError('denied', 'Not allowed'), true),
    },
    {
        id: 'write-io',
        exit: 'write: fails before close, once (ambiguous)',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) =>
            failWrite(w, 'beforeClose', () => new FileError('io', 'The write failed'), false),
    },
    {
        id: 'write-io-sticky',
        exit: 'write: fails before close, and the put-back too (ambiguous)',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) =>
            failWrite(w, 'beforeClose', () => new FileError('io', 'The write failed'), true),
    },
    {
        id: 'write-no-space',
        exit: 'write: no space, and the put-back too',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) => failWrite(w, 'beforeClose', () => new FileError('no-space', 'No space'), true),
    },
    {
        id: 'write-readback',
        exit: 'write: landed, read-back fails (ambiguous)',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) =>
            failWrite(
                w,
                'closed',
                () => new FileError('io', 'The read-back failed', undefined, 'readBack'),
                false,
            ),
    },
    {
        id: 'lock-held',
        exit: 'lock contention: another tab holds nse-bind exclusive',
        applies: (path, p) =>
            path.writes &&
            path.lock !== 'none' &&
            (path.picker ? single(p) && writesFile(p) : true),
        arm: (w) => holdThen(w, 'exclusive', () => undefined),
    },
    {
        id: 'lock-held-write',
        exit: 'lock contention: another tab writes the picked file meanwhile',
        applies: (path, p) => path.picker && path.writes && single(p) && writesFile(p),
        arm: (w) =>
            holdThen(w, 'exclusive', () => {
                const name = pickedName(w)
                if (name)
                    w.mock.writeFile(name, new Blob(['bytes another tab or a sync client wrote']))
            }),
    },
    {
        id: 'lock-shared-held',
        exit: 'lock contention: another tab holds nse-bind shared',
        applies: (path, p) => path.picker && path.writes && single(p) && writesFile(p),
        arm: (w) => holdThen(w, 'shared', () => undefined),
    },
    {
        id: 'reservation-held',
        exit: 'another Save holds the session’s reservation',
        applies: (path, p) =>
            ['save-as', 'export', 'write-back'].includes(path.id) &&
            single(p) &&
            ['own', 'dismiss'].includes(last(p)),
        arm: (w) => {
            const session = w.session
            session.reserved = { session, seq: 99, wall: 0 }
            return {
                cleanup: () => {
                    session.reserved = undefined
                },
            }
        },
    },
    {
        id: 'takeover-fails',
        exit: 'storage paused: the takeover cannot be kept',
        applies: (path, p) =>
            path.picker &&
            path.writes &&
            single(p) &&
            ['other', 'unknown', 'own', 'fresh'].includes(last(p)),
        arm: (w, path, p) => {
            let calls = 0
            w.on('worker:takeOver', () => {
                calls++
            })
            w.behaviour.set('takeOver', () => 'throw')
            // Which picks the path takes over: another chain's file, or an unknown one it binds.
            const takes =
                path.id === 'save-to-file'
                    ? ['own', 'other']
                    : path.family === 'export'
                      ? ['other']
                      : ['other', 'unknown', 'fresh']
            return { effective: () => calls > 0 || !takes.includes(last(p)) }
        },
    },
    {
        id: 'worker-record-fails',
        exit: 'worker restart: the chain record cannot be read',
        applies: (path, p) => (path.id === 'write-back' || path.id === 'save-as') && single(p),
        arm: (w) => {
            w.behaviour.set('readChainRecord', () => 'throw')
        },
    },
    {
        id: 'activation-lapsed-build',
        exit: 'activation lapsed during the build (pressed again)',
        applies: (path, p) =>
            path.picker && path.family === 'save' && path.build && single(p) && writesFile(p),
        arm: (w) => {
            w.on('worker:buildSave', (n) => {
                if (n === 1) activation.active = false
            })
            return { effective: () => w.log.some((line) => line.startsWith('ready:')) }
        },
    },
    {
        id: 'activation-lapsed-export-build',
        exit: 'activation lapsed during the build (pressed again)',
        applies: (path, p) => path.family === 'export' && single(p) && writesFile(p),
        arm: (w) => {
            w.exportBuildHook = () => {
                activation.active = false
            }
        },
    },
    {
        id: 'activation-lapsed-cancel',
        exit: 'activation lapsed, the press prompt cancelled',
        applies: (path, p) =>
            path.picker && path.family === 'save' && path.build && single(p) && writesFile(p),
        arm: (w) => {
            w.readyByHand()
            w.on('worker:buildSave', (n) => {
                if (n === 1) activation.active = false
            })
            w.on('ui:ready', () => {
                w.cancelled = w.cancel() || w.cancelled
            })
            return {
                effective: () => w.cancelled,
                get facts() {
                    return { cancelled: w.cancelled }
                },
            }
        },
    },
    {
        id: 'import-running',
        exit: 'import running (waited for, then picker)',
        applies: (path, p) => path.importWait && single(p) && (path.picker ? writesFile(p) : true),
        arm: (w) => {
            const imp = w.startImport()
            const driver = (async () => {
                await w
                    .until(() => w.preparing.some((entry) => entry.open), 'Preparing…', 3000)
                    .catch(() => undefined)
                await sleep(30)
                imp.finish()
                await imp.run
            })()
            return { driver, effective: () => w.preparing.length > 0 }
        },
    },
    {
        id: 'import-running-cancel',
        exit: 'import running, Preparing cancelled',
        applies: (path, p) => path.importWait && single(p) && (path.picker ? writesFile(p) : true),
        arm: (w) => {
            const imp = w.startImport()
            const driver = (async () => {
                await w
                    .until(() => w.preparing.some((entry) => entry.open), 'Preparing…', 3000)
                    .catch(() => undefined)
                await sleep(10)
                w.cancelled = w.cancel()
                await sleep(20)
                imp.finish()
                await imp.run
            })()
            return {
                driver,
                effective: () => w.cancelled,
                get facts() {
                    return { cancelled: w.cancelled }
                },
            }
        },
    },
    {
        id: 'activation-lapsed-import',
        exit: 'activation lapsed while waiting for the import (pressed again)',
        applies: (path, p) => path.picker && path.importWait && single(p) && writesFile(p),
        arm: (w) => {
            const imp = w.startImport()
            const driver = (async () => {
                await w
                    .until(() => w.preparing.some((entry) => entry.open), 'Preparing…', 3000)
                    .catch(() => undefined)
                await sleep(30)
                activation.active = false
                imp.finish()
                await imp.run
            })()
            return { driver, effective: () => w.log.some((line) => line.startsWith('ready:')) }
        },
    },
    {
        id: 'import-picker-while-running',
        exit: 'import running that this flow does not wait for',
        applies: (path, p) =>
            path.id === 'save-to-file' &&
            single(p) &&
            ['own', 'other', 'unknown', 'fresh'].includes(last(p)),
        arm: (w) => {
            const imp = w.startImport()
            const driver = (async () => {
                await w
                    .until(() => w.openings.length > 0, 'the picker', 3000)
                    .catch(() => undefined)
                await sleep(30)
                imp.finish()
                await imp.run
            })()
            return { driver }
        },
    },
    {
        id: 'import-pending-never-starts',
        exit: 'import pending that never starts (4 s)',
        applies: (path, p) =>
            path.importWait &&
            path.id !== 'save-as/reloaded' &&
            path.id !== 'export/reloaded' &&
            single(p) &&
            last(p) === 'own' &&
            ['save-as', 'export', 'write-back'].includes(path.id),
        arm: (w) => {
            w.pendingImports.add(w.session.id)
        },
    },
    {
        id: 'cancel-build',
        exit: 'cancel in "Preparing…" during a slow build',
        applies: (path, p) =>
            path.build &&
            single(p) &&
            ['own', 'dismiss'].includes(last(p)) &&
            path.family !== 'export',
        arm: (w) => {
            w.on('worker:buildSave', async (n) => {
                if (n !== 1) return
                // The dialog opens a second into the build, on its own timer.
                await dialogOpen(w)
                w.cancelled = w.cancel()
            })
            return {
                effective: () => w.cancelled,
                get facts() {
                    return { cancelled: w.cancelled && !w.committedWrite() }
                },
            }
        },
    },
    {
        id: 'cancel-build-done',
        exit: 'cancel in "Preparing…" as the build returns',
        applies: (path, p) =>
            path.build &&
            single(p) &&
            ['own', 'dismiss'].includes(last(p)) &&
            path.family !== 'export',
        arm: (w) => {
            w.on('worker:buildSave', async (n) => {
                if (n === 1) await dialogOpen(w)
            })
            w.on('worker:buildSave:after', (n) => {
                if (n === 1) w.cancelled = w.cancel()
            })
            return {
                effective: () => w.cancelled,
                get facts() {
                    return { cancelled: w.cancelled && !w.committedWrite() }
                },
            }
        },
    },
    {
        id: 'cancel-preread',
        exit: 'cancel in "Preparing…" during the damaged re-read',
        applies: (path, p) =>
            path.picker &&
            readsFirst(path) &&
            path.family === 'save' &&
            path.dialog &&
            path.id !== 'save-as/ahead' &&
            single(p) &&
            last(p) === 'own',
        // Storage holds all the file does, so no read came first: the damaged build asks for one.
        setup: { damaged: true, storage: 'holds' },
        arm: (w) => {
            w.tune.readDelayMs = 0
            w.on('worker:buildSave:after', (n) => {
                if (n === 1) w.tune.readWaitsForDialog = true
            })
            const driver = w.atPoint('preRead', () => {
                w.cancelled = w.cancel()
            })
            return {
                driver,
                effective: () => w.cancelled,
                get facts() {
                    return { cancelled: w.cancelled && !w.committedWrite() }
                },
            }
        },
    },
    {
        id: 'export-cancel',
        exit: 'Export dialog cancelled during its build',
        applies: (path, p) =>
            path.family === 'export' && single(p) && ['own', 'dismiss'].includes(last(p)),
        arm: (w) => {
            w.exportBuildHook = () => {
                w.cancelled = true
                w.exportAbort?.abort()
            }
            return {
                effective: () => w.cancelled,
                get facts() {
                    return { cancelled: w.cancelled, unwritten: true }
                },
            }
        },
    },
    {
        id: 'permission-denied',
        exit: 'write access refused at the press',
        applies: (path) => path.id === 'write-back',
        arm: (w) => {
            w.tune.writePermission = 'denied'
        },
    },
]

// ----------------------------------------------------------------------------------------
// Running a cell.

export type CellResult = {
    id: string
    path: string
    plan: string
    fault: string
    violations: Violation[]
    outcome: string
    /** For faults that report it: the fault was met before the Save ended. */
    observed?: boolean
}

/** Whether the bytes a Save had to keep were expected in hand for this setup. */
const expectInHand = (path: PathDef, w: World) => (name: string) => {
    // Export writes over the level data it was opened from; the Save core refuses all three.
    if (name === 'opened.nsld') return path.family !== 'export' || w.setup.opened !== 'levelData'
    if (name !== 'own.nxsp') return false
    const s = w.setup
    // Save to File… reads nothing first (R5), by design.
    if (path.id === 'save-to-file') return false
    if (s.own !== 'bound' || s.read === 'denied') return false
    return s.storage === 'lacks' || s.ownDisk === 'ahead'
}

const HANG_MS = 14000

/** Exits known not to have written: no marker may stay for them (I7). */
const UNWRITTEN = new Set([
    'none',
    'dialog-cancelled',
    'identify-fails',
    'build-refused',
    'build-refused-importing',
    'build-fails',
    'rebuild-refused',
    'rebuild-damaged',
    'rebuild-fails',
    'cancel-build',
    'cancel-build-done',
    'cancel-preread',
    'import-running-cancel',
    'import-pending-never-starts',
    'activation-lapsed-cancel',
    'write-denied',
    'permission-denied',
])

export const runCell = async (
    path: PathDef,
    planned: PickPlan,
    fault: FaultDef,
): Promise<CellResult> => {
    const setup: Setup = { ...path.setup, ...fault.setup }
    const kind = planned.picks.find((pick) => ['opened', 'chart', 'partial'].includes(pick))
    // After a reload (`held: false`) only storage knows a partial open's file: its handle is kept
    // there, and exportMemory is empty (D26). Elsewhere the open is in memory.
    if (kind === 'partial' && setup.held === false) setup.kept = 'afterReload'
    else if (kind)
        setup.opened =
            kind === 'chart' ? 'notProject' : kind === 'partial' ? 'partial' : 'levelData'
    const w = await createWorld(setup)
    prepare(w, path, planned.picks)
    const armed = fault.arm(w, path, planned) ?? {}
    const timeout = Symbol('hang')
    let hung = false
    const flowRun = path.run(w).catch((error: unknown) => {
        w.errors.push(error)
    })
    const result = await Promise.race([
        flowRun,
        new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), HANG_MS)),
    ])
    if (result === timeout) {
        hung = true
        w.cancel()
        w.press()
    }
    if (armed.driver) await Promise.race([armed.driver.catch(() => undefined), sleep(3000)])
    await settle()
    const facts: Facts = {
        inHand: expectInHand(path, w),
        unwritten: UNWRITTEN.has(fault.id),
        ...(armed.facts ?? {}),
    }
    armed.cleanup?.()
    const violations = await check(w, facts)
    if (armed.effective && !armed.effective())
        violations.push({ invariant: 'harness', detail: `${fault.id} did not take effect` })
    if (fault.id === 'none' && w.mock.saveTargets.length)
        violations.push({ invariant: 'harness', detail: 'a queued pick was never used' })
    if (hung)
        violations.push({ invariant: 'hang', detail: `the flow had not ended after ${HANG_MS} ms` })
    const outcome = [
        w.dialogs.map((d) => d.kind).join(','),
        w.writes.map((x) => x.name).join(','),
        (await bytesOf(w.mock.files.get('own.nxsp')))?.length ?? 'gone',
    ].join(' | ')
    return {
        id: `${path.id} / ${planned.id} / ${fault.id}`,
        path: path.id,
        plan: planned.id,
        fault: fault.id,
        violations,
        outcome,
        ...(armed.observed ? { observed: armed.observed() } : {}),
    }
}

/** Every applicable cell. */
export const cells = () => {
    const found: { path: PathDef; plan: PickPlan; fault: FaultDef }[] = []
    for (const path of PATHS)
        for (const planned of path.plans)
            for (const fault of FAULTS)
                if (fault.applies(path, planned)) found.push({ path, plan: planned, fault })
    return found
}
