// What runs before every write to a file handle, whichever platform makes it and whatever asked for
// it: before the write starts, as a write may commit even when it then fails.

let before: ((handle: FileSystemFileHandle) => Promise<void>) | undefined

/** Sets what runs before every write to a file handle. */
export const onBeforeHandleWrite = (run: (handle: FileSystemFileHandle) => Promise<void>) => {
    before = run
}

/** Called by a platform at the start of its write to a handle, inside the caller's lock. */
export const beforeHandleWrite = (handle: FileSystemFileHandle) =>
    before ? before(handle) : Promise.resolve()
