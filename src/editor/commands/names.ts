import type { Command, CommandName } from '.'

// The built-in commands' names, for the usage statistics. `index.ts` fills them once; a command
// added later by `registerCommand` has no name here and is not counted.
const names = new WeakMap<Command, CommandName>()
const all = new Set<string>()

export const nameBuiltInCommands = (builtIn: Record<CommandName, Command>) => {
    for (const [name, command] of Object.entries(builtIn) as [CommandName, Command][]) {
        names.set(command, name)
        all.add(name)
    }
}

/** A built-in command's name, or undefined for any other. */
export const commandName = (command: Command) => names.get(command)

/** The built-in commands' names. */
export const builtInCommandNames: ReadonlySet<string> = all
