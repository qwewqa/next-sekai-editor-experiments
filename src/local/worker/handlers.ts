import { CHANNEL_NAME, broadcastChannel } from '../channel'
import { HANDLES, handleReadsForTests, readHandleRow, type HandleRole } from '../handleRows'
import { idbFactory } from '../kv/idb'
import { MemoryKv } from '../kv/memory'
import { hasWebLocks, webLockService } from '../locks'
import { Scheduler } from '../scheduler'
import { StorageCore, type StorageStatus, type TestFlags } from './core'
import type { CallScope } from './rpc'

// The storage worker's own RPC methods: start, status, Try Again, resume, and the test hooks
// the specs drive (only when a test flag was seeded). The flush package adds its methods beside
// these in storage.worker.ts.

export type InitOptions = {
    appVersion: string
    /** This browser's deviceId from localStorage, for the database's first meta row. */
    deviceId?: string
    flags: TestFlags
    /** Test hooks answer only when the page was started with a test flag. */
    test: boolean
}

export type WorkerContext = {
    /** The storage core; throws before init. */
    readonly core: StorageCore
    readonly test: boolean
    emit: (event: string, data?: unknown) => void
}

/** A chain's stored handle for its binding, Export target or kept file (D24). */
export const readHandle = (
    core: StorageCore,
    { chainId, role }: { chainId: string; role: HandleRole },
) => core.read(['chains', HANDLES], (tx) => readHandleRow(tx, chainId, role))

/** Ends this worker as a crash would, mid-operation: the page terminates and restarts it. */
const crash = (emit: WorkerContext['emit'], point: string) => {
    emit('testKill', point)
    // Synchronous, so the transaction in flight never commits before the page terminates us.
    for (;;) {
        /* wait to be terminated */
    }
}

const browserCore = (options: InitOptions, emit: WorkerContext['emit']) => {
    const scope = globalThis as {
        indexedDB?: IDBFactory
        navigator?: { storage?: { estimate?: () => Promise<StorageEstimate> } }
        crypto: Crypto
    }
    const storage = scope.navigator?.storage
    const fallback = new MemoryKv(new Scheduler())
    return new StorageCore({
        factory: scope.indexedDB && hasWebLocks() ? idbFactory(scope.indexedDB) : undefined,
        memory: () => fallback.factory(),
        channel: broadcastChannel(CHANNEL_NAME),
        locks: webLockService,
        appVersion: options.appVersion,
        deviceId: options.deviceId,
        randomId: () => scope.crypto.randomUUID(),
        estimate: storage?.estimate?.bind(storage),
        flags: options.flags,
        crash: (point) => {
            crash(emit, point)
        },
    })
}

export const createContext = (emit: WorkerContext['emit']) => {
    let core: StorageCore | undefined
    let test = false
    const context: WorkerContext = {
        get core() {
            if (!core) throw new Error('The storage worker has not started')
            return core
        },
        get test() {
            return test
        },
        emit,
    }
    const testOnly = () => {
        if (!test) throw new Error('Test hooks need a test flag')
    }
    const handlers = {
        /** Opens storage through the handshake; the status says what this tab can do. */
        init: async (options: InitOptions): Promise<StorageStatus> => {
            if (core) return core.status
            test = options.test
            core = browserCore(options, emit)
            core.onStatus((status) => {
                emit('status', status)
            })
            return core.start()
        },
        status: () => context.core.status,
        tryAgain: (_: undefined, scope?: CallScope) => context.core.tryAgain(scope),
        resume: () => context.core.resume(),

        /**
         * A chain's stored handle for its binding or Export target (D24): only when a Save, an
         * Export or a resumed import needs it, through the page's `handleOf`.
         */
        readHandle: (request: { chainId: string; role: HandleRole }) =>
            readHandle(context.core, request),

        /** Test: how many stored handles this worker has read. */
        testHandleReads: () => {
            testOnly()
            return handleReadsForTests()
        },
        /** Test: writes a meta row `test.<key>` and resolves once committed. */
        testPut: async ({ key, value }: { key: string; value: unknown }) => {
            testOnly()
            await context.core.write(
                ['meta'],
                (tx) => tx.put('meta', { key: `test.${key}`, value }),
                {
                    durability: 'strict',
                },
            )
        },
        /** Test: commits a meta row and asks the page to close at once, without waiting for it. */
        testPutUnacknowledged: ({ key, value }: { key: string; value: unknown }) => {
            testOnly()
            void context.core.write(['meta'], (tx) => tx.put('meta', { key: `test.${key}`, value }))
            return true
        },
        testGet: async (key: string) => {
            testOnly()
            const row = (await context.core.read(['meta'], (tx) =>
                tx.get('meta', `test.${key}`),
            )) as { value: unknown } | undefined
            return row?.value
        },
        /** Test: an uncaught error in the worker, as an out-of-memory crash shows. */
        testCrash: () => {
            testOnly()
            setTimeout(() => {
                throw new Error('Test crash')
            }, 0)
            return true
        },
        /** Test: a test point, as the flush package's are, killing the worker when armed. */
        testPoint: (name: string) => {
            testOnly()
            context.core.testPoint(name)
            return true
        },
        /** Test: a write that passes a test point after its first put, before it commits. */
        testPutThrough: async ({ key, point }: { key: string; point: string }) => {
            testOnly()
            await context.core.write(['meta'], async (tx) => {
                await tx.put('meta', { key: `test.${key}`, value: key })
                context.core.testPoint(point)
            })
        },
        /** Test: the script this worker runs from, to tell a Blob restart. */
        testLocation: () => {
            testOnly()
            return (globalThis as { location?: { href?: string } }).location?.href ?? ''
        },
    }
    return { context, handlers }
}

export type CoreHandlers = ReturnType<typeof createContext>['handlers']
