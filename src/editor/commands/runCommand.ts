import type { Command } from '.'
import type { Source } from '../../analytics/catalogue'
import { bump, bumpCommand } from '../../analytics/tally'
import { refuseWhilePeeking } from '../../history/peek'
import { isPeeking } from '../../history/stack'
import { commandName } from './names'

/**
 * Runs a command from any entry point, saying where it came from (`source`, for the usage
 * statistics). While peeking, read-only commands run; Open,
 * New, Undo and Redo run too and end the peek themselves once they proceed (a cancelled picker
 * or prompt, or nothing to undo, keeps it); every other command is refused with its notice.
 */
export const runCommand = (command: Command, source: Source): void | Promise<void> => {
    if (isPeeking.value && !command.leavesPeek && !command.readOnly) {
        refuseWhilePeeking({ title: command.title })
        bump('features.peekRefused')
        return
    }

    const name = commandName(command)
    if (name) bumpCommand(name, source)
    return command.execute()
}
