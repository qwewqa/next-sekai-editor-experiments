// The usage statistics' sender: a bounded queue and the rules for when and how it goes to Umami's
// /api/batch. It takes its browser functions as arguments, so the rules run in Node tests.

/** One Umami send body; a pageview is an event with no name. */
export type Item = {
    type: 'event'
    payload: {
        website: string
        hostname: string
        screen: string
        language: string
        url: string
        title: string
        referrer: string
        /** When it was captured, in Unix seconds. */
        timestamp: number
        name?: string
        data?: Record<string, unknown>
    }
}

export type SenderEnv = {
    /** `<origin>/api/batch`. */
    url: string
    fetch: (url: string, init: RequestInit) => Promise<Response>
    sendBeacon: ((url: string, body: string) => boolean) | undefined
    onLine: () => boolean
    /** Milliseconds, as `performance.now()`. */
    now: () => number
}

/** Most events waiting, and most bytes in the queue and in one request. */
export const QUEUE_LIMIT = 50
export const BYTE_LIMIT = 32 * 1024
/** Most requests a visit makes. */
export const REQUEST_LIMIT = 30
/** Sends while the page is open are at least this far apart. */
export const SEND_INTERVAL = 60_000
export const TIMEOUT = 15_000

/**
 * `hidden`: the page was hidden, or 60 s passed; `fetch` with `keepalive`, at most one a minute.
 * `leaving`: the page is going away (`pagehide`); `sendBeacon`, whatever the minute rule says.
 * Neither sends while a request is in flight.
 */
export type SendMode = 'hidden' | 'leaving'

export const createSender = (env: SenderEnv) => {
    let queue: { item: Item; text: string }[] = []
    let bytes = 0
    let stopped = false
    let inFlight = false
    let requests = 0
    let lastSent: number | undefined

    const add = (item: Item) => {
        if (stopped) return
        const text = JSON.stringify(item)
        // The queue goes as one body, its items in brackets with a comma after each but the last:
        // within the byte limit, so far below keepalive's 64 KB.
        if (queue.length >= QUEUE_LIMIT || bytes + text.length + 1 >= BYTE_LIMIT) return
        queue.push({ item, text })
        bytes += text.length + 1
    }

    /** Stops for the rest of the visit: a failure, or the user turned the statistics off. */
    const stop = () => {
        stopped = true
        queue = []
        bytes = 0
    }

    // Umami's batch route answers how many items it processed: fewer is a failure too.
    const check = async (response: Response, size: number) => {
        if (!response.ok) return false
        const result = (await response.json()) as { processed?: unknown }
        return typeof result.processed === 'number' && result.processed >= size
    }

    /** Sends what is queued, with `more` (the summaries), when the rules allow. */
    const send = (mode: SendMode, more: () => Item[] = () => []) => {
        // One request at a time: a request that has not ended (a hanging endpoint) holds back
        // the rest of the visit, the beacon at pagehide included.
        if (stopped || inFlight || requests >= REQUEST_LIMIT || !env.onLine()) return
        const now = env.now()
        if (mode === 'hidden' && lastSent !== undefined && now - lastSent < SEND_INTERVAL) return
        for (const item of more()) add(item)
        if (!queue.length) return
        const size = queue.length
        const body = `[${queue.map(({ text }) => text).join(',')}]`
        queue = []
        bytes = 0
        requests++
        lastSent = now
        if (mode === 'leaving') {
            if (!env.sendBeacon?.(env.url, body)) stop()
            return
        }
        inFlight = true
        env.fetch(env.url, {
            method: 'POST',
            body,
            keepalive: true,
            mode: 'cors',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: { 'Content-Type': 'text/plain' },
            ...(typeof AbortSignal.timeout === 'function' && {
                signal: AbortSignal.timeout(TIMEOUT),
            }),
        })
            .then((response) => check(response, size))
            .then((ok) => {
                if (!ok) stop()
            }, stop)
            .finally(() => {
                inFlight = false
            })
    }

    return {
        add,
        send,
        stop,
        /** How many requests went out. */
        requests: () => requests,
        isStopped: () => stopped,
    }
}

export type Sender = ReturnType<typeof createSender>
