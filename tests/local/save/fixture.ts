import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateChunk, verifyChunk } from '../../../src/local/chunkVerify'
import { hashKey } from '../../../src/local/db'
import { mediaRow } from '../../../src/local/flushWrite'
import { fromHex16, toHex } from '../../../src/local/hash'
import { KeyRange } from '../../../src/local/kv/types'
import { inspectNxsp } from '../../../src/local/nxsp/inspect'
import { readNxsp } from '../../../src/local/nxsp/read'
import { putChunk } from '../../../src/local/putChunk'
import { toRecords } from '../../../src/local/records/records'
import { nodeRow, rootRow } from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import type { SaveStore } from '../../../src/local/save/bodies'
import type { SaveOptions, SaveTarget } from '../../../src/local/save/build'
import { commitIdentity, IDENTITY_STORES } from '../../../src/local/save/commit'
import {
    buildSave,
    fingerprintNow,
    type BuiltSave,
    type SaveSourceFile,
} from '../../../src/local/save/execute'
import { pendingInput } from '../../../src/local/save/pending'
import { createWorld, type Tab, type World } from '../../../src/local/testing/world'
import {
    BLOCK_SLOTS,
    blockRow,
    replay,
    ReplayError,
    storedWindow,
    type ReplaySlot,
} from '../../../src/local/timeline'
import type { State } from '../../../src/state'
import { workerCore } from '../flush/harness'
import { BGM, BGM_2, chartWith, COVER, COVER_2, PREVIEW, sha256Hex } from '../nxsp/helpers'
import { stateOf } from '../records/charts'

// Chains written straight into a test profile, as flushes and opens store them, and the Saves
// over them: what the history model's tests and the property test share.

export const DEVICE = { id: 'c3f00000-0000-4000-8000-000000000000', label: 'Web (Chrome)' }

const states = new Map<number, { state: State; hex: string }>()

/** The second media variant: states from `SECOND` on use the second BGM and cover. */
export const SECOND = 1000

/** State `k`: the golden chart with `k` extra notes (`k - SECOND` with the second media). */
export const stateAt = (k: number) => {
    let known = states.get(k)
    if (!known) {
        const state = stateOf(
            k >= SECOND
                ? chartWith({ extraNotes: k - SECOND, bgm: BGM_2, cover: COVER_2 })
                : chartWith({ extraNotes: k }),
        )
        known = { state, hex: toHex(encodeSnapshot(toRecords(state)).root.hash) }
        states.set(k, known)
    }
    return known
}

type Row = {
    sessionId: string
    seq: number
    time: number
    day: number
    kind: string
    label: string
    snapshot: Uint8Array
    noteCount: number
    dirty: boolean
    kept: boolean
    revisionId?: string
    device?: { id: string; label: string }
}

type FixtureSession = {
    id: string
    startedAt: number
    parent?: { id: string; uptoSeq: number }
    rows: Row[]
    slots: ReplaySlot[]
    index: number
    nextSeq: number
}

let ids = 0
const nextId = (prefix: string) => `${prefix}${String(++ids).padStart(4, '0')}`

/** A profile, its storage core and one chain being edited, written row by row. */
export class Fixture {
    readonly world: World
    readonly tab: Tab
    readonly store: SaveStore
    readonly chainId = nextId('chain-')
    readonly docId = nextId('doc-')
    sessions: FixtureSession[] = []
    private clock = 1_000_000
    private written = new Set<string>()
    private known = new Map<string, State>()

    private constructor(world: World, tab: Tab, store: SaveStore) {
        this.world = world
        this.tab = tab
        this.store = store
    }

    static async create(seed = 1) {
        const world = createWorld({ seed })
        const tab = world.tab('a')
        const core = workerCore(world, tab)
        await tab.run(() => core.start())
        const store: SaveStore = {
            read: (stores, fn) => tab.run(() => core.read(stores, fn)),
            write: (stores, fn, options) => tab.run(() => core.write(stores, fn, options)),
        }
        const fixture = new Fixture(world, tab, store)
        await fixture.putChain({ docId: fixture.docId, lineageId: 'lineage' })
        return fixture
    }

    get session() {
        const session = this.sessions.at(-1)
        if (!session) throw new Error('No session')
        return session
    }

    get head() {
        const { slots, index } = this.session
        return toHex((slots[index] as ReplaySlot).snapshot)
    }

    private now() {
        return (this.clock += 1000)
    }

    /** Starts a session: `init` with state `k`, or a continuation of the last one. */
    async start(k: number | State = 0) {
        const last = this.sessions.at(-1)
        const session: FixtureSession = {
            id: nextId('s-'),
            startedAt: this.now(),
            rows: [],
            slots: [],
            index: 0,
            nextSeq: 1,
        }
        if (last) {
            session.parent = { id: last.id, uptoSeq: last.nextSeq - 1 }
            session.slots = [...last.slots]
            session.index = last.index
        }
        this.sessions.push(session)
        if (last) this.add('continue', 'Continued', fromHex16(this.head))
        else {
            const { hex } = await (typeof k === 'number'
                ? this.body(k)
                : this.store_({ state: k, hex: toHex(encodeSnapshot(toRecords(k)).root.hash) }))
            session.slots = [{ snapshot: fromHex16(hex), label: 'Imported' }]
            this.add('init', 'Imported', fromHex16(hex))
        }
        return session
    }

    private add(kind: string, label: string, snapshot: Uint8Array, extra: Partial<Row> = {}) {
        const session = this.session
        const row: Row = {
            sessionId: session.id,
            seq: session.nextSeq++,
            time: this.now(),
            day: 1,
            kind,
            label,
            snapshot,
            noteCount: 0,
            dirty: false,
            kept: true,
            ...extra,
        }
        session.rows.push(row)
        return row
    }

    /** Stores state `k`'s bodies, once. */
    body(k: number) {
        return this.store_(stateAt(k))
    }

    /** Stores a state's bodies, once. */
    async store_(known: { state: State; hex: string }) {
        this.known.set(known.hex, known.state)
        if (this.written.has(known.hex)) return known
        const snapshot = encodeSnapshot(toRecords(known.state))
        const chunks = await Promise.all(
            [snapshot.header, ...snapshot.chunks].map((chunk) =>
                verifyChunk({
                    hash: chunk.hash,
                    stored: deflateChunk(chunk.bytes),
                    canonical: chunk.bytes,
                }),
            ),
        )
        await this.store.write(['nodes', 'chunks'], async (tx) => {
            await tx.put('nodes', rootRow(snapshot.root, 1), hashKey(snapshot.root.hash))
            for (const node of snapshot.nodes)
                await tx.put('nodes', nodeRow(node, 1), hashKey(node.hash))
            for (const chunk of chunks) await putChunk(tx, chunk, 1)
        })
        this.written.add(known.hex)
        return known
    }

    /** A state this fixture made, by its root's hex. */
    stateOf(hex: string) {
        const state = this.known.get(hex)
        if (!state) throw new Error(`No state ${hex}`)
        return state
    }

    /**
     * This tab's rows of the current session after `seq`, its live stack and their records, as
     * the page posts them while storing is paused (`pendingInput`).
     */
    pending(after: number) {
        const session = this.session
        return pendingInput(
            session.rows
                .filter((row) => row.seq > after)
                .map((row) => ({
                    seq: row.seq,
                    time: row.time,
                    kind: row.kind,
                    label: row.label,
                    dirty: row.dirty,
                    state: this.stateOf(toHex(row.snapshot)),
                    ...(row.revisionId === undefined ? {} : { revisionId: row.revisionId }),
                    ...(row.device ? { device: row.device } : {}),
                })),
            {
                base: 0,
                slots: session.slots.map((slot) => ({
                    state: this.stateOf(toHex(slot.snapshot)),
                    label: slot.label,
                })),
                index: session.index,
            },
        )
    }

    /** An edit to any state. */
    async editState(state: State, label: string) {
        const hex = toHex(encodeSnapshot(toRecords(state)).root.hash)
        await this.store_({ state, hex })
        this.push(hex, label)
    }

    private push(hex: string, label: string) {
        const session = this.session
        session.slots.length = session.index + 1
        session.slots.push({ snapshot: fromHex16(hex), label })
        session.index++
        this.add('edit', label, fromHex16(hex))
    }

    async edit(k: number, label = `Edit ${k}`) {
        const { hex } = await this.body(k)
        this.push(hex, label)
    }

    undo() {
        const session = this.session
        if (session.index <= 0) return false
        session.index--
        this.add('undo', 'Undo', fromHex16(this.head))
        return true
    }

    redo() {
        const session = this.session
        if (session.index >= session.slots.length - 1) return false
        session.index++
        this.add('redo', 'Redo', fromHex16(this.head))
        return true
    }

    /** Reserves the `save` entry's `seq` and time, as the Save does before its build. */
    reserveSave() {
        const session = this.session
        return {
            sessionId: session.id,
            seq: session.nextSeq++,
            time: this.now(),
            startedAt: session.startedAt,
        }
    }

    /** The `save` entry a write that binds appends to its session (stored at the next flush). */
    recordSave(built: BuiltSave, reserved: ReturnType<Fixture['reserveSave']>) {
        const session = this.sessions.find((each) => each.id === reserved.sessionId)
        if (!session) throw new Error('No session')
        session.rows.push({
            sessionId: session.id,
            seq: reserved.seq,
            time: reserved.time,
            day: 1,
            kind: 'save',
            label: built.saveEntry.label,
            snapshot: fromHex16(built.saveEntry.snapshot),
            noteCount: built.saveEntry.noteCount,
            dirty: false,
            kept: true,
            revisionId: built.revisionId,
            device: DEVICE,
        })
    }

    /** Writes every session's rows, its row and stack, and the chain's head. */
    async flush() {
        await this.store.write(['sessions', 'entries', 'stackBlocks', 'chains'], async (tx) => {
            for (const session of this.sessions) {
                const window = storedWindow(session.slots.length, session.index)
                await tx.put('sessions', {
                    id: session.id,
                    chainId: this.chainId,
                    startedAt: session.startedAt,
                    updatedAt: session.rows.at(-1)?.time ?? session.startedAt,
                    day: 1,
                    origin: session.parent ? 'continued' : 'import',
                    ...(session.parent ? { parent: session.parent } : {}),
                    stack: window,
                    lastSeq: session.rows.at(-1)?.seq ?? 0,
                    entryCount: session.rows.length,
                    appVersion: '0.6.0',
                })
                for (const row of session.rows) {
                    const stored = await tx.get('entries', [row.sessionId, row.seq])
                    // Stored rows keep their own `kept`: a mark is one-way.
                    if (!stored) await tx.put('entries', row)
                }
                for (let first = window.base; first < window.base + window.length;) {
                    const block = Math.floor(first / BLOCK_SLOTS)
                    const end = Math.min((block + 1) * BLOCK_SLOTS, window.base + window.length)
                    await tx.put(
                        'stackBlocks',
                        blockRow(session.id, block, first, session.slots.slice(first, end)),
                    )
                    first = end
                }
            }
            const chain = (await tx.get('chains', this.chainId)) as Record<string, unknown>
            await tx.put('chains', { ...chain, head: this.session.id })
        })
    }

    async putChain(fields: Record<string, unknown>) {
        await this.store.write(['chains'], async (tx) => {
            const chain = ((await tx.get('chains', this.chainId)) ?? {}) as Record<string, unknown>
            await tx.put('chains', { ...chain, ...fields, chainId: this.chainId })
        })
    }

    async chain() {
        return (await this.store.read(['chains'], (tx) =>
            tx.get('chains', this.chainId),
        )) as Record<string, unknown>
    }

    async entries() {
        return (await this.store.read(['entries'], (tx) =>
            tx.getAll('entries', KeyRange.bound(['', -Infinity], ['￿', Infinity])),
        )) as Row[]
    }

    /**
     * Cleanup under pressure, as Step 10's: a row whose state nothing else needs is made
     * `kept: false` and its root removed. False when another row or a slot still needs it.
     */
    async thin(sessionIndex: number, rowIndex: number) {
        const row = this.sessions[sessionIndex]?.rows[rowIndex]
        if (!row) return false
        const hex = toHex(row.snapshot)
        const needed = this.sessions.some(
            (session) =>
                session.rows.some(
                    (other) => other !== row && other.kept && toHex(other.snapshot) === hex,
                ) || session.slots.some((slot) => toHex(slot.snapshot) === hex),
        )
        if (needed) return false
        row.kept = false
        await this.store.write(['entries', 'nodes'], async (tx) => {
            const stored = (await tx.get('entries', [row.sessionId, row.seq])) as Row | undefined
            if (stored) await tx.put('entries', { ...stored, kept: false })
            await tx.delete('nodes', hashKey(row.snapshot))
        })
        this.written.delete(hex)
        return true
    }

    /** Deletes a session and its rows, as Delete Sessions… does. */
    async deleteSession(index: number) {
        const [session] = this.sessions.splice(index, 1)
        if (!session) return
        await this.store.write(['sessions', 'entries', 'stackBlocks'], async (tx) => {
            await tx.delete('sessions', session.id)
            await tx.delete(
                'entries',
                KeyRange.bound([session.id, -Infinity], [session.id, Infinity]),
            )
            await tx.delete(
                'stackBlocks',
                KeyRange.bound([session.id, -Infinity], [session.id, Infinity]),
            )
        })
    }

    /** Stores the shared media items, as a flush does. */
    async storeMedia(items = [BGM, COVER, PREVIEW]) {
        await this.store.write(['media'], async (tx) => {
            for (const item of items)
                await tx.put(
                    'media',
                    mediaRow(
                        {
                            hash: item.ref.hash,
                            bytes: item.bytes.slice().buffer,
                            type: item.ref.type,
                            filename: item.ref.filename,
                            kind: item === BGM || item === BGM_2 ? 'bgm' : 'cover',
                            sha256: hexBytes(item.sha256),
                        },
                        1,
                    ),
                    hashKey(fromHex16(item.ref.hash)),
                )
        })
    }
}

const hexBytes = (hex: string) =>
    Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16))

/** A file on "disk" with its time, as the platform pins it. */
export type DiskFile = { name: string; blob: Blob; lastModified: number }

let clock = 1_700_000_000_000

export const asFile = (blob: Blob, name = 'coconut.nxsp') =>
    new File([blob], name, { lastModified: (clock += 1000) })

export const sourceOf = async (file: File, token = 'target'): Promise<SaveSourceFile> => ({
    token,
    role: 'target',
    file,
    fingerprint: await fingerprintNow(file),
})

let revisions = 0

export const saveOptions = (fixture: Fixture, extra: Partial<SaveOptions> = {}) => {
    const reserved = fixture.reserveSave()
    const options: SaveOptions = {
        history: true,
        bgm: true,
        fileName: 'coconut.nxsp',
        save: { time: reserved.time, label: 'Saved coconut.nxsp' },
        context: {
            now: Date.UTC(2026, 9, 16, 5, 41, 7),
            newId: () => `r${String(++revisions).padStart(3, '0')}-0000-4000-8000-000000000000`,
            device: DEVICE,
            appVersion: '0.6.0',
        },
        ...extra,
    }
    return { options, reserved }
}

/**
 * A Save over the fixture's chain, as the Save package runs one: the `save` entry reserved, the
 * build, and for a write that binds, its entry and the identity unit committed after it.
 */
export const save = async (
    fixture: Fixture,
    target: SaveTarget,
    {
        files = [],
        binds = true,
        event = 'saved',
        extra = {},
        disk,
    }: {
        files?: SaveSourceFile[]
        binds?: boolean
        event?: 'saved' | 'downloaded'
        extra?: Partial<SaveOptions>
        disk?: (file: File) => Promise<Record<string, unknown> | undefined>
    } = {},
) => {
    const { options, reserved } = saveOptions(fixture, extra)
    const built = await buildSave(fixture.store, fixture.chainId, target, options, files)
    if ('refused' in built) return { built, file: undefined }
    const file = asFile(built.blob)
    if (binds) await commit(fixture, built, reserved, options, { event, disk: await disk?.(file) })
    return { built, file }
}

/** What a Save that binds commits after its write: its `save` entry, then the identity unit. */
export const commit = async (
    fixture: Fixture,
    built: BuiltSave,
    reserved: ReturnType<Fixture['reserveSave']>,
    options: SaveOptions,
    { event, disk }: { event: 'saved' | 'downloaded'; disk?: Record<string, unknown> },
) => {
    fixture.recordSave(built, reserved)
    await fixture.flush()
    const { identity } = built
    const committed = await fixture.store.write(IDENTITY_STORES, (tx) =>
        commitIdentity(tx, fixture.chainId, {
            docId: identity.docId,
            revision: identity.revision,
            file: bindingOf(built, reserved, options, { event, disk }),
            marks: identity.marks,
        }),
    )
    assert.equal(committed, true)
}

/** The binding a write's identity unit stores (§1.6.11.2). */
export const bindingOf = (
    built: BuiltSave,
    reserved: ReturnType<Fixture['reserveSave']>,
    options: SaveOptions,
    { event, disk }: { event: 'saved' | 'downloaded'; disk?: Record<string, unknown> },
) => {
    const { identity } = built
    return {
        name: 'coconut.nxsp',
        event,
        at: reserved.time,
        hash: fromHex16(built.saveEntry.snapshot),
        ...(identity.entry
            ? {
                  entry: {
                      sessionId: reserved.sessionId,
                      seq: reserved.seq,
                      startedAt: reserved.startedAt,
                      ...identity.entry,
                  },
              }
            : {}),
        ...(identity.completeFrom === undefined ? {} : { completeFrom: identity.completeFrom }),
        ...(disk ? { disk } : {}),
        options: { history: options.history, bgm: options.bgm },
    }
}

/** A written file's rows with their states (§1.6.11.6): `kind|time|snapshot` → count, held only. */
export const heldRows = async (blob: Blob) => {
    const read = await readNxsp(blob)
    if (read.kind !== 'nxsp' || !read.history) throw new Error('No history')
    const rows = new Map<string, number>()
    const { roots } = read.history
    for (const entry of read.history.entries) {
        if (!roots.has(entry.snapshot)) continue
        const key = `${entry.kind}|${entry.time}|${entry.snapshot}`
        rows.set(key, (rows.get(key) ?? 0) + 1)
    }
    return { rows, read, history: read.history }
}

export { inspectNxsp, sha256Hex }

const repo = join(import.meta.dirname, '..', '..', '..')

/** Whether the independent checker can run: `uv` on the machine (CI installs it). */
export const hasUv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0

/**
 * Runs `tools/nxsp_check.py` over files in order (oldest first), which also checks each file's
 * `completeFrom` against every earlier file it names (§1.6.11.9). Returns its status and output.
 */
export const checkFiles = async (files: readonly Blob[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'nse-save-'))
    try {
        const paths: string[] = []
        for (const [i, file] of files.entries()) {
            const path = join(dir, `${String(i).padStart(3, '0')}.nxsp`)
            writeFileSync(path, new Uint8Array(await file.arrayBuffer()))
            paths.push(path)
        }
        const result = spawnSync(
            'uv',
            ['run', 'python', '-I', join(repo, 'tools', 'nxsp_check.py'), ...paths],
            {
                encoding: 'utf8',
            },
        )
        return { status: result.status, output: `${result.stdout}${result.stderr}` }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

/**
 * "Replay defines the stack" (§1.3.9) for a written file: its undo stack is a window of replay of
 * its own chronology, numbered from its first entry; when replay can't follow the chronology (a
 * session removed from its middle), the stack is the head alone.
 */
export const checkStack = async (blob: Blob) => {
    const { history } = await heldRows(blob)
    const { undoStack } = history
    const entries = history.entries.map((entry, seq) => ({
        seq,
        kind: entry.kind,
        label: entry.label,
        snapshot: fromHex16(entry.snapshot),
        ...(entry.stack
            ? {
                  stack: {
                      keep: entry.stack.keep,
                      push: entry.stack.push.map((slot) => ({
                          snapshot: fromHex16(slot.snapshot),
                          label: slot.label,
                      })),
                      index: entry.stack.index,
                  },
              }
            : {}),
    }))
    let replayed: ReturnType<typeof replay> | undefined
    try {
        replayed = replay(entries)
    } catch (error) {
        if (!(error instanceof ReplayError)) throw error
    }
    if (!replayed) {
        assert.equal(undoStack.slots.length, 1, 'a stack replay cannot follow is the head alone')
        assert.equal(undoStack.base, 0)
        assert.equal(undoStack.index, 0)
        assert.equal(undoStack.slots[0]?.snapshot, history.entries.at(-1)?.snapshot)
        return 'head'
    }
    const { slots, index } = replayed
    assert.equal(undoStack.index, index, 'the stack’s index is replay’s')
    for (const [i, slot] of undoStack.slots.entries()) {
        const expected: ReplaySlot | undefined = slots[undoStack.base + i]
        assert.ok(expected, `slot ${undoStack.base + i} is outside replay’s stack`)
        assert.equal(slot.snapshot, toHex(expected.snapshot))
    }
    return 'replay'
}
