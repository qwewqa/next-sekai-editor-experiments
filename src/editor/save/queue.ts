import { recordError } from '../../diagnostics'

// One Save at a time in a tab: Saves run in press order. A press while one runs
// waits its turn and is never dropped; a press that has not started yet joins an earlier one of the
// same command, so a command pressed ten times meanwhile runs once more, not ten times.

let tail: Promise<void> = Promise.resolve()

/** The queued presses that have not started, by command. */
const waiting = new Map<string, Promise<void>>()

const enqueue = (run: () => Promise<void>, key?: string) => {
    const mine = tail
        .then(() => {
            // Started: a press now queues behind it, as one more.
            if (key !== undefined) waiting.delete(key)
            return run()
        })
        // A run that throws (also before its first await) is logged and frees the queue.
        .catch((error: unknown) => {
            recordError(error)
            console.error('A Save failed', error)
        })
    tail = mine
    if (key !== undefined) waiting.set(key, mine)
    return mine
}

/**
 * Runs `run` after every Save pressed before it. `key` names the command: a press that has not
 * started yet is the same press as an earlier queued one of its key, and resolves with it.
 */
export const exclusive = (key: string, run: () => Promise<void>): Promise<void> =>
    waiting.get(key) ?? enqueue(run, key)

/** As `exclusive`, for a Save no command key stands for: never joined. */
export const enqueueSave = (run: () => Promise<void>): Promise<void> => enqueue(run)
