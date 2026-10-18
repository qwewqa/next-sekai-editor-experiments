import type { Platform } from '../types'

// The native build's platform until Stage 2 writes it (Part 3, 3.2): every member fails loudly.

const notImplemented = (): never => {
    throw new Error('Not implemented in this build.')
}

export const platform = {
    kind: 'native',
    os: 'other',
    capabilities: Object.freeze({
        writeBack: true,
        unconfirmedDownloads: false,
        library: true,
        fileJournal: true,
        updates: 'desktop',
        defaultAssets: false,
        browserStorage: false,
        safeModeEntry: 'startMarker',
        fileAssociations: true,
        mp3Export: true,
        serverFetch: true,
    }),

    pickFiles: notImplemented,
    saveFile: notImplemented,
    inspect: notImplemented,
    read: notImplemented,
    onOpenFiles: notImplemented,

    onCloseRequested: notImplemented,
    onLifecycle: notImplemented,
    locks: { request: notImplemented, query: notImplemented },
    journal: {
        writeWhole: notImplemented,
        read: notImplemented,
        clear: notImplemented,
        adopt: notImplemented,
        remove: notImplemented,
    },

    openExternal: notImplemented,
    fetchServer: notImplemented,
    diagnostics: notImplemented,
} satisfies Platform
