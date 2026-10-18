import { properties } from './commands/properties'
import { runCommand } from './commands/runCommand'

/**
 * Named stub until Step 11: the status label opens Level Info (Part 1 §1.3.4), which is today's
 * Level Properties dialog for now.
 */
export const openLevelInfoStub = () => {
    void runCommand(properties)
}
