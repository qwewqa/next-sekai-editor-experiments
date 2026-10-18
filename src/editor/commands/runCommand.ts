import type { Command } from '.'
import { leavePeek, refuseWhilePeeking } from '../../history/peek'
import { isPeeking } from '../../history/stack'

/**
 * Runs a command from any entry point (§1.4.11). While peeking, read-only commands run, Open,
 * New, Undo and Redo leave the peek first, and every other command is refused with its notice.
 */
export const runCommand = (command: Command): void | Promise<void> => {
    if (isPeeking.value) {
        if (command.leavesPeek) leavePeek()
        else if (!command.readOnly) {
            refuseWhilePeeking({ title: command.title })
            return
        }
    }

    return command.execute()
}
