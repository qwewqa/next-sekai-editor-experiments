/** Call under the job lock; clear the marker before releasing that lock. */
export const markVideoRunning = (id: string, pixels: number) => {
    const key = `exportVideoRunning.${id}`
    const clear = () => {
        try {
            localStorage.removeItem(key)
        } catch {
            /* Interrupted exports cannot be tracked when browser storage is unavailable. */
        }
    }
    try {
        localStorage.setItem(key, String(pixels))
    } catch {
        /* A marker failure must not prevent an export. */
    }
    window.addEventListener('pagehide', clear)
    return () => {
        window.removeEventListener('pagehide', clear)
        clear()
    }
}
