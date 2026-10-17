import type { StorageStatus } from './core'
import type { InitOptions } from './handlers'
import { connect, RpcError, type CallOptions, type Client } from './rpc'
import type { StorageHandlers } from './storage.worker'

// The page's end of the storage worker (Part 1 §1.6.5). It watches onerror and unanswered calls
// (10 s, non-bulk, longer for calls that carry more work) and restarts the worker from a Blob URL
// of its script fetched at startup, so a later deploy can't 404 it. An unanswered call first
// pings the worker: one that answers and has made progress is slow, not hung, and is waited for.
// The session locks live on the page, so a restart loses none; the flush re-sends its pending
// entries on `restarted`. A restart that fails pauses storing.

export type WorkerScript = {
    url: string
    /** module on the dev server, classic (iife) in builds. */
    type: WorkerType
    /** Whether a restart may use the Blob copy: a module worker's imports can't resolve from blob:. */
    blobRestart: boolean
}

type Listener<T> = (value: T) => void

const INIT_TIMEOUT_MS = 30_000

/** A call's timeout when none is given. */
const CALL_TIMEOUT_MS = 10_000
/** How long the ping that asks a busy worker for its progress may take. */
const PROBE_MS = 5000

/** Restarts allowed within a minute before storing pauses for good. */
const MAX_RESTARTS = 3

export class StorageWorker {
    private worker: Worker | undefined
    private client: Client<StorageHandlers> | undefined
    private ready: Promise<void> | undefined
    private blobUrl: Promise<string | undefined> | undefined
    private restarts: number[] = []
    private generation = 0
    private restartSeq = 0
    private dead = false
    private current: StorageStatus | undefined
    private readonly statusListeners = new Set<Listener<StorageStatus>>()
    private readonly restartListeners = new Set<Listener<number>>()
    /** How many times the worker was restarted, and from which URLs. */
    readonly started: string[] = []

    constructor(
        private readonly script: WorkerScript,
        private readonly init: InitOptions,
        private readonly options: { timeoutMs?: number } = {},
    ) {}

    get status() {
        return this.current
    }

    /** Starts the worker and storage; keeps the script's Blob copy for restarts. */
    start(): Promise<StorageStatus> {
        if (this.script.blobRestart) this.blobUrl = this.fetchScript()
        const starting = this.launch(this.script.url)
        this.ready = starting.then(
            () => undefined,
            () => undefined,
        )
        return starting
    }

    onStatus(listener: Listener<StorageStatus>) {
        this.statusListeners.add(listener)
        return () => this.statusListeners.delete(listener)
    }

    /** After a restart: reset the identity memo and re-send pending entries. */
    onRestart(listener: Listener<number>) {
        this.restartListeners.add(listener)
        return () => this.restartListeners.delete(listener)
    }

    /**
     * A call to the worker; waits through a restart in progress. `current` refuses a call made
     * for the worker before it, once the restart is through (the flush plans it again).
     */
    async call<K extends keyof StorageHandlers>(
        method: K,
        arg?: Parameters<StorageHandlers[K]>[0],
        options?: CallOptions & { current?: () => boolean },
    ): Promise<Awaited<ReturnType<StorageHandlers[K]>>> {
        await this.ready
        const client = this.client
        if (this.dead || !client)
            throw new RpcError('WorkerFailedError', 'The storage worker stopped')
        if (options?.current && !options.current())
            throw new RpcError('WorkerRestartedError', 'Made for the worker before a restart')
        const call = client.call as (
            method: string,
            arg: unknown,
            options?: CallOptions,
        ) => Promise<Awaited<ReturnType<StorageHandlers[K]>>>
        if (options?.bulk) return call(method, arg, { bulk: true })
        return this.watch(
            call(method, arg, { bulk: true }),
            options?.timeoutMs ?? this.options.timeoutMs ?? CALL_TIMEOUT_MS,
            client,
        )
    }

    /**
     * A call's watchdog: unanswered within its timeout, the worker is pinged for its progress
     * count. Answering with progress since the last ping, it's slow, not hung, and is waited for
     * again (the first ping only has to answer); otherwise it's restarted. So a long write that
     * keeps moving is never cut off.
     */
    private watch<T>(reply: Promise<T>, ms: number, client: Client<StorageHandlers>): Promise<T> {
        const generation = this.generation
        return new Promise<T>((resolve, reject) => {
            let done = false
            let timer: ReturnType<typeof setTimeout> | undefined
            let last: number | undefined
            const check = async () => {
                let progress: number | undefined
                try {
                    progress = await client.call('ping', undefined, {
                        timeoutMs: Math.min(PROBE_MS, ms),
                    })
                } catch {
                    progress = undefined
                }
                if (done) return
                if (progress !== undefined && progress !== last) {
                    last = progress
                    timer = setTimeout(() => void check(), ms)
                    return
                }
                done = true
                reject(new RpcError('TimeoutError', 'The storage worker stopped answering'))
                this.restart(generation)
            }
            timer = setTimeout(() => void check(), ms)
            reply.then(
                (value) => {
                    done = true
                    clearTimeout(timer)
                    resolve(value)
                },
                (error: unknown) => {
                    done = true
                    clearTimeout(timer)
                    reject(error instanceof Error ? error : new Error(String(error)))
                },
            )
        })
    }

    private setStatus(status: StorageStatus) {
        this.current = status
        for (const listener of [...this.statusListeners]) listener(status)
    }

    private async fetchScript() {
        try {
            const response = await fetch(this.script.url)
            if (!response.ok) return
            return URL.createObjectURL(await response.blob())
        } catch {
            return
        }
    }

    private launch(url: string): Promise<StorageStatus> {
        const generation = ++this.generation
        const worker = new Worker(url, { type: this.script.type, name: 'nse-storage' })
        this.worker = worker
        this.started.push(url)
        const client = connect<StorageHandlers>(worker, {
            timeoutMs: this.options.timeoutMs,
            onTimeout: () => {
                this.restart(generation)
            },
        })
        this.client = client
        worker.addEventListener('error', (event) => {
            event.preventDefault()
            this.restart(generation)
        })
        client.on('status', (status) => {
            if (generation === this.generation) this.setStatus(status as StorageStatus)
        })
        client.on('testKill', () => {
            this.restart(generation)
        })
        // The handshake bounds its own waits (about 3 s blocked, 8 s at most per open).
        return client.call('init', this.init, { timeoutMs: INIT_TIMEOUT_MS }).then((status) => {
            if (generation === this.generation) this.setStatus(status)
            return status
        })
    }

    /** Replaces a crashed or hung worker, once per crash. */
    private restart(generation: number) {
        if (generation !== this.generation || this.dead) return
        this.worker?.terminate()
        this.client?.fail(new RpcError('WorkerRestartedError', 'The storage worker restarted'))
        this.worker = undefined
        this.client = undefined
        this.ready = this.relaunch(++this.restartSeq)
    }

    private async relaunch(seq: number) {
        const now = Date.now()
        this.restarts = [...this.restarts.filter((time) => now - time < 60_000), now]
        if (this.restarts.length > MAX_RESTARTS) {
            this.die()
            return
        }
        const url = (await this.blobUrl) ?? this.script.url
        try {
            await this.launch(url)
        } catch {
            // A newer restart took over, or this one failed for good.
            if (seq === this.restartSeq) this.die()
            return
        }
        for (const listener of [...this.restartListeners]) listener(this.restarts.length)
    }

    private die() {
        this.dead = true
        this.worker?.terminate()
        this.worker = undefined
        this.client = undefined
        this.setStatus({ mode: this.current?.mode ?? 'stored', reason: 'failed' })
    }
}
