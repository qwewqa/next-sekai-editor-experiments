// Shown to users: the message alone, without the "Error: " prefix.
export const errorMessage = (error: unknown) =>
    error instanceof Error && error.message ? error.message : String(error)

export type TaskFailureKind = 'audioUnreadable' | 'imageUnreadable' | 'coverFailed'

/**
 * A known failure of a loading task. The message is English technical detail for the console and
 * the details disclosure; the dialog names the kind in the UI locale (`describeFailure`).
 */
export class TaskFailure extends Error {
    readonly kind: TaskFailureKind

    constructor(kind: TaskFailureKind, detail: string, options?: ErrorOptions) {
        super(detail, options)
        this.name = 'TaskFailure'
        this.kind = kind
    }
}
