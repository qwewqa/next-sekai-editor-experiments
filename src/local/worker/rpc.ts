// The storage worker's small typed RPC (Part 1 §1.6.5). Payloads are structured clones; buffers
// marked with transfer() move rather than copy. The worker can also emit events to the page.

/** Both ends of a dedicated worker. */
export type Endpoint = {
    postMessage: (message: unknown, transfer: Transferable[]) => void
    onmessage: ((event: MessageEvent) => void) | null
}

/** A call as its handler sees it: work done for it counts as its progress (§1.6.5). */
export type CallScope = { readonly id: number; readonly tick: () => void }

type Handler = (arg: never, scope: CallScope) => unknown
export type Handlers = Record<string, Handler>

type Call = { id: number; method: string; arg: unknown }
type Reply =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; error: { name: string; message: string } }
type Emitted = { event: string; data: unknown }

const TRANSFER = Symbol('transfer')
type Marked<T> = { [TRANSFER]: Transferable[]; value: T }

/** A value whose buffers are transferred, from either end. */
export const transfer = <T>(value: T, list: Transferable[]): T =>
    ({ [TRANSFER]: list, value }) as unknown as T

const unmark = (value: unknown): [unknown, Transferable[]] =>
    typeof value === 'object' && value !== null && TRANSFER in value
        ? [(value as Marked<unknown>).value, (value as Marked<unknown>)[TRANSFER]]
        : [value, []]

/** An error from the other end, keeping its name (QuotaExceededError, StoragePausedError, …). */
export class RpcError extends Error {
    constructor(name: string, message: string) {
        super(message)
        this.name = name
    }
}

/** The built-in method that answers a call's progress count, or undefined once it's done. */
export const PING = 'ping'

/** Serves handlers on the worker's end; returns emit for events. */
export const serve = (endpoint: Endpoint, handlers: Handlers) => {
    // Each running call's own progress, so another busy call can't keep a hung one alive.
    const progress = new Map<number, number>()
    endpoint.onmessage = (event) => {
        const { id, method, arg } = event.data as Call
        if (method === PING) {
            endpoint.postMessage({ id, ok: true, value: progress.get(arg as number) }, [])
            return
        }
        progress.set(id, 0)
        const scope: CallScope = {
            id,
            tick: () => {
                const count = progress.get(id)
                if (count !== undefined) progress.set(id, count + 1)
            },
        }
        void (async () => {
            let reply: Reply
            let list: Transferable[] = []
            try {
                const handler = handlers[method]
                if (!handler) throw new RpcError('NotFoundError', `No method ${method}`)
                const [value, transferList] = unmark(await handler(arg as never, scope))
                reply = { id, ok: true, value }
                list = transferList
            } catch (error) {
                const { name, message } = error instanceof Error ? error : new Error(String(error))
                reply = { id, ok: false, error: { name, message } }
            } finally {
                progress.delete(id)
            }
            endpoint.postMessage(reply, list)
        })()
    }
    return (event: string, data?: unknown) => {
        const [value, list] = unmark(data)
        endpoint.postMessage({ event, data: value } satisfies Emitted, list)
    }
}

export type CallOptions = {
    /** Exempt from the timeout: builds, imports and other long jobs. */
    bulk?: boolean
    /** Another timeout than the client's. */
    timeoutMs?: number
    /** Called with the call's id once it is posted, for its watchdog's pings. */
    sent?: (id: number) => void
}

/** A handler's argument, optional when it takes none. */
type Args<F extends Handler> =
    Parameters<F> extends [] | [arg: undefined, scope: CallScope]
        ? [arg?: undefined, options?: CallOptions]
        : [arg: Parameters<F>[0], options?: CallOptions]

export type Client<H extends Handlers> = {
    call: <K extends keyof H & string>(
        method: K,
        ...args: Args<H[K]>
    ) => Promise<Awaited<ReturnType<H[K]>>>
    on: (event: string, listener: (data: unknown) => void) => () => void
    /** Rejects every pending call, as when the worker is replaced. */
    fail: (error: Error) => void
}

/** The page's end. A non-bulk call unanswered within timeoutMs calls onTimeout and rejects. */
export const connect = <H extends Handlers>(
    endpoint: Endpoint,
    { timeoutMs = 10_000, onTimeout }: { timeoutMs?: number; onTimeout?: () => void } = {},
): Client<H> => {
    let next = 0
    type Pending = {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timer?: ReturnType<typeof setTimeout>
    }
    const pending = new Map<number, Pending>()
    const listeners = new Map<string, Set<(data: unknown) => void>>()
    endpoint.onmessage = (event) => {
        const message = event.data as Reply | Emitted
        if ('event' in message) {
            for (const listener of listeners.get(message.event) ?? []) listener(message.data)
            return
        }
        const call = pending.get(message.id)
        if (!call) return
        pending.delete(message.id)
        clearTimeout(call.timer)
        if (message.ok) call.resolve(message.value)
        else call.reject(new RpcError(message.error.name, message.error.message))
    }
    return {
        call: (method, ...[arg, options]) =>
            new Promise((resolve, reject) => {
                const id = next++
                const entry: Pending = {
                    resolve: resolve as (value: unknown) => void,
                    reject,
                }
                if (!options?.bulk)
                    entry.timer = setTimeout(() => {
                        pending.delete(id)
                        reject(new RpcError('TimeoutError', `${method} was not answered`))
                        onTimeout?.()
                    }, options?.timeoutMs ?? timeoutMs)
                pending.set(id, entry)
                const [value, list] = unmark(arg)
                endpoint.postMessage({ id, method, arg: value } satisfies Call, list)
                options?.sent?.(id)
            }),
        on: (event, listener) => {
            let set = listeners.get(event)
            if (!set) listeners.set(event, (set = new Set()))
            set.add(listener)
            return () => set.delete(listener)
        },
        fail: (error) => {
            for (const call of pending.values()) {
                clearTimeout(call.timer)
                call.reject(error)
            }
            pending.clear()
        },
    }
}
