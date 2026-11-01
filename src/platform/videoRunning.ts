import { videoLock } from './videoOutput'

const PREFIX = 'exportVideoRunning.'

/** Call under the job lock; clear the marker before releasing that lock. */
export const markVideoRunning = (
    id: string,
    setting: { resolution: number; renderScale: number; pixels: number },
) => {
    const key = `${PREFIX}${id}`
    const clear = () => {
        try {
            localStorage.removeItem(key)
        } catch {
            /* Interrupted exports cannot be tracked when browser storage is unavailable. */
        }
    }
    try {
        localStorage.setItem(key, JSON.stringify(setting))
    } catch {
        /* A marker failure must not prevent an export. */
    }
    window.addEventListener('pagehide', clear)
    return () => {
        window.removeEventListener('pagehide', clear)
        clear()
    }
}

/** Read and remove abandoned markers while holding each free job lock. */
export const takeStoppedVideoMarkers = async (take?: (value: unknown) => void) => {
    let keys: string[]
    try {
        keys = Object.keys(localStorage).filter((key) => key.startsWith(PREFIX))
    } catch {
        return
    }
    for (const key of keys) {
        await navigator.locks.request(
            videoLock(key.slice(PREFIX.length)),
            { ifAvailable: true },
            (lock) => {
                if (!lock) return
                let value: unknown
                try {
                    const text = localStorage.getItem(key)
                    localStorage.removeItem(key)
                    if (text === null) return
                    value = JSON.parse(text)
                } catch {
                    return
                }
                take?.(value)
            },
        )
    }
}
