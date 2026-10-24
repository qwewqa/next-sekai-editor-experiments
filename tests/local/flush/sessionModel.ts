import fc from 'fast-check'
import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName } from '../../../src/history/operations'
import { DB_NAME } from '../../../src/local/db'
import type { Flusher, FlushSession } from '../../../src/local/flush'
import { fromHex16, toHex } from '../../../src/local/hash'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { BIND_STORES, recordOwnSave } from '../../../src/local/save/bind'
import { CUT_STORES, readCut } from '../../../src/local/save/cut'
import { carries, chainRows, isLater, type ChainRow } from '../../../src/local/save/model'
import { journalledSession } from '../../../src/local/startup/resume'
import {
    checkStored,
    replayViolations,
    sessionViolations,
} from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import {
    append,
    beginSession,
    openSplitJournalPage,
    replayAll,
    type SplitJournalPage,
} from '../journal/harness'
import { sampleState } from '../records/samples'
import { continueIn, resumeIn } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { heldLocks, rows, type Page } from './harness'
import { fileStates, flaggedFile, importIds, longFile, smallFile, storeRequest } from './modelFiles'

// The model test: random sequences over the real flusher, journal writer,
// worker core, journal replay and resume, in the test world, with the oracle run after every
// operation. The operations are edits, undo and redo; relaxed and strict
// flushes; the Save (reserve, build, the write landing, failing or failing ambiguously, the
// binding) and its recognition; faults (hide, kill, power loss by `loseRelaxed` and
// `loseCommits`); storage paused or full; a worker restart, also into memory mode; cleanup,
// re-storing and damage; opens with their imports, in another tab and in the page itself (which
// then edits, saves and reloads the opened session while the import runs); forks (another tab's
// continuation, Duplicate Tab); same-tab reloads, as the startup takes them, and new visits; a
// reload while storage never answers (the journal alone); and another tab's write.
//
// The oracle holds what the user did apart from what the product says about it: the state each
// hide journalled, the rows each commit made and whether it was strict, the seqs handed out.
//
// A violation fails the run and names the operations that led to it. `npm test` runs a fixed seed
// set per writer; `NSE_MODEL_GATE=1` is the per-increment gate; `NSE_MODEL_SEED` and
// `NSE_MODEL_RUNS` search.

const DEVICE = { id: 'device-1', label: 'Web (Chrome)' }
const LARGE = 'tests/fixtures/generated-large.json'
const CHANGE = () => editStep(futureFixtureOperation('Changed note'))
const RECOVERY = () =>
    nativeOperation({ id: 'nse.recovery', data: { droppedSteps: 0 } }, 'Recovered last change')

const roots = new WeakMap<State, string>()
const rootOf = (state: State) => {
    let root = roots.get(state)
    if (!root) roots.set(state, (root = toHex(encodeSnapshot(toRecords(state)).root.hash)))
    return root
}

// ---- The model ----------------------------------------------------------------------------------

type Op = { op: number; a: number; b: number }

const OPS = [
    ['edit', 9],
    ['undo', 3],
    ['redo', 2],
    ['flushRelaxed', 4],
    ['flushStrict', 4],
    ['hide', 3],
    ['saveStart', 3],
    ['saveWrite', 3],
    ['saveEnd', 3],
    ['save', 7],
    ['recognise', 3],
    ['reload', 2],
    ['newVisit', 2],
    ['powerLoss', 2],
    ['workerRestart', 2],
    ['pause', 1],
    ['unpause', 2],
    ['cleanup', 1],
    ['restore', 1],
    ['open', 2],
    ['openHere', 2],
    ['importStep', 2],
    ['importEnd', 1],
    ['otherTab', 2],
    ['notHeadFork', 1],
    ['duplicateTab', 1],
    ['journalOnly', 1],
] as const

export const NAMES: string[] = OPS.flatMap(([name, weight]) =>
    Array.from({ length: weight }, () => name),
)

type Visit = SplitJournalPage & { name: string }

/** Every session a flusher still tracks: the current one and those replaced but not let go. */
const sessionsOf = (flusher: Flusher) =>
    (flusher as unknown as { sessions: FlushSession[] }).sessions

type SaveBuild = {
    reservation: NonNullable<ReturnType<Flusher['reserveSave']>>
    sessionId: string
    chainId: string
    docId: string
    seq: number
    n: number
    revisionId: string
    ancestors: string[]
    head: State
    /** The rows the file holds: the chain's stored rows, the pending rows taken, the `save` row. */
    fileRows: string[]
    written: 'no' | 'landed' | 'failed' | 'ambiguous'
    ended: boolean
}

type Import = {
    id: string
    ids: ReturnType<typeof importIds>
    file: Blob
    revisionId: string | undefined
    fingerprint: string | undefined
    total: number
    next: number
}

const rowKey = (row: { kind: unknown; time: unknown; snapshot: unknown }) =>
    `${String(row.kind)}|${String(row.time)}|${toHex(row.snapshot as Uint8Array)}`

const EXPECTED_FAULTS = ['StoragePausedError', 'StorageRefusedError', 'WorkerRestartedError']

export class Run {
    readonly world: World
    readonly storage = new MemoryStorage()
    readonly flags = { noStorage: false }
    readonly trace: string[] = []
    visit!: Visit
    sessionId = ''
    chainId = ''
    /** The states of the live undo stack, by slot. */
    slots: State[] = []
    index = 0
    /** Every state the model made or the files hold, by root: what the stored hashes name. */
    readonly byRoot = new Map<string, State>()
    build: SaveBuild | undefined
    /** Saves whose file landed and whose binding was not recorded by the page that wrote it. */
    readonly unbound: SaveBuild[] = []
    /** The newest Save of each chain whose binding is recorded: I-11 is judged against it. */
    readonly bound = new Map<string, SaveBuild>()
    saves = 0
    other: Visit | undefined
    imp: Import | undefined
    paused = false
    /** Data a cleanup or damage removed on purpose: only the session checks apply. */
    purposeful = false
    readonly removed = new Map<string, { store: string; key: unknown; value: unknown }>()
    opens = 0
    readonly seen = new Set<string>()
    violations: string[] = []

    // The ledgers: what the user did, apart from what the product says about it.
    /** For each hide that journalled: the state the journal must give back, by session and seq. */
    private readonly hid = new Map<string, { seq: number; root: string | undefined }[]>()
    /** The seqs handed out to entries the page made, by session. */
    private readonly made = new Map<string, Map<number, string>>()
    /** Sessions whose stored rows are all in `made`: a row there the page never made is a fault. */
    private readonly madeFull = new Set<string>()
    /** The commit each entries row was created in, and the newest strict commit (durability). */
    private commits = 0
    private lastStrict = 0
    private readonly rowCommit = new Map<string, number>()
    /** Rows stored strictly when a page died, which must survive. */
    private readonly mustSurvive = new Map<
        string,
        { sessionId: string; seq: number; kind: string }
    >()
    /** A resumed session's `strictSeq` before the page wrote anything: stored rows it cannot vouch for. */
    private readonly claimBase = new Map<string, number>()
    private visits = 0
    private checked = 0

    // The ledgers of the flusher oracles.
    /** The pending entries each session held when the oracle last looked. */
    private readonly seenPending = new WeakMap<FlushSession, Set<unknown>>()
    /** Each session's `ackedSeq` and `strictSeq` when the oracle last looked. */
    private readonly watched = new Map<FlushSession, Visit>()
    private readonly seenSeqs = new WeakMap<FlushSession, { acked: number; strict: number }>()
    /**
     * The journal keys a live page wrote, or took over to retire, by key: the text it
     * left, the `seq` it covers and the session whose commit clears it.
     */
    private readonly journals = new Map<
        string,
        { visit: Visit; session: FlushSession; seq: number; text: string; verified: boolean }
    >()
    /** The journal writer's clock: every write is stamped differently, so a rewrite shows in the bytes. */
    private journalWrites = 0

    constructor(
        readonly seed: number,
        readonly fx: boolean,
    ) {
        this.world = createWorld({ seed, checks: { lock: true }, commitLog: true })
        this.world.memory.observe({
            committed: (report) => {
                if (report.db !== DB_NAME) return
                this.commits++
                if (report.durability === 'strict') this.lastStrict = this.commits
                for (const put of report.puts)
                    if (put.store === 'entries' && put.old === undefined) {
                        const row = put.value as Record<string, unknown>
                        this.rowCommit.set(
                            `${String(row.sessionId)}#${String(row.seq)}`,
                            this.commits,
                        )
                    }
            },
            lost: (puts) => {
                for (const put of puts)
                    if (put.store === 'entries' && put.old === undefined) {
                        const row = put.value as Record<string, unknown>
                        const key = `${String(row.sessionId)}#${String(row.seq)}`
                        this.rowCommit.delete(key)
                        // Where commits are not durable when they resolve, a strict one can go.
                        if (this.fx) this.mustSurvive.delete(key)
                    }
            },
        })
        for (const state of fileStates()) this.remember(state)
    }

    async open(
        name: string,
        flush?: NonNullable<Parameters<typeof openSplitJournalPage>[1]>['flush'],
    ) {
        this.visits++
        const page = await openSplitJournalPage(
            this.world,
            { name: `${name}#${this.visits}`, flags: this.flags, ...(flush ? { flush } : {}) },
            this.storage,
            { now: () => 1_792_130_467_000 + ++this.journalWrites },
        )
        const visit = Object.assign(page, { name }) as Visit
        // Every write the page's journal makes is noted for J3, whoever asks for it (a hide, a fork).
        const write = visit.writer.write.bind(visit.writer)
        visit.writer.write = () => {
            const session = visit.flusher.session
            const key = session ? `nse.journal.${session.id}` : undefined
            const before = key ? this.storage.getItem(key) : null
            const verified = write()
            const after = key ? this.storage.getItem(key) : null
            if (session && key && after !== null && after !== before)
                this.journals.set(key, {
                    visit,
                    session,
                    seq: visit.flusher.newestSeq(session),
                    text: after,
                    verified,
                })
            return verified
        }
        return visit
    }

    async start() {
        this.visit = await this.open('a')
        const first = this.remember(sampleState(LARGE), true)
        const session = beginSession(this.visit, first)
        this.sessionId = session.id
        this.chainId = session.chainId
        this.slots = [first]
        this.index = 0
        this.made.set(session.id, new Map([[1, 'init']]))
        this.madeFull.add(session.id)
    }

    /** States whose level data round-trips exactly (the large sample's lineage): their roots survive a journal. */
    private readonly exact = new WeakSet<State>()

    remember(state: State, exact = false) {
        this.byRoot.set(rootOf(state), state)
        if (exact) this.exact.add(state)
        return state
    }

    get flusher() {
        return this.visit.flusher
    }

    get session() {
        return this.visit.flusher.session
    }

    private get alive() {
        return this.visit.page.alive && this.session !== undefined
    }

    /** Whether the visit's worker runs without storage: its transactions are outside the test core's tasks. */
    private inMemory(visit: Visit) {
        return this.flags.noStorage || visit.host.core.status.mode !== 'stored'
    }

    private page(visit: Visit) {
        return visit as unknown as Page
    }

    // ---- the operations ----

    async run(op: Op) {
        const name = NAMES[op.op % NAMES.length]!
        this.trace.push(`${name}(${op.a},${op.b})`)
        const method = (this as unknown as Record<string, (a: number, b: number) => Promise<void>>)[
            `do_${name}`
        ]!
        try {
            await method.call(this, op.a, op.b)
        } catch (error) {
            // A write refused by storage paused or restarting is the fault the model injected.
            const fault = error instanceof Error ? error.name : ''
            if (!EXPECTED_FAULTS.includes(fault)) throw error
        }
        await this.settle()
        // A fork or a new visit changed the page's session: follow it.
        const current = this.visit.flusher.session
        if (current) {
            this.sessionId = current.id
            this.chainId = current.chainId
        }
        await this.check(name)
    }

    /** Lets every queued task run: flushes in flight finish, so the oracle sees a still world. */
    async settle() {
        await this.world.scheduler.idle()
        if (this.world.scheduler.errors.length) throw this.world.scheduler.errors[0] as Error
    }

    private fail(message: string): never {
        return assert.fail(`${message}\nops: ${this.trace.join(' ')}`)
    }

    // Entries, and the seqs handed out.

    private resetMade(sessionId: string, from: 'stored' | 'empty') {
        const map = new Map<number, string>()
        if (from === 'stored')
            for (const row of rows(this.world, 'entries').values())
                if (row.sessionId === sessionId) map.set(row.seq as number, String(row.kind))
        this.made.set(sessionId, map)
        if (from === 'stored') this.madeFull.add(sessionId)
        else this.madeFull.delete(sessionId)
    }

    /** The entry just appended took the newest seq: it must be a seq nothing else holds (E). */
    private noteMade(kind: string) {
        const session = this.session
        if (!session) return
        const seq = this.flusher.newestSeq(session)
        let map = this.made.get(session.id)
        if (!map) this.made.set(session.id, (map = new Map()))
        if (map.has(seq))
            this.fail(
                `E: seq ${seq} of session ${session.id} was handed out twice (${map.get(seq)}, then ${kind})`,
            )
        map.set(seq, kind)
    }

    private append(kind: 'edit' | 'undo' | 'redo', state: State) {
        this.remember(state)
        append(this.visit, { kind, step: CHANGE() }, state)
        this.noteMade(kind)
    }

    async do_edit(a: number) {
        if (!this.alive) return
        const prev = this.slots[this.index]!
        const next = widen(prev, a)
        if (this.exact.has(prev)) this.exact.add(next)
        this.slots.length = this.index + 1
        this.slots.push(next)
        this.index++
        this.append('edit', next)
    }

    async do_undo() {
        if (!this.alive || this.index <= 0) return
        this.index--
        this.append('undo', this.slots[this.index]!)
    }

    async do_redo() {
        if (!this.alive || this.index >= this.slots.length - 1) return
        this.index++
        this.append('redo', this.slots[this.index]!)
    }

    private async flush(strict: boolean) {
        if (!this.visit.page.alive) return
        try {
            await this.flusher.flush({ strict })
        } catch {
            // A failed flush leaves its entries pending; the page's onError has the cause.
        }
    }

    async do_flushRelaxed() {
        await this.flush(false)
    }

    async do_flushStrict() {
        await this.flush(true)
    }

    async do_hide() {
        if (!this.alive) return
        this.visit.live.state = this.slots[this.index]!
        const flusher = this.flusher
        const session = this.session!
        const unflushed = flusher.unflushed(session)
        const key = `nse.journal.${session.id}`
        const before = this.storage.getItem(key)
        const earlier = this.journals.get(key)
        const written = this.visit.writer.write()
        // A second hide at the same seq, the key still as this page left it, leaves its bytes.
        if (
            unflushed &&
            earlier?.verified &&
            earlier.visit === this.visit &&
            earlier.session === session &&
            earlier.text === before &&
            earlier.seq === flusher.newestSeq(session) &&
            this.storage.getItem(key) !== before
        )
            this.fail(
                `J4: a second hide at seq ${earlier.seq} of session ${session.id} rewrote the journal key`,
            )
        // I-14: a hide whose journal verified names the newest entry the page holds, and the
        // state it gives back is the one the user sees: the ledger keeps it.
        if (unflushed && written) {
            const seq = this.journalSeqs().get(session.id) ?? 0
            if (seq < flusher.newestSeq(session))
                this.fail(
                    `I-14: the hide reported a journal covering seq ${flusher.newestSeq(session)} and none does`,
                )
            const list = this.hid.get(session.id) ?? []
            const live = this.slots[this.index]!
            list.push({ seq, root: this.exact.has(live) ? rootOf(live) : undefined })
            this.hid.set(session.id, list)
        }
        // I-17: a page whose entries are all committed writes no journal (one an earlier page
        // left stays until a load finds it covered).
        if (!unflushed && this.storage.getItem(key) !== before)
            this.fail('I-17: a journal written while nothing is unflushed')
    }

    // The Save: reserve and build, the write, the end (the binding).

    private chainImporting(chainId: string) {
        return [...rows(this.world, 'sessions').values()].some(
            (session) => session.chainId === chainId && session.importPending === true,
        )
    }

    async do_saveStart() {
        // A session holds one reservation at a time; a second asked for while the Save's
        // build holds the first is refused.
        const held = this.build
        if (held && !held.ended && this.alive && this.session === held.reservation.session) {
            const second = this.flusher.reserveSave()
            if (second)
                this.fail(
                    `P6: a second reservation (seq ${second.seq}) was handed out in session ${held.sessionId} while seq ${held.seq} is held`,
                )
        }
        // The build refuses while an import of the chain runs ('importing').
        if (!this.alive || this.build || this.chainImporting(this.session!.chainId)) return
        const session = this.session!
        const reservation = this.flusher.reserveSave()
        if (!reservation) return
        const stored = await this.chainRowsStored(session.chainId)
        const taken = this.flusher.unstored(session).entries.map((entry) =>
            rowKey({
                kind: entry.kind,
                time: entry.wall,
                snapshot: entry.snapshot ?? fromHex16(rootOf(entry.state!)),
            }),
        )
        const head = this.slots[this.index]!
        this.saves++
        this.build = {
            reservation,
            sessionId: session.id,
            chainId: session.chainId,
            docId: session.docId,
            seq: reservation.seq,
            n: this.saves,
            revisionId: `rev-${this.saves}`,
            ancestors: Array.from({ length: this.saves - 1 }, (_, i) => `rev-${i + 1}`),
            head,
            fileRows: [
                ...stored,
                ...taken,
                rowKey({ kind: 'save', time: reservation.wall, snapshot: fromHex16(rootOf(head)) }),
            ],
            written: 'no',
            ended: false,
        }
    }

    async do_saveWrite(a: number) {
        const build = this.build
        if (!build || build.written !== 'no') return
        build.written = (['landed', 'landed', 'failed', 'ambiguous'] as const)[a % 4]!
        // An ambiguous failure may or may not have landed; here it lands on odd draws.
        if (build.written === 'ambiguous' && a % 2 === 1) this.unbound.push(build)
        if (build.written === 'landed') this.unbound.push(build)
    }

    /** A whole Save: reserved, built, written, and ended unless the page dies first (`b`). */
    async do_save(a: number, b: number) {
        await this.do_saveStart()
        if (!this.build) return
        await this.do_saveWrite(a)
        // Left unended, the page can still flush, reload or die with the Save in flight.
        if (b % 3 !== 0) await this.do_saveEnd()
    }

    async do_saveEnd() {
        const build = this.build
        if (!build || build.written === 'no' || build.ended) return
        if (!this.visit.page.alive) {
            // The page is gone: the reservation ended with it (a kill between close() and the
            // binding), leaving the file to be recognised.
            this.build = undefined
            return
        }
        // The page may have moved to another session while the Save ran (an opened file): the
        // Save still ends, and the flusher adds nothing to the session it left.
        const stayed = this.session?.id === build.sessionId
        build.ended = true
        this.build = undefined
        const { reservation } = build
        if (build.written === 'landed') {
            const result = await this.flusher.endSave(
                reservation,
                {
                    wall: reservation.wall,
                    operation: this.saveOperation(),
                    state: build.head,
                    revisionId: build.revisionId,
                    device: DEVICE,
                    appVersion: '0.6.0',
                },
                this.unit(build),
            )
            // The model's own expectation, not the flusher's word: the entry is added
            // exactly when the page is still on the Save's session.
            const expected = stayed ? 'added' : 'notCurrent'
            if (result !== expected)
                this.fail(
                    `I-14: the Save at ${String(build.seq)} of ${build.sessionId} ended ${result}, not ${expected}`,
                )
            // Bound by this page: nothing left for another to recognise. A session the page left
            // got neither the entry nor the binding: the file waits to be recognised.
            if (stayed) {
                this.made.get(build.sessionId)?.set(build.seq, 'save')
                const at = this.unbound.indexOf(build)
                if (at >= 0) this.unbound.splice(at, 1)
                this.bound.set(build.chainId, build)
            }
        } else if (build.written === 'failed') {
            await this.flusher.endSave(reservation)
        } else {
            await this.flusher.endSave(reservation, undefined, undefined, true)
        }
    }

    private saveOperation() {
        return nativeOperation(
            { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
            'Saved coconut.nxsp',
        )
    }

    private unit(build: SaveBuild) {
        return {
            docId: build.docId,
            revision: { id: build.revisionId, n: build.n, ancestors: build.ancestors },
            file: {
                name: 'coconut.nxsp',
                event: 'saved',
                at: build.reservation.wall,
                hash: fromHex16(rootOf(build.head)),
                entry: {
                    sessionId: build.sessionId,
                    seq: build.seq,
                    startedAt: 0,
                    count: build.fileRows.length,
                    notKept: 0,
                },
            },
            marks: [],
        }
    }

    /** Recognises a Save whose file landed and whose binding no page recorded. */
    async do_recognise(a: number) {
        if (!this.alive || !this.unbound.length) return
        const build = this.unbound[a % this.unbound.length]!
        // The write-back waits for an import of the chain to end before it recognises.
        if (this.build === build || this.chainImporting(build.chainId)) return
        const session = this.session!
        const at = (field: unknown) =>
            typeof field === 'object' &&
            field !== null &&
            typeof (field as { at?: unknown }).at === 'number'
                ? (field as { at: number }).at
                : undefined
        // Strict, as the worker's `recordOwnSave` handler writes it: the model once wrote it by
        // default (relaxed), and a power loss then undid a row it had pledged. The record's
        // binding is read in the same transaction, as `ownCompletedSave` reads it under the lock.
        const recorded = await this.visit.host.call((_, core) =>
            core.write(
                BIND_STORES,
                async (tx) => {
                    const chain = (await tx.get('chains', build.chainId)) as
                        Record<string, unknown> | undefined
                    const from = {
                        ...(at(chain?.file) === undefined ? {} : { fileAt: at(chain?.file) }),
                        ...(at(chain?.replaced) === undefined
                            ? {}
                            : { replacedAt: at(chain?.replaced) }),
                    }
                    return recordOwnSave(tx, {
                        chainId: build.chainId,
                        writer: {
                            sessionId: session.id,
                            ...(session.continuation && session.parent
                                ? { parentId: session.parent.id }
                                : {}),
                        },
                        unit: { ...this.unit(build), from },
                    })
                },
                { durability: 'strict' },
            ),
        )
        if (recorded === 'recorded') {
            this.unbound.splice(this.unbound.indexOf(build), 1)
            this.bound.set(build.chainId, build)
        }
    }

    /** The chain's stored rows as the file would hold them. */
    private async chainRowsStored(chainId: string) {
        const cut = await this.visit.host.call((_, core) =>
            core.read(CUT_STORES, (tx) => readCut(tx, chainId)),
        )
        return cut ? chainRows(cut).map(({ entry }) => rowKey(entry)) : []
    }

    /**
     * I-11: the cut only under-claims. A cut that carries means the chain's rows up to it are the
     * file's, by (kind, time, snapshot). Judged after every operation, for the chain's newest Save.
     */
    private async cutCheck(build: SaveBuild) {
        const cut = await this.visit.host.call((_, core) =>
            core.read(CUT_STORES, (tx) => readCut(tx, build.chainId)),
        )
        const file = cut?.chain.file?.entry
        if (!cut || !file || file.sessionId !== build.sessionId || file.seq !== build.seq) return
        const all: ChainRow[] = chainRows(cut)
        const startedAt = cut.sessions.find((session) => session.id === file.sessionId)?.startedAt
        if (startedAt === undefined) return
        const edge = { ...file, startedAt }
        const base = cut.chain.revision
        if (!base) return
        const stored = (sessionId: string) => cut.sessions.some((each) => each.id === sessionId)
        if (!carries(all, edge, { revisionId: base.id }, stored, (row) => !row.entry.kept)) return
        const upto = all.filter((row) => !isLater(row, edge))
        const have = upto.map(({ entry }) => rowKey(entry)).sort()
        const held = [...build.fileRows].sort()
        if (have.length === held.length && have.every((key, at) => key === held[at])) return
        // The same rows with other times are accepted (another tab's write can
        // move a row's time by a few milliseconds); rows that differ are new.
        const withoutTime = (key: string) =>
            key
                .split('|')
                .filter((_, at) => at !== 1)
                .join('|')
        const sorted = (keys: string[]) => keys.map(withoutTime).sort()
        if (
            have.length === held.length &&
            sorted(have).every((key, at) => key === sorted(held)[at])
        )
            return
        this.violations.push(
            `I-11: the cut of ${build.revisionId} carries, but the chain's ${have.length} rows up to it differ from the file's ${held.length}`,
        )
    }

    // Faults.

    private journalSeqs(): Map<string, number> {
        const seqs = new Map<string, number>()
        for (let i = 0; i < this.storage.length; i++) {
            const key = this.storage.key(i)
            if (!key?.startsWith('nse.journal.')) continue
            try {
                const journal = JSON.parse(this.storage.getItem(key) ?? '') as { seq?: number }
                if (typeof journal.seq === 'number')
                    seqs.set(key.slice('nse.journal.'.length), journal.seq)
            } catch {
                // Unreadable: covers nothing.
            }
        }
        return seqs
    }

    /**
     * What a page that dies must still have afterwards: the rows a strict commit holds, or
     * that an earlier strict commit made durable. A kill keeps them and so does a power loss; where
     * commits are not durable when they resolve (Firefox before 126) the commits a loss undoes
     * take their pledges with them.
     */
    private pledge() {
        for (const row of rows(this.world, 'entries').values()) {
            const key = `${String(row.sessionId)}#${String(row.seq)}`
            const commit = this.rowCommit.get(key)
            if (commit !== undefined && commit <= this.lastStrict)
                this.mustSurvive.set(key, {
                    sessionId: String(row.sessionId),
                    seq: row.seq as number,
                    kind: String(row.kind),
                })
        }
    }

    private async gone(visit: Visit) {
        this.pledge()
        visit.page.kill()
        await this.settle()
    }

    /** Takes a dead page's journals, as the next load does, and judges each by what the user left. */
    private async replay() {
        const journals = this.journalSeqs()
        const { outcomes } = await replayAll(this.world, this.storage, `replay${this.visits}`)
        const stored = [...rows(this.world, 'entries').values()]
        for (const outcome of outcomes) {
            const seq = journals.get(outcome.sessionId)
            if (seq === undefined || outcome.kind === 'live') continue
            // The state the user left in that journal: the ledger, not the product's own rule.
            const left = this.hid
                .get(outcome.sessionId)
                ?.filter((each) => each.seq === seq)
                .at(-1)
            // A journal no hide of the model wrote cannot be judged by its state.
            if (!left && outcome.kind !== 'failed') continue
            const here = stored.filter((row) => row.sessionId === outcome.sessionId)
            const holds = (row: Record<string, unknown>) =>
                !left?.root || toHex(row.snapshot as Uint8Array) === left.root
            let ok: boolean
            switch (outcome.kind) {
                case 'applied':
                    ok = here.some(
                        (row) =>
                            row.kind === 'recovered' && (row.seq as number) >= seq && holds(row),
                    )
                    break
                case 'covered':
                    // Stored at the journal's own seq, or (a fork took them) anywhere.
                    ok =
                        here.some((row) => row.seq === seq && holds(row)) ||
                        stored.some((row) => left && holds(row))
                    break
                case 'recovery':
                    ok = stored.some((row) => row.kind === 'recovered' && holds(row))
                    break
                case 'failed':
                    // Storage refused the apply: the journal is left for the next load.
                    ok = this.storage.getItem(`nse.journal.${outcome.sessionId}`) !== null
                    break
                default:
                    ok = false
            }
            if (!ok)
                this.fail(
                    `I-14: the journal of session ${outcome.sessionId} at seq ${seq} came out as ${outcome.kind}, and the state the user left in it is nowhere`,
                )
        }
    }

    private async readSession(visit: Visit, sessionId: string) {
        return visit.host.call((_, core) =>
            startupHandlers(
                { core, test: true, emit: () => undefined },
                visit.host.worker.waiter,
            ).readSession(sessionId),
        )
    }

    /** The own journal replay left in storage, if it reads. */
    private async ownJournal(sessionId: string) {
        const found = (await storageJournalStore(() => this.storage, 'nse.').read()).find(
            (each) => each.sessionId === sessionId,
        )
        return found ? journalledSession(found) : undefined
    }

    /** The journal key the own journal came from, as the startup retires it once the continuation holds its work. */
    private async ownFound(sessionId: string) {
        return (await storageJournalStore(() => this.storage, 'nse.').read()).find(
            (each) => each.sessionId === sessionId,
        )
    }

    /** Takes a read session up as the startup does: resumed, continued, or forked. */
    private adopt(
        visit: Visit,
        read: Extract<Awaited<ReturnType<Run['readSession']>>, { kind: 'open' }>,
        how: 'resume' | 'continue' | 'fork',
        taken?: State,
        found?: Awaited<ReturnType<Run['ownFound']>>,
    ) {
        const slots = read.stack.slots.map((slot) => this.byRoot.get(toHex(slot.snapshot)))
        if (slots.some((state) => !state)) return false
        const index = read.stack.window.index - read.stack.window.base
        this.visit = visit
        this.slots = slots as State[]
        this.index = index
        visit.live.state = this.slots[index]!
        const page = this.page(visit)
        const session =
            how === 'resume'
                ? resumeIn(page, read)
                : continueIn(page, read, how === 'fork' ? { asFork: true } : {})
        this.sessionId = session.id
        this.chainId = session.chainId
        this.claimBase.set(session.id, session.strictSeq)
        this.resetMade(session.id, how === 'resume' ? 'stored' : 'empty')
        if (taken) {
            // The journal replay left: the continuation starts from its state (`reloadOwn`).
            this.slots.length = index + 1
            this.slots.push(taken)
            this.index = index + 1
            this.append('edit', taken)
            // As the startup does (`open.ts`): the journal's key goes once the continuation's
            // entry holding its work is committed (J3).
            if (found) {
                const seq = visit.flusher.newestSeq(session)
                visit.writer.retire(found, session.id, seq)
                this.journals.set(`nse.${found.from}`, {
                    visit,
                    session,
                    seq,
                    text: found.text,
                    verified: true,
                })
            }
        }
        return true
    }

    /**
     * A same-tab reload or a new visit, as the startup takes it: replay first; a reload whose own
     * journal is left (storage refused the apply) continues from the journal's state, never
     * resumes under it; a reload with storage unavailable continues from the journal alone.
     */
    private async comeBack(sameTab: boolean, pick: number) {
        const unavailable = this.flags.noStorage
        if (!unavailable) await this.replay()
        const visit = await this.open('a')
        this.visit = visit
        if (unavailable) {
            const journalled = sameTab ? await this.ownJournal(this.sessionId) : undefined
            // A session already stored takes the move into storage (Try Again), not a second birth.
            if (journalled && !rows(this.world, 'sessions').has(this.sessionId))
                this.resumeJournal(visit, journalled)
            else this.freshSession()
            return
        }
        const read = await this.readSession(visit, this.sessionId)
        if (read.kind !== 'open') return this.freshSession()
        const marked = this.build ?? this.unbound.find((save) => save.sessionId === this.sessionId)
        if (marked)
            (
                visit.flusher as unknown as { deps: { reservedSeq?: () => number } }
            ).deps.reservedSeq = () => marked.seq
        this.build = undefined
        const own = sameTab ? await this.ownJournal(this.sessionId) : undefined
        const lastSeq = read.session.lastSeq as number
        let adopted: boolean
        if (own && own.seq > lastSeq) {
            const taken = this.byRoot.get(rootOf(own.state)) ?? this.remember(own.state)
            const found = await this.ownFound(this.sessionId)
            adopted = this.adopt(visit, read, read.isHead ? 'continue' : 'fork', taken, found)
        } else adopted = this.adopt(visit, read, sameTab ? 'resume' : 'continue')
        // A state the model never made: start over.
        if (!adopted) return this.freshSession()
        await this.settleImport(pick)
        // The next Save's write-back recognises a file the page did not bind.
        if (this.unbound.length && pick % 2 === 0) await this.do_recognise(pick)
    }

    /** A reload while storage never answers continues from the journal alone. */
    private resumeJournal(
        visit: Visit,
        journalled: NonNullable<Awaited<ReturnType<Run['ownJournal']>>>,
    ) {
        const state = this.byRoot.get(rootOf(journalled.state)) ?? this.remember(journalled.state)
        visit.live.state = state
        const session = visit.flusher.resumeJournalled({ ...journalled, operation: RECOVERY() })
        this.visit = visit
        this.sessionId = session.id
        this.chainId = session.chainId
        this.slots = [state]
        this.index = 0
        this.claimBase.set(session.id, 0)
        this.resetMade(session.id, 'empty')
    }

    private freshSession() {
        const first = this.remember(sampleState(LARGE), true)
        const session = beginSession(this.visit, first)
        this.sessionId = session.id
        this.chainId = session.chainId
        this.slots = [first]
        this.index = 0
        this.resetMade(session.id, 'empty')
        this.made.get(session.id)!.set(1, 'init')
        this.madeFull.add(session.id)
    }

    /** A reload or a new visit ends the page as a browser does: pagehide writes the journal first. */
    private async leave() {
        if (!this.visit.page.alive) return
        await this.do_hide()
        await this.gone(this.visit)
    }

    async do_reload(a: number, b: number) {
        await this.leave()
        await this.comeBack(true, a + b)
    }

    async do_newVisit(a: number, b: number) {
        await this.leave()
        await this.comeBack(false, a + b)
    }

    async do_powerLoss(a: number, b: number) {
        for (const visit of [this.visit, this.other]) if (visit?.page.alive) await this.gone(visit)
        this.other = undefined
        const memory = this.world.memory
        if (this.fx) memory.loseCommits(Math.min(1 + (a % 2), memory.loggedCommits))
        else memory.loseRelaxed(Math.min(1 + (a % 3), memory.relaxedCommits))
        await this.comeBack(a % 2 === 0, a + b)
    }

    async do_workerRestart(a: number) {
        if (!this.visit.page.alive) return
        // A restart into memory mode: the new worker finds no storage, and later ones may.
        this.flags.noStorage = a % 3 === 0
        this.visit.host.worker.kill()
        await this.settle()
    }

    async do_pause() {
        if (this.paused) return
        this.paused = true
        this.world.memory.faults.request = (_stores, mode) => {
            if (mode !== 'readwrite') return undefined
            const error = new Error('The disk is full')
            error.name = 'QuotaExceededError'
            return error
        }
    }

    async do_unpause() {
        if (!this.paused) return
        this.paused = false
        this.world.memory.faults.request = undefined
        await this.flush(true)
    }

    // Cleanup, re-storing, damage.

    async do_cleanup(a: number, b: number) {
        // A worker in memory mode holds none of the stored rows.
        if (this.flags.noStorage) return
        const entries = [...rows(this.world, 'entries').values()].filter(
            (row) => row.sessionId === this.sessionId && row.kept !== false,
        )
        const row = entries[a % Math.max(entries.length, 1)]
        if (!row || !this.visit.page.alive) return
        this.purposeful = true
        const snapshot = row.snapshot as Uint8Array
        // Kept by flag alone, with the bodies kept, or with the root removed (a real loss).
        const thin = b % 2 === 0
        await this.visit.host.call((_, core) =>
            core.write(['entries', 'nodes'], async (tx) => {
                await tx.put('entries', { ...row, kept: false })
                if (!thin) return
                const key = snapshot.buffer.slice(
                    snapshot.byteOffset,
                    snapshot.byteOffset + snapshot.byteLength,
                ) as ArrayBuffer
                const root = await tx.get('nodes', key)
                if (root) {
                    this.removed.set(toHex(snapshot), { store: 'nodes', key, value: root })
                    await tx.delete('nodes', key)
                }
            }),
        )
    }

    async do_restore() {
        if (this.flags.noStorage) return
        const [first] = this.removed
        if (!first || !this.visit.page.alive) return
        const [hex, removed] = first
        this.removed.delete(hex)
        await this.visit.host.call((_, core) =>
            core.write(['nodes'], (tx) =>
                tx.put('nodes', removed.value, removed.key as ArrayBuffer),
            ),
        )
    }

    // Opens and imports.

    private openOf(visit: Visit) {
        return () =>
            openHandlers(
                { core: visit.host.core, test: true, emit: () => undefined },
                visit.host.worker.waiter,
            )
    }

    private async fileFor(kind: number) {
        return kind === 1
            ? (await flaggedFile()).file
            : kind === 2
              ? await longFile(400)
              : await smallFile()
    }

    /** Another tab opens a file and finishes, abandons or resumes its import. */
    async do_open(a: number) {
        // A worker in memory mode runs its transactions outside the test core's tasks.
        if (this.flags.noStorage) return
        const visit = await this.otherVisit()
        if (this.inMemory(visit)) return
        this.opens++
        const ids = importIds(this.opens)
        const kind = a % 4
        const file = await this.fileFor(kind === 3 ? 1 : kind)
        const open = this.openOf(visit)
        const run = <T>(fn: () => Promise<T>) => visit.host.call(fn)
        const reply = await run(() => open().openRead(file))
        if (reply.kind !== 'nxsp') return
        const stored = await run(() => open().openStore(storeRequest(reply.id, ids)))
        if (stored.kind !== 'stored') return
        const fill = async (id: string, count: number) => {
            for (let n = 0; n < count; n++) await run(() => open().openBatch({ id, n }))
        }
        // 0: completed; 1: abandoned part way; 2: completed (long); 3: resumed after a drop.
        if (kind === 1) {
            await fill(reply.id, Math.min(1, stored.batches))
            await run(() => Promise.resolve(open().openAbandon(ids.sessionId)))
        } else if (kind === 3) {
            await fill(reply.id, Math.min(1, stored.batches))
            await run(() => Promise.resolve(open().openDrop(reply.id)))
            const resumed = await run(() =>
                open().openResume({
                    sessionId: ids.sessionId,
                    file,
                    revisionId: reply.project?.revision?.id,
                    fingerprint: reply.disk?.fingerprint,
                }),
            )
            if (resumed.kind === 'resumed') await fill(resumed.id, resumed.batches)
        } else {
            await fill(reply.id, stored.batches)
        }
    }

    /**
     * The page opens a file as `open/project.ts` does: the opened session is taken up at once and
     * the page edits, saves and reloads it while the import's batches run (`importStep`).
     */
    async do_openHere(a: number) {
        if (!this.alive || this.paused || this.inMemory(this.visit) || this.imp) return
        this.opens++
        const ids = importIds(this.opens)
        const file = await this.fileFor(a % 3)
        const visit = this.visit
        const open = this.openOf(visit)
        const reply = await visit.host.call(() => open().openRead(file))
        if (reply.kind !== 'nxsp') return
        const stored = await visit.host.call(() => open().openStore(storeRequest(reply.id, ids)))
        if (stored.kind !== 'stored') return
        this.imp = {
            id: reply.id,
            ids,
            file,
            revisionId: reply.project?.revision?.id,
            fingerprint: reply.disk?.fingerprint,
            total: stored.batches,
            next: 0,
        }
        const read = await this.readSession(visit, ids.sessionId)
        if (read.kind !== 'open' || !this.adopt(visit, read, 'resume')) await this.abandonImport()
    }

    async do_importStep() {
        const imp = this.imp
        if (!imp || !this.visit.page.alive || this.inMemory(this.visit)) return
        if (imp.next >= imp.total) return this.finishImport()
        const open = this.openOf(this.visit)
        await this.visit.host.call(() => open().openBatch({ id: imp.id, n: imp.next }))
        imp.next++
    }

    async do_importEnd(a: number) {
        if (!this.imp || !this.visit.page.alive || this.inMemory(this.visit)) return
        if (a % 2 === 0) await this.finishImport()
        else await this.abandonImport()
    }

    private async finishImport() {
        const imp = this.imp
        if (!imp) return
        const open = this.openOf(this.visit)
        for (; imp.next < imp.total; imp.next++)
            await this.visit.host.call(() => open().openBatch({ id: imp.id, n: imp.next }))
        this.imp = undefined
    }

    private async abandonImport() {
        const imp = this.imp
        if (!imp) return
        const open = this.openOf(this.visit)
        await this.visit.host.call(() => Promise.resolve(open().openAbandon(imp.ids.sessionId)))
        this.imp = undefined
    }

    /** A reload ended the page's import: it is resumed from the file, or abandoned. */
    private async settleImport(pick: number) {
        const imp = this.imp
        if (!imp) return
        this.imp = undefined
        const pending = rows(this.world, 'sessions').get(imp.ids.sessionId)?.importPending === true
        if (!pending) return
        const open = this.openOf(this.visit)
        if (pick % 2 === 0) {
            const resumed = await this.visit.host.call(() =>
                open().openResume({
                    sessionId: imp.ids.sessionId,
                    file: imp.file,
                    revisionId: imp.revisionId,
                    fingerprint: imp.fingerprint,
                }),
            )
            if (resumed.kind === 'resumed') {
                this.imp = { ...imp, id: resumed.id, total: resumed.batches, next: 0 }
                return
            }
        }
        await this.visit.host.call(() => Promise.resolve(open().openAbandon(imp.ids.sessionId)))
    }

    private async otherVisit() {
        if (this.other?.page.alive) return this.other
        this.other = await this.open('b')
        return this.other
    }

    // Another tab's writes, and forks.

    async do_otherTab(a: number) {
        const visit = await this.otherVisit()
        if (!visit.flusher.session) {
            const first = this.remember(sampleState(LARGE))
            beginSession(visit, first)
        }
        const state = widen(visit.live.state, a)
        this.remember(state)
        append(visit, { kind: 'edit', step: CHANGE() }, state)
        await visit.flusher.flush({ strict: a % 2 === 0 })
    }

    /** Another tab's continuation takes the chain's head after this page lost its lock. */
    async do_notHeadFork() {
        // In memory mode the store knows no chain head to refuse a page that lost its lock.
        if (!this.alive || this.paused || this.flags.noStorage) return
        const session = this.session!
        const stored = rows(this.world, 'sessions').get(session.id)
        if (!stored || stored.importPending) return
        const visit = await this.open('c')
        heldLocks.get(this.flusher)?.get(session.id)?.()
        const read = await this.readSession(visit, session.id)
        if (read.kind === 'open') {
            continueIn(this.page(visit), read)
            visit.live.state = this.slots[this.index]!
            append(visit, { kind: 'edit', step: CHANGE() }, widen(this.slots[this.index]!, 1))
            await visit.flusher.flush({ strict: true })
        }
        // The first page's next entries find the head moved: its flush forks them.
        await this.do_edit(2)
        await this.flush(true)
        this.other = visit
    }

    /** Duplicate Tab: the copy finds the session's lock held and forks it. */
    async do_duplicateTab() {
        if (!this.alive) return
        const session = this.session!
        if (!rows(this.world, 'sessions').get(session.id)) return
        const visit = await this.open('d')
        const read = await this.readSession(visit, session.id)
        if (read.kind !== 'open') return
        continueIn(this.page(visit), read, { asFork: true })
        visit.live.state = this.slots[this.index]!
        append(visit, { kind: 'edit', step: CHANGE() }, widen(this.slots[this.index]!, 3))
        await visit.flusher.flush({ strict: true })
        this.other = visit
    }

    /**
     * A page whose storage never answers keeps the edits in the journal alone; the next
     * visit, with a Save's marker past them, continues from that journal while storage is down.
     */
    async do_journalOnly(a: number, b: number) {
        // With storage paused or in memory the resumed page cannot store what it recovers.
        if (this.paused || this.flags.noStorage) return
        await this.leave()
        const stalled = await this.open('u', { transport: () => new Promise(() => undefined) })
        const first = this.remember(sampleState(LARGE), true)
        const session = beginSession(stalled, first)
        let state = first
        for (let k = 0; k <= a % 3; k++) {
            state = this.remember(widen(state, k + b), true)
            append(stalled, { kind: 'edit', step: CHANGE() }, state)
        }
        const marked = a % 2 === 0 ? stalled.flusher.reserveSave() : undefined
        stalled.live.state = state
        if (!stalled.writer.write())
            this.fail('the journal of a page with no storage did not verify')
        this.hid.set(session.id, [
            { seq: this.journalSeqs().get(session.id) ?? 0, root: rootOf(state) },
        ])
        stalled.page.kill()
        await this.settle()
        const journalled = await this.ownJournal(session.id)
        if (!journalled) this.fail('the journal of a page with no storage is unreadable')
        const visit = await this.open('a')
        if (marked)
            (
                visit.flusher as unknown as { deps: { reservedSeq?: () => number } }
            ).deps.reservedSeq = () => marked.seq
        this.resumeJournal(visit, journalled)
        await visit.flusher.flush({ strict: true })
        // The journal's only copy of the edits is stored, and is the state the user left.
        const recovered = [...rows(this.world, 'entries').values()].find(
            (row) => row.sessionId === session.id && row.kind === 'recovered',
        )
        if (!recovered || toHex(recovered.snapshot as Uint8Array) !== rootOf(state))
            this.fail(
                `I-14: the journal-only reload of session ${session.id} did not store the edits`,
            )
    }

    // ---- the oracle ----

    /**
     * The oracles on the flusher's own state, judged after every operation. They read what the product holds beside what the stored-data checker reads.
     */
    private checkFlusher(after: string) {
        // Sessions the flusher let go stay watched: nothing may be added to them either.
        for (const visit of [this.visit, this.other])
            if (visit?.page.alive)
                for (const session of sessionsOf(visit.flusher)) this.watched.set(session, visit)
        for (const [session, visit] of this.watched) {
            if (!visit.page.alive) {
                this.watched.delete(session)
                continue
            }
            // A session that is not the page's current one gains no pending entry.
            const earlier = this.seenPending.get(session)
            if (earlier && session !== visit.flusher.session)
                for (const entry of session.pending)
                    if (!earlier.has(entry))
                        this.fail(
                            `after ${after}: P1: session ${session.id} (${visit.name}) is not the current one and gained the pending ${entry.kind} entry ${entry.seq}`,
                        )
            this.seenPending.set(session, new Set(session.pending))
            // Committed and strict `seq`s never go back.
            const seen = this.seenSeqs.get(session)
            if (seen && (session.ackedSeq < seen.acked || session.strictSeq < seen.strict))
                this.fail(
                    `after ${after}: P4: session ${session.id} (${visit.name}) went back to ackedSeq ${session.ackedSeq}, strictSeq ${session.strictSeq} from ${seen.acked}, ${seen.strict}`,
                )
            this.seenSeqs.set(session, { acked: session.ackedSeq, strict: session.strictSeq })
        }
        this.checkJournals(after)
    }

    /** J3: once a commit covers a journal's `seq` and the page is idle, that journal key is gone. */
    private checkJournals(after: string) {
        for (const [key, journal] of this.journals) {
            const { visit, session } = journal
            if (!visit.page.alive || this.storage.getItem(key) !== journal.text)
                // The page died (its journal is for the next load), or the key is another's now.
                this.journals.delete(key)
            else if (
                !this.paused &&
                !this.inMemory(visit) &&
                sessionsOf(visit.flusher).includes(session) &&
                session.ackedSeq >= journal.seq &&
                !session.pending.length &&
                !session.memoryOnly.length
            )
                this.fail(
                    `after ${after}: J3: the journal of session ${session.id} at seq ${journal.seq} is still stored after a commit covered seq ${session.ackedSeq} (${visit.name})`,
                )
        }
    }

    private async check(after: string) {
        const world = this.world
        const found: string[] = []
        this.checkFlusher(after)
        found.push(
            ...(this.purposeful
                ? // Bodies gone on purpose: the rows' own rules and the stack against replay.
                  [
                      ...sessionViolations(world.memory.dump(DB_NAME), world.sessionOptions),
                      ...replayViolations(world.memory.dump(DB_NAME)),
                  ]
                : checkStored(world.memory, world.sessionOptions)),
        )
        for (const line of world.violations.slice(this.checked)) found.push(line)
        this.checked = world.violations.length
        // I-11 for the newest Save of each chain, after every operation.
        if (this.visit.page.alive && !this.paused && !this.flags.noStorage)
            for (const build of this.bound.values()) await this.cutCheck(build)
        for (const line of this.violations.splice(0)) found.push(line)
        // Rows to come while an import is pending: its states' closures are not whole yet.
        // An import abandoned part way leaves the nodes it had written without their chunks.
        const importing = [...rows(world, 'sessions').values()].some(
            (session) => session.importPending === true || session.origin === 'nxsp',
        )
        for (const line of found) {
            if (this.seen.has(line)) continue
            if (importing && /is missing$/.test(line)) continue
            this.seen.add(line)
            this.fail(
                `after ${after}: ${line}\nsessions: ${JSON.stringify(
                    [...rows(world, 'sessions').values()].map((s) => [s.id, s.chainId, s.lastSeq]),
                )}`,
            )
        }
        this.checkStrictClaim(after)
        this.checkMade(after)
        // Flush errors the page reports that no fault explains.
        for (const visit of [this.visit, this.other]) {
            const bad = visit?.errors.find(
                (error) => error instanceof Error && error.name === 'FlushOrderError',
            )
            if (bad) this.fail(`after ${after}: FlushOrderError`)
        }
    }

    /**
     * What the flusher believes strict is: every row it wrote above a resumed session's own
     * `strictSeq` lies in a commit a strict commit has covered.
     */
    private checkStrictClaim(after: string) {
        for (const visit of [this.visit, this.other]) {
            if (!visit?.page.alive) continue
            for (const session of sessionsOf(visit.flusher)) {
                const base = this.claimBase.get(session.id) ?? 0
                for (let seq = base + 1; seq <= session.strictSeq; seq++) {
                    const commit = this.rowCommit.get(`${session.id}#${seq}`)
                    if (commit !== undefined && commit > this.lastStrict)
                        this.fail(
                            `after ${after}: I-14: the flusher takes seq ${seq} of session ${session.id} for strict (strictSeq ${session.strictSeq}), but only a relaxed commit holds it`,
                        )
                }
            }
        }
    }

    /**
     * Spec E's flusher model: every entry the page made is stored once, at its own seq and kind,
     * once a strict flush has nothing left to send; and no entry row the page never made is there.
     */
    private checkMade(after: string) {
        const visit = this.visit
        const session = visit.flusher.session
        if (!visit.page.alive || !session || this.paused) return
        // A Save still building holds a reservation in its own session.
        if (this.build?.sessionId === session.id) return
        if (this.flags.noStorage || visit.host.core.status.mode !== 'stored') return
        if (session.pending.length || visit.flusher.unflushed(session)) return
        const map = this.made.get(session.id)
        if (!map) return
        const stored = new Map(
            [...rows(this.world, 'entries').values()]
                .filter((row) => row.sessionId === session.id)
                .map((row) => [row.seq as number, String(row.kind)] as const),
        )
        for (const [seq, kind] of map)
            if (stored.get(seq) !== kind)
                this.fail(
                    `after ${after}: E: entry ${seq} (${kind}) of session ${session.id} is not stored at its seq (${stored.get(seq) ?? 'no row'})`,
                )
        if (this.madeFull.has(session.id))
            for (const [seq, kind] of stored)
                if (['edit', 'undo', 'redo'].includes(kind) && !map.has(seq))
                    this.fail(
                        `after ${after}: E: row ${seq} (${kind}) of session ${session.id} is one the page never made`,
                    )
    }

    /** The end of a run: faults gone, every page flushed strictly, journals replayed. */
    async finish() {
        this.world.memory.faults.request = undefined
        this.paused = false
        this.flags.noStorage = false
        // A Save still reserved ends: its write did not land (a landed one is recognised or not).
        if (this.build && this.visit.page.alive) {
            await this.flusher.endSave(this.build.reservation)
            this.build = undefined
        }
        for (const visit of [this.visit, this.other]) {
            if (!visit?.page.alive) continue
            // A page still in memory mode keeps what only memory holds until a restart re-sends.
            if (visit.host.core.status.mode === 'memory') {
                visit.host.worker.kill()
                await this.settle()
            }
        }
        if (this.imp && this.visit.page.alive) await this.finishImport()
        for (const visit of [this.visit, this.other]) {
            if (!visit?.page.alive) continue
            await visit.flusher.flush({ strict: true }).catch(() => undefined)
            await this.settle()
            // Nothing paused or failing now: every entry is committed (a blank start or an
            // unstored continuation has nothing to store).
            const flusher = visit.flusher
            for (const session of sessionsOf(flusher))
                if (flusher.unflushed(session))
                    this.fail(
                        `I-14: session ${session.id} (${visit.name}) has entries not committed after a strict flush: ${JSON.stringify([session.pending.length, session.memoryOnly.length, session.ackedSeq, session.strictSeq, session.reserved?.seq, session.stored, flusher.session === session])}`,
                    )
        }
        await this.check('finish')
        for (const visit of [this.visit, this.other]) if (visit?.page.alive) await this.gone(visit)
        await this.replay()
        await this.settle()
        await this.check('finish')
        // I-14: every row a strict commit held before a kill or power loss is still stored, or
        // covered by a `recovered` row above it.
        const stored = rows(this.world, 'entries')
        for (const [key, entry] of this.mustSurvive) {
            const here = [...stored.values()].filter((row) => row.sessionId === entry.sessionId)
            const has = here.some((row) => row.seq === entry.seq)
            const covered = here.some(
                (row) => row.kind === 'recovered' && (row.seq as number) >= entry.seq,
            )
            if (!has && !covered && rows(this.world, 'sessions').has(entry.sessionId))
                this.fail(
                    `I-14: entry ${entry.seq} (${entry.kind}) of session ${entry.sessionId} was stored strictly and is gone (${key})`,
                )
        }
    }
}

// ---- The tests --------------------------------------------------------------------------------

const opArb = fc.record({
    op: fc.nat(NAMES.length - 1),
    a: fc.nat(9),
    b: fc.nat(9),
})

/** A script that failed once, or a path nothing else draws often, and must keep passing. */
type Regression = {
    name: string
    seed: number
    fx: boolean
    script: string
    /** What the script must really have done. */
    expect?: (run: Run) => void
}

const REGRESSIONS: readonly Regression[] = [
    // The recognition was written
    // relaxed (the product writes it strict), a power loss undid it, and the model had pledged it.
    {
        name: 'a recognition is strict',
        seed: 404,
        fx: false,
        script: 'unpause:2:4,edit:9:6,saveEnd:7:1,save:5:1,otherTab:1:3,open:1:1,recognise:0:2,edit:6:8,open:8:1,pause:4:1,save:7:4,edit:9:8,edit:7:1,unpause:8:8,saveWrite:3:7,powerLoss:6:0,recognise:5:5,saveEnd:9:3,newVisit:3:6,flushStrict:5:4,saveWrite:8:2,edit:6:7,unpause:0:2,powerLoss:4:6',
    },
    // A reload while storage is paused leaves the page's own journal, and
    // the startup continues from it. Resuming under it, as the first model did, lost the journalled
    // edits (their seqs were reused) and the old oracle called the journal covered.
    {
        name: 'a reload continues from its own journal',
        seed: 7,
        fx: false,
        script: 'edit:1,flushStrict,pause,edit:2,edit:3,reload:0,unpause,edit:4,edit:5,edit:6,flushStrict',
        expect: (run) => {
            const continued = [...rows(run.world, 'sessions').values()].filter((session) =>
                Boolean(session.parent),
            )
            assert.ok(continued.length > 0, 'the reload continued the session')
        },
    },
    // A Save still reserved when the page moves to another session ends later (the
    // flusher adds nothing to the session it left); a second reservation asked for while one is
    // held and a second hide at the same seq change nothing.
    ...[false, true].flatMap((fx): Regression[] => [
        {
            name: 'a Save ends after the page moved to another session',
            seed: 61,
            fx,
            script: 'edit:1,flushStrict,save:0:0,openHere:0,saveEnd,flushStrict',
            expect: (run) => {
                const own = new Set(
                    [...rows(run.world, 'sessions').values()]
                        .filter((session) => session.origin !== 'nxsp')
                        .map((session) => session.id),
                )
                const saves = [...rows(run.world, 'entries').values()].filter(
                    (row) => row.kind === 'save' && own.has(row.sessionId),
                )
                assert.equal(saves.length, 0, 'the Save’s entry went nowhere')
            },
        },
        {
            name: 'a second reservation while one is held changes nothing',
            seed: 62,
            fx,
            script: 'edit:1,flushStrict,save:0:0,save:1:0,saveEnd,flushStrict',
        },
        {
            name: 'a second hide at the same seq leaves the journal key',
            seed: 63,
            fx,
            script: 'edit:1,flushStrict,edit:2,edit:3,hide,hide,flushStrict',
        },
    ]),
    // The page opens a file and edits, saves and reloads the opened
    // session while the import runs.
    ...[false, true].map((fx): Regression => ({
        name: 'the page edits an opened session while its import runs',
        seed: 31,
        fx,
        script: 'openHere:0,edit:1,edit:2,flushStrict,importStep,edit:3,flushStrict,hide,importStep,edit:4,importEnd:0,save:0:1,reload:1:1,edit:5,flushStrict',
        expect: (run) => {
            const opened = [...rows(run.world, 'sessions').values()].find(
                (session) => session.origin === 'nxsp',
            )
            assert.ok(opened, 'a session was opened from a file')
            const base = run.world.openBase.get(String(opened.id)) ?? Infinity
            const own = [...rows(run.world, 'entries').values()].filter(
                (row) => row.sessionId === opened.id && (row.seq as number) > base,
            )
            assert.ok(own.length >= 3, 'the page wrote rows of its own into the opened session')
        },
    })),
]

const scriptRun = async (seed: number, fx: boolean, script: string) => {
    const run = new Run(seed, fx)
    await run.start()
    for (const [at, name] of script.split(',').entries()) {
        const [op, a, b] = name.split(':')
        await run.run({ op: NAMES.indexOf(op!), a: Number(a ?? at), b: Number(b ?? 0) })
    }
    await run.finish()
    return run
}

/**
 * Defines the model tests of one power-loss model. `loseRelaxed` and Firefox before 126's
 * `loseCommits` are two files so that the runner runs them side by side, and each has seeds of
 * its own.
 */
export const defineModelTests = (fx: boolean) => {
    const gate = process.env.NSE_MODEL_GATE === '1'
    const offset = fx ? 1000 : 0
    const seeds = process.env.NSE_MODEL_SEED
        ? [Number(process.env.NSE_MODEL_SEED)]
        : gate
          ? Array.from({ length: 16 }, (_, i) => 101 * (i + 1))
          : [101, 202, 303, 404, 505, 606]
    const runs = Number(process.env.NSE_MODEL_RUNS ?? (gate ? 25 : 5))
    const label = fx ? ', Firefox before 126' : ''

    const script = process.env.NSE_MODEL_SCRIPT
    if (script) {
        test('session model script', async () => {
            const run = new Run(Number(process.env.NSE_MODEL_SEED ?? 1) + offset, fx)
            try {
                await run.start()
                for (const [at, name] of script.split(',').entries()) {
                    const [op, a, b] = name.split(':')
                    await run.run({ op: NAMES.indexOf(op!), a: Number(a ?? at), b: Number(b ?? 0) })
                }
                await run.finish()
            } finally {
                console.log(run.trace.join(' '))
            }
        })
        return
    }

    for (const regression of REGRESSIONS)
        if (regression.fx === fx)
            test(`session model regression: ${regression.name}${label}`, async () => {
                const run = await scriptRun(regression.seed + offset, fx, regression.script)
                regression.expect?.(run)
            })

    for (const seed of seeds)
        test(`session model, seed ${seed + offset}${label}`, async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.array(opArb, { minLength: 12, maxLength: 30, size: 'max' }),
                    async (ops) => {
                        const run = new Run(seed + offset, fx)
                        await run.start()
                        for (const op of ops) await run.run(op)
                        await run.finish()
                    },
                ),
                { seed: seed + offset, numRuns: runs, endOnFailure: !process.env.NSE_MODEL_SHRINK },
            )
        })
}
