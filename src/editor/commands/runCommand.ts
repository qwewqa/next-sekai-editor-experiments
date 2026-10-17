import type { Command } from '.'
import { isPeeking } from '../../history/stack'

/** Runs a command from any entry point; while peeking, only read-only ones run. */
export const runCommand = (command: Command): void | Promise<void> => {
    if (isPeeking.value && !command.readOnly) return

    return command.execute()
}
