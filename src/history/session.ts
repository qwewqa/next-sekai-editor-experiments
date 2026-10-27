import { shallowRef } from 'vue'
import type { CopyOf } from '../local/names'
import { toWellFormed } from '../local/records/wellFormed'

/**
 * The open session: chain metadata that isn't chart state. The name
 * and the imported file's stem live here, never in snapshots.
 */
export type SessionDescriptor = {
    readonly sessionId: string
    readonly docId: string
    readonly name?: string
    readonly sourceName?: string
    /**
     * A separate copy: the file it was copied from (`bound`), or the session's name, for
     * the status label's "Separate copy of …".
     */
    readonly copyOf?: CopyOf
    /** When it started: the date fallback of the displayed name. */
    readonly startedAt?: number
    /** The file it is bound to, as the chain record has it, for the status label. */
    readonly file?: SessionFile
}

/** The binding as the label reads it: the file event, and the head's hash (hex) at that event. */
export type SessionFile = {
    readonly name: string
    readonly event?: string
    readonly at?: number
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
