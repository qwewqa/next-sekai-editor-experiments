// The post-flush hook: called in the storage worker after each committed
// flush. The web registers none; the apps count their canary here. A hook's failure never fails
// the flush. The flush calls runFlushHooks once its transaction has committed.

export type FlushCommitted = {
    session: { id: string; chainId: string }
    /** The entries rows this flush wrote. */
    entries: readonly unknown[]
    /** The stack blocks it wrote. */
    stackBlocks: readonly unknown[]
    /** The hashes of the nodes and chunks it stored. */
    records: readonly Uint8Array[]
    /** The hashes of the media it stored. */
    media: readonly Uint8Array[]
    /** Whether the session's descriptor (its chain record's identity or name) changed. */
    descriptorChanged: boolean
}

export type FlushHook = (flush: FlushCommitted) => void | Promise<void>

const hooks = new Set<FlushHook>()

/** Adds a hook; returns its removal. */
export const onFlushCommitted = (hook: FlushHook) => {
    hooks.add(hook)
    return () => {
        hooks.delete(hook)
    }
}

/** Runs every hook in order; a throw or rejection is logged, never passed on. */
export const runFlushHooks = async (flush: FlushCommitted) => {
    for (const hook of [...hooks]) {
        try {
            await hook(flush)
        } catch (error) {
            console.error('A post-flush hook failed', error)
        }
    }
}
