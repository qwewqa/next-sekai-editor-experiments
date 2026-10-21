import { HANDLES, type HandleRole } from '../../../src/local/handleRows'
import { createWorld as createCoreWorld, type Tab } from '../../../src/local/testing/world'
import { bindHandlers } from '../../../src/local/worker/bindHandlers'
import type { StorageCore } from '../../../src/local/worker/core'
import { readHandle } from '../../../src/local/worker/handlers'
import { originOperation } from '../../helpers/historySteps'
import { openPage } from '../../local/flush/harness'
import { chartState } from '../chartFixture'

// The matrix's storage door (E2, work/arch/spec-E.md): the worker methods that read and write a
// chain's record and its stored handles run the real handlers over a page core on `MemoryKv`.
// The world keeps its other worker methods as fakes, each with a reason at its case in world.ts.

type Row = Record<string, unknown>

/** What the door needs of a matrix world (its type would make this module and `world.ts` circular). */
export type DoorWorld = {
    chains: Map<string, Row>
    handleRows: Map<string, FileSystemFileHandle>
    worker: { call: (method: string, arg?: unknown) => Promise<unknown> }
    fire: (point: string, arg?: unknown) => Promise<void>
    behaviour: Map<string, (n: number, arg: unknown) => unknown>
    /** Door calls in flight; the harness waits for 0 instead of for a time. */
    doorBusy: number
    /** The chain records as the store holds them (set by `useRealDoor`), not the maps above. */
    storedChains: () => Promise<Row[]>
}

/** The worker methods the matrix sends to the real handlers; every other method stays the world's fake. */
export const REAL_DOOR: ReadonlySet<string> = new Set([
    'readChainRecord',
    'listHandleOwners',
    'readHandle',
    'keepHandle',
    'takeOver',
    'applyRevocation',
    'unlinkChain',
])

/** The state every seeded session starts from: the rows are what the cells need, not the chart. */
const seedState = chartState([[]])

type Kept = { chainId: string; name: string; handle: FileSystemFileHandle }

/**
 * Puts the real door under a matrix world: seeds the store from the world's chains, handle rows and
 * kept rows; routes each REAL_DOOR call through the world's fault table first (its own per-method
 * call counter), then the real handler; syncs the world's maps back after every call. Handles cross
 * as tokens (a mock handle holds functions, which MemoryKv cannot clone) and come back as a new
 * object on every read.
 */
export const useRealDoor = async (
    world: DoorWorld,
    kept: readonly Kept[] = [],
): Promise<{ core: StorageCore; tab: Tab }> => {
    // `blobTasks: false`: the matrix's timings were tuned without the browser-like Blob latency, and
    // the option keeps the patch off `Blob.prototype` for the whole process.
    const core = createCoreWorld({ blobTasks: false, checks: false })
    const tab = core.tab('page')
    const ids: string[] = []
    let extra = 0
    const page = await openPage(core, tab, { newId: () => ids.shift() ?? `door-${extra++}` })
    const context = { core: page.core, test: true, emit: () => undefined }
    // `readHandle` is the handler `createContext` serves (its `init` builds a browser core the Node
    // test cannot start), exported from handlers.ts and called on the page core.
    const real: Record<string, (arg: unknown) => Promise<unknown>> = {
        ...bindHandlers(context),
        readHandle: (request: { chainId: string; role: HandleRole }) =>
            readHandle(page.core, request),
    } as never

    // A mock handle holds functions, which no store can clone (a real handle can): it crosses the
    // door as a token, and every read of it hands out a new object, as IndexedDB's structured
    // clone does (E-3).
    const tokens = new Map<unknown, { token: string }>()
    const originals = new Map<string, FileSystemFileHandle>()
    const toToken = (handle: FileSystemFileHandle) => {
        let token = tokens.get(handle)
        if (!token) {
            token = { token: `h${tokens.size}` }
            tokens.set(handle, token)
            originals.set(token.token, handle)
        }
        return token
    }
    const isToken = (value: unknown): value is { token: string } =>
        typeof value === 'object' && value !== null && 'token' in value
    const original = (value: unknown) => (isToken(value) ? originals.get(value.token) : undefined)
    const fresh = (value: unknown) => {
        const handle = original(value)
        return handle ? Object.assign(Object.create(null), handle) : value
    }
    const tokenise = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(tokenise)
        if (
            !value ||
            typeof value !== 'object' ||
            value instanceof Uint8Array ||
            value instanceof Blob
        )
            return value
        const out: Row = {}
        for (const [key, inner] of Object.entries(value as Row))
            out[key] =
                key === 'handle' && inner && typeof inner === 'object'
                    ? toToken(inner as FileSystemFileHandle)
                    : tokenise(inner)
        return out
    }

    // Seeding is real writes. A chain's record and its binding or Export target, with their handle
    // rows, are what the flusher's first write stores (`setChainFields`); a kept file is what
    // `keepHandle` stores. The flusher is the page's own, so a session's rows are real too.
    const seeds = [...world.chains.values()] as Row[]
    for (const record of seeds) {
        const { chainId, docId, head, ...fields } = record
        for (const role of ['file', 'exportTarget'] as const) {
            const handle = world.handleRows.get(`${String(chainId)}:${role}`)
            if (handle && fields[role])
                fields[role] = { ...(fields[role] as Row), handle: toToken(handle) }
        }
        ids.push(String(chainId), `lineage-${String(chainId)}`)
        page.flusher.begin({
            id: typeof head === 'string' ? head : `session-${String(chainId)}`,
            docId: String(docId),
            origin: 'new',
            state: seedState,
            operation: originOperation('new'),
            dirty: false,
        })
        const stored = await tab.run(() => page.flusher.setChainFields(fields))
        if (!stored) throw new Error(`The door could not store ${String(chainId)}`)
    }
    for (const row of kept) {
        const done = await tab.run(() =>
            real.keepHandle!({ chainId: row.chainId, name: row.name, handle: toToken(row.handle) }),
        )
        if (done !== true) throw new Error(`The door could not keep ${row.name}`)
    }

    // The invariants judge this, the store itself; the maps are only the view the fakes read.
    world.storedChains = async () =>
        tab.run(() =>
            page.core.read(['chains'], async (tx) => (await tx.getAll('chains')) as Row[]),
        )

    const syncBack = async () => {
        const dump = await tab.run(() =>
            page.core.read(['chains', HANDLES], async (tx) => ({
                chains: (await tx.getAll('chains')) as Row[],
                handles: (await tx.getAll(HANDLES)) as Row[],
            })),
        )
        world.chains.clear()
        for (const record of dump.chains) world.chains.set(String(record.chainId), record)
        world.handleRows.clear()
        for (const row of dump.handles)
            world.handleRows.set(
                `${String(row.chainId)}:${String(row.role)}`,
                original(row.handle)!,
            )
    }
    await syncBack()

    const fake = world.worker.call
    const calls = new Map<string, number>()
    world.worker.call = async (method: string, arg?: unknown) => {
        if (!REAL_DOOR.has(method)) return fake(method, arg)
        world.doorBusy++
        try {
            return await viaDoor(method, arg)
        } finally {
            world.doorBusy--
        }
    }
    const viaDoor = async (method: string, arg?: unknown) => {
        await world.fire(`worker:${method}`, arg)
        // A fault fires before the real handler, so a faulted call stores nothing (E-4).
        const n = (calls.get(method) ?? 0) + 1
        calls.set(method, n)
        const how = world.behaviour.get(method)?.(n, arg)
        if (how === 'throw') throw new Error(`The storage worker restarted (${method} #${n})`)
        const result = await tab.run(() => real[method]!(tokenise(arg)))
        await syncBack()
        const out = method === 'readHandle' ? fresh(result) : result
        await world.fire(`worker:${method}:after`, out)
        return out
    }
    return { core: page.core, tab }
}
