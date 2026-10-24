// The BroadcastChannel `nse-local-data`: hints for lists and badges, and the upgrade
// handshake's `upgradeWanted`. Never delivered to the sender; may be delayed or dropped.

export const CHANNEL_NAME = 'nse-local-data'

export type Channel = {
    post: (message: unknown) => void
    onmessage: ((message: unknown) => void) | undefined
    close: () => void
}

/** The browser's channel; a channel that posts nowhere where BroadcastChannel is missing. */
export const broadcastChannel = (name: string = CHANNEL_NAME): Channel => {
    if (typeof BroadcastChannel === 'undefined')
        return { post: () => undefined, onmessage: undefined, close: () => undefined }
    const channel = new BroadcastChannel(name)
    const wrapper: Channel = {
        post: (message) => {
            channel.postMessage(message)
        },
        onmessage: undefined,
        close: () => {
            channel.close()
        },
    }
    channel.onmessage = (event: MessageEvent) => {
        wrapper.onmessage?.(event.data)
    }
    return wrapper
}

let poster: Channel | undefined

/** Tells other tabs a chain record was made or its head moved: a hint to read their lists again. */
export const postSessionUpdated = () => {
    try {
        poster ??= broadcastChannel()
        poster.post({ type: 'sessionUpdated' })
    } catch {
        // A hint only: a list refreshes on pageshow and when the page becomes visible too.
    }
}
