// What the file state's dialogs run, set by the save flows (`src/editor/save`) once they exist:
// the chip's dialogs and the notices name no flow of their own.

export type FileActions = {
    /** Save As…, from the not-found dialog: keeps the chain's identity (§1.4.7). */
    saveAs: () => void
    /** Builds and downloads the file again (§1.4.7, "Download Again"). */
    downloadAgain: () => void
    /** Opens the file on disk as a new session in place of this one (§0.9.6). */
    openOtherVersion: () => void
    /** The "Not stored" chip's dialog (§1.6.7, Step 8). */
    openNotStored: () => void
    /** Stores that the open session's download is confirmed, beside the label's state. */
    persistConfirmed: () => void
}

export const fileActions: Partial<FileActions> = {}

/** Registers the flows' handlers. */
export const setFileActions = (actions: Partial<FileActions>) => {
    Object.assign(fileActions, actions)
}
