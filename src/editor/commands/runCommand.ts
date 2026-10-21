import type { Command } from '.'
import { refuseWhilePeeking } from '../../history/peek'
import { isPeeking } from '../../history/stack'

/**
 * Runs a command from any entry point (§1.4.11). While peeking, read-only commands run; Open,
 * New, Undo and Redo run too and end the peek themselves once they proceed (a cancelled picker
 * or prompt, or nothing to undo, keeps it); every other command is refused with its notice.
 */
export const runCommand = (command: Command): void | Promise<void> => {
    if (isPeeking.value && !command.leavesPeek && !command.readOnly) {
        refuseWhilePeeking({ title: command.title })
        return
    }

    return command.execute()
}
