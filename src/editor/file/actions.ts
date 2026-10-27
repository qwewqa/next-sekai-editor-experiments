// What the file state's dialogs run, set by the save flows (`src/editor/save`) once they exist:
// the chip's dialogs and the notices name no flow of their own.

export type FileActions = {
    /** Save As…, from the not-found dialog: keeps the chain's identity. */
    saveAs: () => void
    /** Builds and downloads the file again ("Download Again"). */
    downloadAgain: () => void
    /** Opens the file on disk as a new session in place of this one. */
    openOtherVersion: () => void
}

export const fileActions: Partial<FileActions> = {}

/** Registers the flows' handlers. */
export const setFileActions = (actions: Partial<FileActions>) => {
    Object.assign(fileActions, actions)
}
