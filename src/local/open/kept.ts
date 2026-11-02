const DIR = 'nse-kept'

/** Copies left by earlier builds are reclaimed only after their chain is deleted. */
const directory = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: false })

/** The chains with a kept copy in OPFS, for the load's reclaim after definite deletion. */
export const keptCopyChains = async (): Promise<string[]> => {
    try {
        const names: string[] = []
        const folder = (await directory()) as unknown as { keys: () => AsyncIterable<string> }
        for await (const name of folder.keys()) names.push(name)
        return names
    } catch {
        return []
    }
}

/** Removes a deleted chain's kept copy; one left behind is tried again at the next load. */
export const removeKeptCopy = async (chainId: string) => {
    try {
        await (await directory()).removeEntry(chainId)
    } catch {
        // Tried again at the next load.
    }
}
