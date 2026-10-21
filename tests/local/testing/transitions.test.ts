import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import test from 'node:test'
import { DB_NAME, STORE_NAMES } from '../../../src/local/db'
import type { CommitReport, Row, WrittenRow } from '../../../src/local/kv/memory'
import type { Key } from '../../../src/local/kv/types'
import { sessionLock } from '../../../src/local/locks'
import { transitionViolations } from '../../../src/local/testing/transitions'
import { createWorld } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation, originOperation } from '../../helpers/historySteps'
import { leaseOf } from '../../helpers/leases'
import { openPage, testId, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'

// The transition check and the lock-holder assertion (spec-A §2, I-1 to I-5): each rule is shown
// to report on a made-up commit, and the world's hook is shown to see a real writer that holds no
// lock.

type Store = Record<string, Record<string, unknown>>

const keyOf = (store: string, value: Record<string, unknown>): Key =>
    store === 'entries'
        ? [String(value.sessionId), Number(value.seq)]
        : store === 'stackBlocks'
          ? [String(value.sessionId), Number(value.block)]
          : String(value.id ?? value.chainId)

const text = (key: Key) => JSON.stringify(key)

/** A commit: rows `puts` over `before`, giving the rows as stored after. */
const commit = (
    before: Record<string, Record<string, unknown>[]>,
    puts: Record<string, Record<string, unknown>[]>,
    context: { sessions?: string[] } = {},
    stores: readonly string[] = ['sessions', 'entries', 'chains', 'stackBlocks'],
): CommitReport => {
    const rows: Store = {}
    const store = (name: string) => (rows[name] ??= {})
    for (const [name, list] of Object.entries(before))
        for (const value of list) store(name)[text(keyOf(name, value))] = value
    const written: WrittenRow[] = []
    for (const [name, list] of Object.entries(puts))
        for (const value of list) {
            const key = keyOf(name, value)
            written.push({ store: name, key, old: store(name)[text(key)], value })
            store(name)[text(key)] = value
        }
    return {
        actor: { name: 'a' } as CommitReport['actor'],
        db: DB_NAME,
        stores,
        durability: 'strict',
        puts: written,
        deletes: [],
        context: { sessions: new Set(context.sessions ?? []) },
        current: (name, key) => rows[name]?.[text(key)],
        rows: (name) =>
            (Object.values(rows[name] ?? {}) as Record<string, unknown>[]).map((value): Row => ({
                key: keyOf(name, value),
                value,
            })),
    }
}

const session = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    chainId: 'c',
    lastSeq: 2,
    stack: {},
    updatedAt: 1,
    entryCount: 2,
    ...extra,
})
const entry = (sessionId: string, seq: number, extra: Record<string, unknown> = {}) => ({
    sessionId,
    seq,
    kind: 'edit',
    kept: true,
    ...extra,
})
const chain = (head: string, extra: Record<string, unknown> = {}) => ({
    chainId: 'c',
    head,
    ...extra,
})

const base = () => ({
    sessions: [session('S')],
    entries: [entry('S', 1), entry('S', 2)],
    chains: [chain('S')],
})

test('rows above lastSeq by the page that holds the lock are clean', () => {
    const report = commit(
        base(),
        { entries: [entry('S', 3), entry('S', 4)], sessions: [session('S', { lastSeq: 4 })] },
        { sessions: ['S'] },
    )
    assert.deepEqual(transitionViolations(report), [])
})

test('rows created without the page holding the session’s lock are named (I-1)', () => {
    const report = commit(
        base(),
        { entries: [entry('S', 3)], sessions: [session('S', { lastSeq: 3 })] },
        { sessions: ['other'] },
    )
    assert.match(transitionViolations(report)[0]!, /lock: rows 3 of session S were created/)
    assert.deepEqual(transitionViolations(report, { lock: false }), [])
})

test('the transaction that creates the session, or an import’s batch, needs no lock', () => {
    const born = commit(
        { chains: [chain('N')] },
        { sessions: [session('N', { lastSeq: 1 })], entries: [entry('N', 1)] },
    )
    assert.deepEqual(transitionViolations(born), [])
    const filling = session('F', { origin: 'nxsp', importPending: true, lastSeq: 1 })
    const batch = commit(
        { sessions: [filling], entries: [entry('F', 5)], chains: [chain('F')] },
        { entries: [entry('F', 2), entry('F', 3)] },
    )
    assert.deepEqual(transitionViolations(batch), [])
    // The same rows into a session that is not importing are named.
    const plain = commit(
        {
            sessions: [session('F', { lastSeq: 5 })],
            entries: [entry('F', 5)],
            chains: [chain('F')],
        },
        { entries: [entry('F', 2)] },
    )
    assert.ok(transitionViolations(plain).some((line) => /lock:/.test(line)))
})

test('rows at or below lastSeq, or a lastSeq that is not the highest created, are named (I-2)', () => {
    // A row filling a hole below lastSeq (the late Save of AR-1 and AR-2).
    const low = commit(
        { ...base(), entries: [entry('S', 1)] },
        { entries: [entry('S', 2, { kind: 'save' })] },
        { sessions: ['S'] },
    )
    assert.match(
        transitionViolations(low).join('\n'),
        /rows 2 of session S were created at or below its lastSeq 2/,
    )
    const gap = commit(
        base(),
        { entries: [entry('S', 3)], sessions: [session('S', { lastSeq: 5 })] },
        { sessions: ['S'] },
    )
    assert.match(
        transitionViolations(gap).join('\n'),
        /session S has lastSeq 5 after creating rows up to 3/,
    )
    const stale = commit(base(), { entries: [entry('S', 3)] }, { sessions: ['S'] })
    assert.match(
        transitionViolations(stale).join('\n'),
        /has lastSeq 2 after creating rows up to 3/,
    )
})

test('a session that is not its chain’s head changes only by kept flips (I-5)', () => {
    const frozen = {
        sessions: [session('S'), session('C', { chainId: 'c', lastSeq: 1 })],
        entries: [entry('S', 1), entry('S', 2)],
        chains: [chain('C')],
    }
    const flip = commit(frozen, { entries: [entry('S', 1, { kept: false })] })
    assert.deepEqual(transitionViolations(flip), [])
    const created = commit(frozen, { entries: [entry('S', 3)] }, { sessions: ['S'] })
    assert.match(transitionViolations(created).join('\n'), /no longer its chain's head, yet rows 3/)
    const rewritten = commit(frozen, { entries: [entry('S', 1, { kind: 'save' })] })
    assert.match(transitionViolations(rewritten).join('\n'), /row 1 of session S.* changed kind/)
    const summary = commit(frozen, { sessions: [session('S', { lastSeq: 3 })] })
    assert.match(transitionViolations(summary).join('\n'), /changed lastSeq/)
    const blocks = commit(frozen, { stackBlocks: [{ sessionId: 'S', block: 0 }] })
    assert.match(transitionViolations(blocks).join('\n'), /stack block 0 of session S/)
    // The head moves in the transaction that writes the continuation: the parent is not touched.
    const moved = commit(
        base(),
        {
            sessions: [session('C', { lastSeq: 1 })],
            entries: [entry('C', 1)],
            chains: [chain('C')],
        },
        { sessions: ['C'] },
    )
    assert.deepEqual(transitionViolations(moved), [])
})

test('a binding is recorded only while no session of the chain is importing (I-4)', () => {
    const importing = {
        sessions: [session('S', { importPending: true, origin: 'nxsp' })],
        chains: [chain('S', { revision: { id: 'r1' } })],
    }
    const bound = commit(importing, { chains: [chain('S', { revision: { id: 'r2' } })] })
    assert.match(
        transitionViolations(bound).join('\n'),
        /recorded a binding while session S was importing/,
    )
    const other = commit(importing, { chains: [chain('S', { revision: { id: 'r1' }, name: 'x' })] })
    assert.deepEqual(transitionViolations(other), [])
    const done = commit(
        { sessions: [session('S')], chains: [chain('S', { revision: { id: 'r1' } })] },
        { chains: [chain('S', { revision: { id: 'r2' } })] },
    )
    assert.deepEqual(transitionViolations(done), [])
})

test('the whole-store copy of Try Again is exempt', () => {
    const copy = commit(
        base(),
        { entries: [entry('S', 9)] },
        { sessions: [] },
        STORE_NAMES as readonly string[],
    )
    assert.deepEqual(transitionViolations(copy), [])
})

test('the world reports a flusher whose page holds no lock, and none when it holds it', async () => {
    for (const held of [false, true]) {
        const world = createWorld({ seed: 5, checks: { lock: true } })
        const page = await openPage(world, world.tab('a'))
        const id = testId()
        // A start with its own hold keeps it: this one holds nothing, or another’s name.
        const release = held ? world.locks.holdNow(page.tab.actor, sessionLock(id)) : undefined
        const first = stateOf(goldenChart())
        page.flusher.begin({
            id,
            docId: testId(),
            origin: 'import',
            state: first,
            operation: originOperation('import'),
            dirty: false,
            lock: leaseOf(() => release?.()),
        })
        // The first flush creates the session, which needs no lock; the next one does.
        await page.flusher.flush({ strict: true })
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
            widen(first),
            true,
        )
        await page.flusher.flush({ strict: true })
        if (held) await world.idle()
        else assert.match(world.violations[0] ?? '', /lock: rows 2 of session/)
    }
})

test('a worker’s transaction is judged by the locks of the page that owns it', async () => {
    for (const owned of [true, false]) {
        const world = createWorld({ seed: 6, checks: { lock: true } })
        const page = world.tab('page')
        const worker = world.tab('worker', owned ? { owner: page } : {})
        // The page holds the session’s lock, as the flusher’s page does; the worker writes.
        world.locks.holdNow(page.actor, sessionLock('S'))
        const core = workerCore(world, worker)
        await worker.run(() => core.start())
        const row = (lastSeq: number) => ({ id: 'S', chainId: 'c', lastSeq, entryCount: lastSeq })
        await worker.run(() =>
            core.write(['sessions', 'entries'], async (tx) => {
                await tx.put('sessions', row(1))
                await tx.put('entries', { sessionId: 'S', seq: 1, kind: 'init' })
            }),
        )
        assert.deepEqual(
            world.violations,
            [],
            'a transaction that creates the session needs no lock',
        )
        await worker.run(() =>
            core.write(['sessions', 'entries'], async (tx) => {
                await tx.put('sessions', row(2))
                await tx.put('entries', { sessionId: 'S', seq: 2, kind: 'edit' })
            }),
        )
        if (owned) assert.deepEqual(world.violations, [])
        else assert.match(world.violations[0] ?? '', /lock: rows 2 of session S/)
    }
})

test('an opened session’s import fills at or below the file’s last seq; the page’s own rows keep every rule (M3)', () => {
    const open = session('F', { origin: 'nxsp', importPending: true, lastSeq: 7, entryCount: 3 })
    const state = {
        sessions: [open],
        entries: [entry('F', 6), entry('F', 7)],
        chains: [chain('F')],
    }
    const fileEnd = new Map([['F', 5]])
    // The fill: rows at or below 5, no lock, no lastSeq.
    const fill = commit(state, { entries: [entry('F', 2), entry('F', 3)] })
    assert.deepEqual(transitionViolations(fill, {}, fileEnd), [])
    // The page's own row above the base, with the lock: ordinary.
    const own = commit(
        state,
        { entries: [entry('F', 8)], sessions: [{ ...open, lastSeq: 8 }] },
        { sessions: ['F'] },
    )
    assert.deepEqual(transitionViolations(own, {}, fileEnd), [])
    // Without the lock, below lastSeq, or with lastSeq left behind: each is named.
    const unlocked = commit(
        state,
        { entries: [entry('F', 8)], sessions: [{ ...open, lastSeq: 8 }] },
        { sessions: [] },
    )
    assert.match(
        transitionViolations(unlocked, {}, fileEnd).join('; '),
        /lock: rows 8 of session F/,
    )
    const below = commit(
        { ...state, entries: [entry('F', 6)] },
        { entries: [entry('F', 7)] },
        { sessions: ['F'] },
    )
    assert.match(
        transitionViolations(below, {}, fileEnd).join('; '),
        /rows 7 of session F were created at or below its lastSeq 7/,
    )
    const behind = commit(state, { entries: [entry('F', 9)] }, { sessions: ['F'] })
    assert.match(
        transitionViolations(behind, {}, fileEnd).join('; '),
        /has lastSeq 7 after creating rows up to 9/,
    )
    // With no base recorded, every row of the session counts as the fill (as before).
    assert.deepEqual(transitionViolations(unlocked, {}), [])
})

test('an opened session that is not the head keeps I-5 but for the import’s fill (M3)', () => {
    const open = session('F', { origin: 'nxsp', importPending: true, lastSeq: 7, entryCount: 3 })
    const state = {
        sessions: [open, session('K', { chainId: 'c', lastSeq: 1 })],
        entries: [entry('F', 6), entry('F', 7)],
        chains: [chain('K')],
    }
    const fileEnd = new Map([['F', 5]])
    const fill = commit(state, {
        entries: [entry('F', 3)],
        sessions: [{ ...open, entryCount: 4, ownBytes: 10 }],
    })
    assert.deepEqual(transitionViolations(fill, {}, fileEnd), [])
    const finished = commit(state, { sessions: [{ ...open, importPending: undefined }] })
    assert.deepEqual(transitionViolations(finished, {}, fileEnd), [])
    const rewritten = commit(state, {
        sessions: [{ ...open, lastSeq: 9, stack: { index: 1 } }],
        stackBlocks: [{ sessionId: 'F', block: 0 }],
    })
    const found = transitionViolations(rewritten, {}, fileEnd).join('; ')
    assert.match(found, /changed lastSeq, stack/)
    assert.match(found, /stack block 0 of session F/)
    const own = commit(state, { entries: [entry('F', 8)] }, { sessions: ['F'] })
    assert.match(transitionViolations(own, {}, fileEnd).join('; '), /yet rows 8 were created/)
})

test('a row removed while its session stays is named; a session deleted with its rows is not', () => {
    const report = commit(base(), {})
    const gone = (sessionStays: boolean): CommitReport => ({
        ...report,
        deletes: [{ store: 'entries', rows: [{ key: ['S', 2] as Key, value: entry('S', 2) }] }],
        current: (store, key) =>
            store === 'sessions' && !sessionStays ? undefined : report.current(store, key),
    })
    assert.match(
        transitionViolations(gone(true)).join('; '),
        /row \["S",n2\] of session S was removed while the session stays/,
    )
    assert.deepEqual(transitionViolations(gone(false)), [])
})

test('the whole-store exemption covers exactly the two writers that are meant to have it', () => {
    // A read-write transaction over every store is exempt from the transition check by its shape:
    // `copyIntoStorage` (Try Again's move) and `seedDump` (a sample into an empty database). A
    // third one would be exempt silently, so this lists them.
    const found: string[] = []
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name)
            if (entry.isDirectory()) walk(path)
            else if (
                path.endsWith('.ts') &&
                /\.transaction\(\s*(STORE_NAMES|names)\s*,\s*'readwrite'/.test(
                    readFileSync(path, 'utf8'),
                )
            )
                found.push(
                    path
                        .split(sep)
                        .join('/')
                        .replace(/^.*src\/local\//, ''),
                )
        }
    }
    walk(join(process.cwd(), 'src', 'local'))
    assert.deepEqual(found.sort(), ['seed.ts', 'worker/core.ts'])
})
