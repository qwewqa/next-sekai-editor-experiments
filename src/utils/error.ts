/** A cancel: the AbortError an aborted signal or a closed dialog throws. */
export const isAbort = (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError'

// Shown to users: the message alone, without the "Error: " prefix.
export const errorMessage = (error: unknown) =>
    error instanceof Error && error.message ? error.message : String(error)

export type TaskFailureKind =
    | 'audioUnreadable'
    | 'audioMayBeTooLong'
    | 'audioTooLong'
    | 'imageUnreadable'
    | 'coverFailed'
    | 'codeFailed'

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

/** A dynamic import in a loading task: a failure to load becomes `codeFailed`. */
export const importForTask = async <T>(load: () => Promise<T>): Promise<T> => {
    try {
        return await load()
    } catch (error) {
        throw new TaskFailure('codeFailed', errorMessage(error), { cause: error })
    }
}
