import fc from 'fast-check'
import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName } from '../../../src/history/operations'
import { DB_NAME } from '../../../src/local/db'
import type { Flusher, FlushSession } from '../../../src/local/flush'
import { fromHex16, toHex } from '../../../src/local/hash'
import { MemoryStorage } from '../../../src/local/journal/store'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { BIND_STORES, finishOwnSave, type OwnSaveBelow } from '../../../src/local/save/bind'
import { CUT_STORES, readCut } from '../../../src/local/save/cut'
import { carries, chainRows, isLater, type ChainRow } from '../../../src/local/save/model'
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
import { goldenChart, stateOf } from '../records/charts'
import { continueIn, resumeIn } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { heldLocks, rows, type Page } from './harness'
import { flaggedFile, importIds, longFile, smallFile, storeRequest } from './modelFiles'

// The model test of design A (§7, R2-6): random sequences over the real flusher, journal writer,
// worker core, journal replay and resume, in the test world, with the oracle run after every
// operation. The operations are the design's for A0+: edits and undo; relaxed and strict flushes;
// the Save (reserve, build, the write landing, failing or failing ambiguously, the binding);
// faults (hide, kill, power loss by `loseRelaxed` and `loseCommits`); storage paused or full; a
// worker restart, also into memory mode; cleanup, re-storing and damage; opens with their imports
// (completed, abandoned, resumed after a reload, a file holding a `kept: false` row with its
// root); forks (another tab's continuation, Duplicate Tab); same-tab reloads and new visits;
// recognition; and another tab's write. A6's settle operation is not here: its code is.
//
// Known breaches of today's code are pinned, each with the increment that clears it; an
// unpinned violation fails the run and names the operations that led to it. `npm test` runs a
// fixed seed set; more runs: NSE_MODEL_RUNS=<n> NSE_MODEL_SEED=<seed>.

const DEVICE = { id: 'device-1', label: 'Web (Chrome)' }
const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)
const CHANGE = () => editStep(futureFixtureOperation('Changed note'))

// ---- Pins: the breaches today's code is known to make --------------------------------------

type Pin = { pattern: RegExp; clearedBy: string; why: string }

export const MODEL_PINS: Pin[] = [
    {
        pattern: /^lock: rows [\d, ]+ of session \S+ were created while the page did not hold/,
        clearedBy: 'A2',
        why: 'AR-1, I-1: finishOwnSave writes a session its recognising page does not hold',
    },
    {
        pattern: /no longer its chain's head/,
        clearedBy: 'A2',
        why: 'AR-1, I-5: a recognised Save writes a parent after the head moved on',
    },
    {
        pattern:
            /parent \S+ (holds rows [\d, ]+ past its uptoSeq|has lastSeq \d+, not its uptoSeq)/,
        clearedBy: 'A2',
        why: 'AR-1, I-5: the parent of a continuation has rows past its branch point',
    },
    {
        pattern: /were created at or below its lastSeq|has lastSeq \d+ after creating rows up to/,
        clearedBy: 'A2',
        why: 'AR-2, I-2: keptSave and the net store rows under lastSeq',
    },
    {
        pattern: /row \d+ \(time \d+\) is later than row \d+ \(time \d+\)/,
        clearedBy: 'A2',
        why: 'AR-2, I-6: a Save stored late carries a later stamp than the rows above it',
    },
    {
        pattern: /^I-11 \(recovered\)/,
        clearedBy: 'A2',
        why: 'AR-8, AR-8b, F2, I-11: the cut carries over a recovered row where the file holds another',
    },
    {
        pattern: /^I-11 \(time\)/,
        clearedBy: 'A6',
        why: 'AR-7, I-11: a row stamped at its flush differs in time from the file’s',
    },
]

// ---- The model ----------------------------------------------------------------------------------

type Op = { op: number; a: number; b: number }

const OPS = [
    ['edit', 9],
    ['undo', 3],
    ['redo', 2],
    ['flushRelaxed', 4],
    ['flushStrict', 4],
    ['hide', 3],
    ['saveStart', 4],
    ['saveWrite', 4],
    ['saveEnd', 4],
    ['save', 6],
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
    ['otherTab', 2],
    ['notHeadFork', 1],
    ['duplicateTab', 1],
] as const

const NAMES: string[] = OPS.flatMap(([name, weight]) => Array.from({ length: weight }, () => name))

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

const rowKey = (row: { kind: unknown; time: unknown; snapshot: unknown }) =>
    `${String(row.kind)}|${String(row.time)}|${toHex(row.snapshot as Uint8Array)}`

class Run {
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
    readonly cache = new Map<string, State>()
    /** Entries stored strictly when a page died, which must survive (I-14). */
    readonly mustSurvive = new Map<string, { sessionId: string; seq: number; kind: string }>()
    build: SaveBuild | undefined
    /** Saves whose file landed and whose binding was not recorded by the page that wrote it. */
    readonly unbound: SaveBuild[] = []
    saves = 0
    other: Visit | undefined
    paused = false
    /** Data a cleanup or damage removed on purpose: only the session checks apply. */
    purposeful = false
    readonly removed = new Map<string, { store: string; key: unknown; value: unknown }>()
    opens = 0
    readonly seen = new Set<string>()
    violations: string[] = []
    pinned = new Set<string>()
    private visits = 0
    private checked = 0

    constructor(
        readonly seed: number,
        readonly fx: boolean,
    ) {
        this.world = createWorld({ seed, checks: { lock: true }, commitLog: true })
    }

    async open(name: string): Promise<Visit> {
        this.visits++
        const page = await openSplitJournalPage(
            this.world,
            { name: `${name}#${this.visits}`, flags: this.flags },
            this.storage,
            this.fx ? { strictCommits: false } : {},
        )
        return Object.assign(page, { name })
    }

    async start() {
        this.visit = await this.open('a')
        const first = stateOf(goldenChart())
        this.remember(first)
        const session = beginSession(this.visit, first)
        this.sessionId = session.id
        this.chainId = session.chainId
        this.slots = [first]
        this.index = 0
    }

    remember(state: State) {
        this.cache.set(rootOf(state), state)
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
            const name = error instanceof Error ? error.name : ''
            if (
                !['StoragePausedError', 'StorageRefusedError', 'WorkerRestartedError'].includes(
                    name,
                )
            )
                throw error
        }
        await this.settle()
        // A fork or a new visit changed the page's session: follow it.
        const current = this.visit.flusher.session
        if (current) {
            this.sessionId = current.id
            this.chainId = current.chainId
        }
        this.check(name)
    }

    /** Lets every queued task run: flushes in flight finish, so the oracle sees a still world. */
    async settle() {
        await this.world.scheduler.idle()
        if (this.world.scheduler.errors.length) throw this.world.scheduler.errors[0] as Error
    }

    private append(kind: 'edit' | 'undo' | 'redo', state: State) {
        this.remember(state)
        append(this.visit, { kind, step: CHANGE() }, state)
    }

    async do_edit(a: number) {
        if (!this.alive) return
        const next = widen(this.slots[this.index]!, a)
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
        const written = this.visit.writer.write()
        // I-14: a hide whose journal verified names the newest entry the page holds.
        if (unflushed && written)
            assert.ok(
                (this.journalSeqs().get(session.id) ?? 0) >= flusher.newestSeq(session),
                `I-14: the hide reported a journal covering seq ${flusher.newestSeq(session)} and none does
ops: ${this.trace.join(' ')}`,
            )
        // I-17: a page whose entries are all strictly committed writes no journal (one an earlier
        // page left stays until a load finds it covered).
        if (!unflushed)
            assert.equal(
                this.storage.getItem(key),
                before,
                'I-17: a journal written while nothing is unflushed',
            )
    }

    // The Save: reserve and build, the write, the end (the binding).

    async do_saveStart() {
        if (!this.alive || this.build) return
        const session = this.session!
        const reservation = this.flusher.reserveSave()
        if (!reservation) return
        const stored = await this.chainRowsStored()
        const taken = this.flusher.unstored(session).entries.map((entry) =>
            rowKey({
                kind: entry.kind,
                time: entry.wall,
                snapshot: entry.snapshot ?? fromHex16(rootOf(entry.state!)),
            }),
        )
        const head = this.slots[this.index]!
        this.saves++
        const build: SaveBuild = {
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
        this.build = build
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
        if (!this.visit.page.alive || this.session?.id !== build.sessionId) {
            // The page is gone: the reservation ended with it (a kill between close() and the
            // binding), leaving the file to be recognised.
            this.build = undefined
            return
        }
        build.ended = true
        this.build = undefined
        const { reservation } = build
        if (build.written === 'landed') {
            await this.flusher.endSave(
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
            // Bound by this page: nothing left for another to recognise.
            const at = this.unbound.indexOf(build)
            if (at >= 0) this.unbound.splice(at, 1)
            await this.cutCheck(build)
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
                options: { history: true, bgm: true },
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

    /** Recognises a Save whose file landed and whose binding no page recorded (§1.4.7). */
    async do_recognise(a: number) {
        if (!this.alive || !this.unbound.length) return
        const build = this.unbound[a % this.unbound.length]!
        if (this.build === build) return
        const below = this.flusher.keptSaveBelow(build.sessionId, build.seq)
        const kind: OwnSaveBelow | undefined = below?.kind
        const entry = {
            sessionId: build.sessionId,
            seq: build.seq,
            time: build.reservation.wall,
            operation: this.saveOperation(),
            snapshot: rootOf(build.head),
            noteCount: 1,
            revisionId: build.revisionId,
            device: DEVICE,
        }
        const unit = this.unit(build)
        const done = await this.visit.host.call((_, core) =>
            core.write(BIND_STORES, (tx) =>
                finishOwnSave(tx, build.chainId, entry, unit, 2_000_000, kind),
            ),
        )
        if (below?.kind === 'pending')
            await this.flusher.keptSave(below, {
                wall: entry.time,
                operation: entry.operation,
                revisionId: entry.revisionId,
                device: entry.device,
            })
        if (done) {
            this.unbound.splice(this.unbound.indexOf(build), 1)
            await this.cutCheck(build)
        }
    }

    /** The chain's stored rows as the file would hold them. */
    private async chainRowsStored() {
        const cut = await this.visit.host.call((_, core) =>
            core.read(CUT_STORES, (tx) => readCut(tx, this.chainId)),
        )
        return cut ? chainRows(cut).map(({ entry }) => rowKey(entry)) : []
    }

    /**
     * I-11: the cut only under-claims. After a binding is recorded, a cut that carries means the
     * chain's rows up to it are the file's, by (kind, time, snapshot).
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
        if (!carries(all, edge, (row) => !row.entry.kept)) return
        const upto = all.filter((row) => !isLater(row, edge))
        const have = upto.map(({ entry }) => rowKey(entry)).sort()
        const held = [...build.fileRows].sort()
        if (have.length === held.length && have.every((key, at) => key === held[at])) return
        // The same rows with other times (AR-7), or rows that differ (AR-8, AR-8b, F2).
        const withoutTime = (key: string) =>
            key
                .split('|')
                .filter((_, at) => at !== 1)
                .join('|')
        const sorted = (keys: string[]) => keys.map(withoutTime).sort()
        const onlyTime =
            have.length === held.length && sorted(have).every((key, at) => key === sorted(held)[at])
        // A recovered row where the file holds another is AR-8, AR-8b and F2; anything else that
        // differs is new.
        const kind = onlyTime
            ? 'time'
            : have.some((key) => key.startsWith('recovered|'))
              ? 'recovered'
              : 'content'
        this.violations.push(
            `I-11 (${kind}): the cut of ${build.revisionId} carries, but the chain's ${have.length} rows up to it differ from the file's ${held.length}`,
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
     * What a page that dies must still have afterwards (I-14): its entries stored strictly, which
     * a kill keeps and a power loss on Chromium and Firefox 126 and later keeps. Where commits are
     * not durable when they resolve (Firefox before 126) a power loss keeps only what a journal
     * names, which replay turns into a `recovered` row.
     */
    private pledge(visit: Visit, powerLoss: boolean) {
        if (powerLoss && this.fx) return
        const flusher = visit.flusher
        const stored = rows(this.world, 'entries')
        for (const session of sessionsOf(flusher)) {
            const strict =
                session === flusher.session ? flusher.session.strictSeq : Number.POSITIVE_INFINITY
            for (const row of stored.values())
                if (row.sessionId === session.id && (row.seq as number) <= strict)
                    this.mustSurvive.set(`${session.id}#${String(row.seq)}`, {
                        sessionId: session.id,
                        seq: row.seq as number,
                        kind: String(row.kind),
                    })
        }
    }

    private async gone(visit: Visit, powerLoss = false) {
        this.pledge(visit, powerLoss)
        visit.page.kill()
        await this.settle()
    }

    /** Takes a dead page's journals, as the next load does. */
    private async replay() {
        const journals = this.journalSeqs()
        const { outcomes } = await replayAll(this.world, this.storage, `replay${this.visits}`)
        // I-14: a journal is applied as a `recovered` row, found covered by what is stored, or
        // kept as a recovery session; never dropped. (A live page's journal is left alone.)
        const stored = [...rows(this.world, 'entries').values()]
        const sessions = rows(this.world, 'sessions')
        for (const outcome of outcomes) {
            const seq = journals.get(outcome.sessionId)
            if (seq === undefined || outcome.kind === 'live') continue
            const here = stored.filter((row) => row.sessionId === outcome.sessionId)
            const lastSeq = (sessions.get(outcome.sessionId)?.lastSeq as number | undefined) ?? 0
            const ok =
                outcome.kind === 'applied'
                    ? here.some((row) => row.kind === 'recovered' && (row.seq as number) >= seq)
                    : outcome.kind === 'covered'
                      ? lastSeq >= seq
                      : outcome.kind === 'recovery'
                        ? stored.some((row) => row.kind === 'recovered')
                        : outcome.kind === 'failed'
                          ? // Storage refused the apply: the journal is left for the next load.
                            this.storage.getItem(`nse.journal.${outcome.sessionId}`) !== null
                          : false
            if (!ok)
                assert.fail(
                    `I-14: the journal of session ${outcome.sessionId} at seq ${seq} came out as ${outcome.kind}, with its entries nowhere
ops: ${this.trace.join(' ')}`,
                )
        }
    }

    /** A same-tab reload or a new visit: replay, then take the session up or continue it. */
    private async comeBack(sameTab: boolean) {
        await this.replay()
        const visit = await this.open('a')
        const read = await visit.host.call((_, core) =>
            startupHandlers(
                { core, test: true, emit: () => undefined },
                visit.host.worker.waiter,
            ).readSession(this.sessionId),
        )
        if (read.kind !== 'open') {
            // The session is gone (a power loss undid its creation): a blank start.
            this.visit = visit
            await this.freshSession()
            return
        }
        const marked = this.build ?? this.unbound.find((save) => save.sessionId === this.sessionId)
        if (marked)
            (
                visit.flusher as unknown as { deps: { reservedSeq?: () => number } }
            ).deps.reservedSeq = () => marked.seq
        this.build = undefined
        const stackStates = read.stack.slots.map((slot) => this.cache.get(toHex(slot.snapshot)))
        const live = stackStates[read.stack.window.index - read.stack.window.base]
        if (!live || stackStates.some((state) => !state)) {
            // A state the model never made (an import's): start over from the stored head.
            this.visit = visit
            await this.freshSession()
            return
        }
        this.visit = visit
        visit.live.state = live
        this.slots = stackStates as State[]
        this.index = read.stack.window.index - read.stack.window.base
        const page = visit as unknown as Page
        const session = sameTab ? resumeIn(page, read) : continueIn(page, read)
        this.sessionId = session.id
        this.chainId = session.chainId
    }

    private async freshSession() {
        const first = this.remember(stateOf(goldenChart()))
        const session = beginSession(this.visit, first)
        this.sessionId = session.id
        this.chainId = session.chainId
        this.slots = [first]
        this.index = 0
    }

    /** A reload or a new visit ends the page as a browser does: pagehide writes the journal first. */
    private async leave() {
        if (!this.visit.page.alive) return
        await this.do_hide()
        await this.gone(this.visit)
    }

    async do_reload() {
        await this.leave()
        await this.comeBack(true)
    }

    async do_newVisit() {
        await this.leave()
        await this.comeBack(false)
    }

    async do_powerLoss(a: number) {
        for (const visit of [this.visit, this.other])
            if (visit?.page.alive) await this.gone(visit, true)
        this.other = undefined
        const memory = this.world.memory
        if (this.fx) {
            // No commit is durable when it resolves: rows stored strictly before are not safe either.
            this.mustSurvive.clear()
            memory.loseCommits(Math.min(1 + (a % 2), memory.loggedCommits))
        } else memory.loseRelaxed(Math.min(1 + (a % 3), memory.relaxedCommits))
        await this.comeBack(a % 2 === 0)
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
        const entries = [...rows(this.world, 'entries').values()].filter(
            (row) => row.sessionId === this.sessionId && row.kept !== false,
        )
        const row = entries[a % Math.max(entries.length, 1)]
        if (!row || !this.visit.page.alive) return
        this.purposeful = true
        const snapshot = row.snapshot as Uint8Array
        // Kept by flag alone, with the bodies kept (M7), or with the root removed (a real loss).
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

    // Opens and imports, by another tab.

    async do_open(a: number) {
        // A worker in memory mode runs its transactions outside the test core's tasks.
        if (this.flags.noStorage) return
        const visit = await this.otherVisit()
        if (!visit) return
        this.opens++
        const ids = importIds(this.opens)
        const kind = a % 4
        const file =
            kind === 1
                ? await longFile(1500)
                : kind === 2
                  ? (await flaggedFile()).file
                  : await smallFile()
        const open = () =>
            openHandlers(
                { core: visit.host.core, test: true, emit: () => undefined },
                visit.host.worker.waiter,
            )
        const run = <T>(fn: () => Promise<T>) => visit.host.call(fn)
        const reply = await run(() => open().openRead(file))
        if (reply.kind !== 'nxsp') return
        const stored = await run(() => open().openStore(storeRequest(reply.id, ids)))
        if (stored.kind !== 'stored') return
        const batches = stored.batches
        // 0: completed; 1: abandoned part way; 2: completed (a flagged row); 3: resumed after a reload.
        const fill = async (id: string, count: number) => {
            for (let n = 0; n < count; n++) await run(() => open().openBatch({ id, n }))
        }
        if (kind === 1) {
            await fill(reply.id, Math.min(1, batches))
            await run(() => Promise.resolve(open().openAbandon(ids.sessionId)))
        } else if (kind === 3) {
            await fill(reply.id, Math.min(1, batches))
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
            await fill(reply.id, batches)
        }
    }

    private async otherVisit() {
        if (this.other?.page.alive) return this.other
        this.other = await this.open('b')
        return this.other
    }

    // Another tab's writes, and forks.

    async do_otherTab(a: number) {
        const visit = await this.otherVisit()
        if (!visit) return
        if (!visit.flusher.session) {
            const first = this.remember(stateOf(goldenChart()))
            beginSession(visit, first)
        }
        const state = widen(visit.live.state, a)
        this.remember(state)
        append(visit, { kind: 'edit', step: CHANGE() }, state)
        await visit.flusher.flush({ strict: a % 2 === 0 })
    }

    /** Another tab's continuation takes the chain's head after this page lost its lock. */
    async do_notHeadFork() {
        if (!this.alive || this.paused) return
        const session = this.session!
        const stored = rows(this.world, 'sessions').get(session.id)
        if (!stored || stored.importPending) return
        const visit = await this.open('c')
        heldLocks.get(this.flusher)?.get(session.id)?.()
        const read = await visit.host.call((_, core) =>
            startupHandlers(
                { core, test: true, emit: () => undefined },
                visit.host.worker.waiter,
            ).readSession(session.id),
        )
        if (read.kind === 'open') {
            continueIn(visit as unknown as Page, read)
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
        const read = await visit.host.call((_, core) =>
            startupHandlers(
                { core, test: true, emit: () => undefined },
                visit.host.worker.waiter,
            ).readSession(session.id),
        )
        if (read.kind !== 'open') return
        continueIn(visit as unknown as Page, read, { asFork: true })
        visit.live.state = this.slots[this.index]!
        append(visit, { kind: 'edit', step: CHANGE() }, widen(this.slots[this.index]!, 3))
        await visit.flusher.flush({ strict: true })
        this.other = visit
    }

    // ---- the oracle ----

    private check(after: string) {
        const world = this.world
        const found: string[] = []
        const hole = world.holes.has
        found.push(
            ...(this.purposeful
                ? // Bodies gone on purpose: the rows' own rules and the stack against replay.
                  [
                      ...sessionViolations(world.memory.dump(DB_NAME), { hole }),
                      ...replayViolations(world.memory.dump(DB_NAME)),
                  ]
                : checkStored(world.memory, { hole })),
        )
        for (const line of world.violations.slice(this.checked)) found.push(line)
        this.checked = world.violations.length
        for (const line of this.violations.splice(0)) found.push(line)
        // Rows to come while an import is pending: its states' closures are not whole yet.
        const importing = [...rows(world, 'sessions').values()].some(
            (session) => session.importPending === true,
        )
        for (const line of found) {
            if (this.seen.has(line)) continue
            if (importing && /is missing$/.test(line)) continue
            this.seen.add(line)
            const known = MODEL_PINS.find((pin) => pin.pattern.test(line))
            if (known) this.pinned.add(known.why)
            else
                assert.fail(
                    `after ${after}: ${line}\nops: ${this.trace.join(' ')}\nsessions: ${JSON.stringify(
                        [...rows(world, 'sessions').values()].map((s) => [
                            s.id,
                            s.chainId,
                            s.lastSeq,
                        ]),
                    )}`,
                )
        }
        // Flush errors the page reports that no fault explains.
        for (const visit of [this.visit, this.other]) {
            const bad = visit?.errors.find(
                (error) => error instanceof Error && error.name === 'FlushOrderError',
            )
            if (bad) assert.fail(`after ${after}: FlushOrderError\nops: ${this.trace.join(' ')}`)
        }
    }

    /** The end of a run: faults gone, every page flushed strictly, journals replayed (I-14). */
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
            await visit.flusher.flush({ strict: true }).catch(() => undefined)
            await this.settle()
            // Nothing paused or failing now: every entry is committed strictly (a blank start or an
            // unstored continuation has nothing to store).
            const flusher = visit.flusher
            for (const session of sessionsOf(flusher))
                assert.equal(
                    flusher.unflushed(session),
                    false,
                    `I-14: session ${session.id} (${visit.name}) has entries not committed strictly after a strict flush: ${JSON.stringify([session.pending.length, session.memoryOnly.length, session.ackedSeq, session.strictSeq, session.reserved, session.stored, flusher.session === session])}
ops: ${this.trace.join(' ')}`,
                )
        }
        for (const visit of [this.visit, this.other]) if (visit?.page.alive) await this.gone(visit)
        await this.replay()
        await this.settle()
        this.check('finish')
        // I-14: every entry stored strictly before a kill or power loss is still stored, or
        // covered by a `recovered` row above it; a page that ended with nothing paused holds
        // nothing unstored.
        const stored = rows(this.world, 'entries')
        for (const [key, entry] of this.mustSurvive) {
            const here = [...stored.values()].filter((row) => row.sessionId === entry.sessionId)
            const has = here.some((row) => row.seq === entry.seq)
            const covered = here.some(
                (row) => row.kind === 'recovered' && (row.seq as number) >= entry.seq,
            )
            if (!has && !covered && rows(this.world, 'sessions').has(entry.sessionId))
                assert.fail(
                    `I-14: entry ${entry.seq} (${entry.kind}) of session ${entry.sessionId} was stored strictly and is gone (${key})
ops: ${this.trace.join(' ')}`,
                )
        }
    }
}

const opArb = fc.record({
    op: fc.nat(NAMES.length - 1),
    a: fc.nat(9),
    b: fc.nat(9),
})

/** Runs one script of operation names, for a failure to replay: NSE_MODEL_SCRIPT="edit,flushStrict". */
const SCRIPT = process.env.NSE_MODEL_SCRIPT?.split(',')

const SEEDS = process.env.NSE_MODEL_SEED
    ? [Number(process.env.NSE_MODEL_SEED)]
    : [101, 202, 303, 404]
const RUNS = Number(process.env.NSE_MODEL_RUNS ?? 4)

if (SCRIPT)
    test('session model script', async () => {
        const run = new Run(
            Number(process.env.NSE_MODEL_SEED ?? 1),
            process.env.NSE_MODEL_FX === '1',
        )
        await run.start()
        for (const [at, name] of SCRIPT.entries()) {
            const [op, a, b] = name.split(':')
            await run.run({ op: NAMES.indexOf(op!), a: Number(a ?? at), b: Number(b ?? 0) })
        }
        try {
            await run.finish()
        } finally {
            console.log(run.trace.join(' '), run.saves, [...run.pinned])
            if (process.env.NSE_MODEL_DUMP) {
                console.log(
                    JSON.stringify(
                        [...rows(run.world, 'sessions').values()].map((r) => [
                            r.id,
                            r.chainId,
                            r.lastSeq,
                            r.parent,
                            r.forkOf,
                        ]),
                    ),
                )
                console.log(
                    JSON.stringify(
                        [...rows(run.world, 'chains').values()].map((r) => [
                            r.chainId,
                            r.head,
                            r.forkOf,
                        ]),
                    ),
                )
                console.log(
                    JSON.stringify(
                        [...rows(run.world, 'entries').values()].map((r) => [
                            r.sessionId,
                            r.seq,
                            r.kind,
                        ]),
                    ),
                )
            }
        }
    })

for (const fx of SCRIPT ? [] : [false, true])
    for (const seed of SEEDS)
        test(`session model, seed ${seed}${fx ? ', Firefox before 126' : ''}`, async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.array(opArb, { minLength: 12, maxLength: 30, size: 'max' }),
                    async (ops) => {
                        const run = new Run(seed, fx)
                        await run.start()
                        for (const op of ops) await run.run(op)
                        await run.finish()
                        if (process.env.NSE_MODEL_VERBOSE)
                            console.log(
                                run.trace.length,
                                run.saves,
                                rows(run.world, 'sessions').size,
                                rows(run.world, 'entries').size,
                                [...run.pinned],
                            )
                    },
                ),
                { seed, numRuns: RUNS, endOnFailure: !process.env.NSE_MODEL_SHRINK },
            )
        })
