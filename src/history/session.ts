import { shallowRef } from 'vue'
import { toWellFormed } from '../local/records/wellFormed'

/**
 * The open session (§1.3.5): chain metadata that isn't chart state. The name
 * and the imported file's stem live here, never in snapshots.
 */
export type SessionDescriptor = {
    readonly sessionId: string
    readonly docId: string
    readonly name?: string
    readonly sourceName?: string
    /**
     * A separate copy (§1.3.1): the file it was copied from (`bound`), or the session's name, for
     * the status label's "Separate copy of …".
     */
    readonly copyOf?: { readonly name: string; readonly bound: boolean }
    /** When it started: the date fallback of the displayed name (§1.3.5). */
    readonly startedAt?: number
    /** The file it is bound to, as the chain record has it (§1.3.2), for the status label. */
    readonly file?: SessionFile
}

/** The binding as the label reads it: the file event, and the head's hash (hex) at that event. */
export type SessionFile = {
    readonly name: string
    readonly event?: string
    readonly at?: number
    /** I Have the File was pressed for this download (§1.3.4). */
    readonly confirmed?: boolean
    readonly hash?: string
}

/** A descriptor with fresh ids for whatever `init` leaves out; text passes the well-formed helper. */
export const createSessionDescriptor = (
    init: Partial<SessionDescriptor> = {},
): SessionDescriptor => ({
    sessionId: init.sessionId ?? crypto.randomUUID(),
    docId: init.docId ?? crypto.randomUUID(),
    ...(init.name === undefined ? {} : { name: toWellFormed(init.name) }),
    ...(init.sourceName === undefined ? {} : { sourceName: toWellFormed(init.sourceName) }),
    ...(init.copyOf === undefined ? {} : { copyOf: init.copyOf }),
    startedAt: init.startedAt ?? Date.now(),
    ...(init.file === undefined ? {} : { file: init.file }),
})

export const session = shallowRef<SessionDescriptor>(createSessionDescriptor())
