import { KEPT_BYTES_LIMIT } from '../commands/exportLevel/memory'

// The Sonolus packages opened in this tab, for the tab's life: Save and Export refuse each of
// them, whatever session shows, as a package is a source to read, never a file to write. Only the
// latest keeps its bytes, to put back if a save picker emptied it; a session switch clears nothing.

export type OpenedPackage = {
    handle: FileSystemFileHandle
    /** The bytes read at the open, for the latest package within the limit. */
    bytes?: Promise<Blob | undefined>
}

const opened: OpenedPackage[] = []

/** Registers a package as soon as Open finds it is one, before anything else is read of it. */
export const registerOpenedPackage = (handle: FileSystemFileHandle, file: Blob) => {
    for (const earlier of opened) delete earlier.bytes
    opened.push({
        handle,
        ...(file.size <= KEPT_BYTES_LIMIT
            ? {
                  bytes: file.arrayBuffer().then(
                      (buffer) => new Blob([buffer]),
                      () => undefined,
                  ),
              }
            : {}),
    })
}

/**
 * The packages opened in this tab, newest first. A file opened again has several entries, and
 * only the newest keeps its bytes, so a lookup takes the first that matches.
 */
export const openedPackages = (): readonly OpenedPackage[] => [...opened].reverse()
