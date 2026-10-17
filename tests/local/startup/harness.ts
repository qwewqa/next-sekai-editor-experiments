import type { ContinueStart, FlushSession } from '../../../src/local/flush'
import type { SessionRead } from '../../../src/local/startup/stored'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import type { State } from '../../../src/state'
import { testId, type Page } from '../flush/harness'

// Opening stored sessions on the test core: a page reads a session as startup does, then
// continues it, forks it or takes it up again through its flusher.

export const handlersOf = (page: Page) =>
    startupHandlers({ core: page.core, test: true, emit: () => undefined }, page.tab.waiter)

/** Reads a session to open it, in the page's worker. */
export const readOpen = async (page: Page, sessionId: string) => {
    const read = await page.tab.run(() => handlersOf(page).readSession(sessionId))
    if (read.kind !== 'open') throw new Error(`Session ${sessionId} reads ${read.kind}`)
    return read
}

type Open = SessionRead & { kind: 'open' }

/** The stored stack of a read, as the flusher takes it. */
export const stackOf = (read: Open) => ({
    first: read.stack.window.base,
    slots: read.stack.slots.map(({ snapshot, label }) => ({ hash: snapshot, label })),
    index: read.stack.window.index,
})

/** Continues a read session in the page, in its chain or as a fork. */
export const continueIn = (
    page: Page,
    read: Open,
    extra: Partial<ContinueStart> & { asFork?: boolean } = {},
): FlushSession => {
    const { asFork, ...rest } = extra
    return page.flusher.continueSession({
        id: testId(),
        chainId: asFork ? testId() : String(read.chain.chainId),
        docId: asFork ? testId() : String(read.chain.docId),
        lineageId: String(read.chain.lineageId),
        parent: { id: String(read.session.id), uptoSeq: read.session.lastSeq as number },
        stack: stackOf(read),
        chain: read.chain,
        label: () => 'Continued',
        dirty: false,
        ...(asFork ? { fork: { forkOf: String(read.chain.chainId), forkName: 'Golden (2)' } } : {}),
        ...rest,
    })
}

/** Takes up a read session again, as its own tab's reload does. */
export const resumeIn = (page: Page, read: Open) =>
    page.flusher.resumeSession({
        id: String(read.session.id),
        chainId: String(read.chain.chainId),
        docId: String(read.chain.docId),
        lineageId: String(read.chain.lineageId),
        origin: read.session.origin as FlushSession['origin'],
        startedAt: read.session.startedAt as number,
        lastSeq: read.session.lastSeq as number,
        chain: read.chain,
        stack: {
            ...stackOf(read),
            window: read.stack.window,
            blocks: read.stack.blocks,
            at: read.at,
        },
    })

/** Starts a session in the page with its first state. */
export const beginIn = (page: Page, state: State, origin: 'new' | 'import' = 'import') =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin,
        state,
        label: () => 'Initialize',
        dirty: false,
    })
