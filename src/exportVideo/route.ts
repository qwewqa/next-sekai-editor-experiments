/**
 * Staging refused for the browser or the page, not for a full disk. Firefox refuses the origin
 * private file system in private windows with SecurityError; WebKit refuses it with UnknownError
 * where the session has no storage path, as in Safari Private Browsing.
 */
export const stagingRefused = (error: unknown) =>
    error instanceof DOMException &&
    ['SecurityError', 'NotSupportedError', 'UnknownError'].includes(error.name)

/**
 * Whether exports from this worker's browser take the in-memory route, found without creating a
 * file: true when the origin private file system is refused or has no sync access handles, false
 * when it has them, and undefined when the check fails otherwise. Run in a worker,
 * where `createSyncAccessHandle` exists.
 */
export const readMemoryRoute = async (): Promise<boolean | undefined> => {
    try {
        await navigator.storage.getDirectory()
    } catch (error) {
        return stagingRefused(error) || undefined
    }
    return !('createSyncAccessHandle' in FileSystemFileHandle.prototype)
}
