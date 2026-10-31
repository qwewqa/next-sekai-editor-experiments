import { onBeforeHandleWrite } from '../../platform'
import { KEPT_BYTES_LIMIT, sameEntry } from '../commands/exportLevel/memory'

// The Sonolus packages opened in this tab, for the tab's life. Save and Export consult them only
// for a file nothing else places (no session source, binding or owner), and refuse it: a package
// is a source to read, never a file to write. Only the latest keeps its bytes, to put back if a
// save picker emptied it. An entry goes when this tab opens that file as anything else, and
// before any write of this tab to it.

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

// Every write of this tab to a handle, whether it lands or not: the file may no longer hold the
// package. A put-back of the package's own bytes registers it again.
onBeforeHandleWrite(forgetOpenedPackage)

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

/**
 * The bytes of the newest package of the file a handle names, read within the same check: a
 * package registered or forgotten while they are read starts the lookup again, so older bytes
 * never go back.
 */
export const openedPackageBytes = async (handle: FileSystemFileHandle) => {
    for (;;) {
        const seen = opened
        const entry = await openedPackageOf(handle)
        if (opened !== seen) continue
        const bytes = await entry?.bytes
        if (opened === seen) return bytes
    }
}

/** Forgets every package, as a test needs between cases. */
export const resetOpenedPackagesForTests = () => {
    opened = []
}
