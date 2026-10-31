import type { SaveResult } from '../../platform'
import { KEPT_BYTES_LIMIT, sameEntry } from '../commands/exportLevel/memory'

// The Sonolus packages opened in this tab, for the tab's life. Save and Export consult them only
// for a file nothing else places (no session source, binding or owner), and refuse it: a package
// is a source to read, never a file to write. Only the latest keeps its bytes, to put back if a
// save picker emptied it. An entry goes when this tab opens or writes that file as anything else.

export type OpenedPackage = {
    handle: FileSystemFileHandle
    /** The bytes read at the open, for the latest package within the limit. */
    bytes?: Promise<Blob | undefined>
}

let opened: readonly OpenedPackage[] = []

/** Registers a package as soon as Open finds it is one, before anything else is read of it. */
export const registerOpenedPackage = (handle: FileSystemFileHandle, file: Blob) => {
    for (const earlier of opened) delete earlier.bytes
    opened = [
        ...opened,
        {
            handle,
            ...(file.size <= KEPT_BYTES_LIMIT
                ? {
                      bytes: file.arrayBuffer().then(
                          (buffer) => new Blob([buffer]),
                          () => undefined,
                      ),
                  }
                : {}),
        },
    ]
}

const same = async (a: FileSystemFileHandle, b: FileSystemFileHandle) =>
    (await sameEntry(a, b)) || sameEntry(b, a)

/** Forgets every package of the file a handle names: this tab opened or wrote it as anything else. */
export const forgetOpenedPackage = async (handle: FileSystemFileHandle) => {
    const matches: OpenedPackage[] = []
    for (const entry of opened) if (await same(handle, entry.handle)) matches.push(entry)
    opened = opened.filter((entry) => !matches.includes(entry))
}

/** Forgets the package a write of this tab replaced, if the write went to a handle. */
export const forgetWrittenPackage = (result: SaveResult) =>
    result.status === 'saved' && result.target.kind === 'handle'
        ? forgetOpenedPackage(result.target.handle)
        : Promise.resolve()

/**
 * The newest package of the file a handle names. The register can change while an `isSameEntry`
 * is pending: the lookup then starts again, so a superseded or forgotten entry is never used.
 */
export const openedPackageOf = async (handle: FileSystemFileHandle) => {
    for (;;) {
        const seen = opened
        let found: OpenedPackage | undefined
        for (const entry of [...seen].reverse()) {
            const matches = await same(handle, entry.handle)
            if (opened !== seen) break
            if (matches) {
                found = entry
                break
            }
        }
        if (opened === seen) return found
    }
}

/** Forgets every package, as a test needs between cases. */
export const resetOpenedPackagesForTests = () => {
    opened = []
}
