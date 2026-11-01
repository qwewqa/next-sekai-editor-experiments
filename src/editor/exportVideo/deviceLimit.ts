// This device's own record of exports that stopped before they ended. A tab killed mid-export
// leaves its `exportVideoRunning.<id>` marker; one stop proves nothing, so the limit drops only at
// the second stop of the same render size.

import { videoLock } from '../../platform/videoOutput'
import { settings } from '../../settings'

const PREFIX = 'exportVideoRunning.'

/**
 * Counts the markers whose job lock is free as stops, and removes them. Returns true when this
 * lowered the limit, which the dialog says once.
 */
export const countStoppedExports = async () => {
    let keys: string[]
    try {
        keys = Object.keys(localStorage).filter((key) => key.startsWith(PREFIX))
    } catch {
        return false
    }
    if (!keys.length) return false
    const held = new Set(
        ((await navigator.locks.query()).held ?? []).map((lock) => lock.name ?? ''),
    )
    let lowered = false
    const stops = { ...settings.exportVideoStops }
    for (const key of keys) {
        if (held.has(videoLock(key.slice(PREFIX.length)))) continue
        let pixels: number
        try {
            pixels = Number(localStorage.getItem(key))
            localStorage.removeItem(key)
        } catch {
            continue
        }
        if (!(pixels > 0)) continue
        const count = (stops[pixels] ?? 0) + 1
        if (count < 2) {
            stops[pixels] = count
            continue
        }
        stops[pixels] = 0
        const limit = pixels - 1
        if (!settings.exportVideoPixelLimit || limit < settings.exportVideoPixelLimit) {
            settings.exportVideoPixelLimit = limit
            lowered = true
        }
    }
    settings.exportVideoStops = Object.fromEntries(
        Object.entries(stops).filter(([, count]) => count > 0),
    )
    return lowered
}

/** A finished export clears its size's count. */
export const clearStops = (pixels: number) => {
    if (!(pixels in settings.exportVideoStops)) return
    settings.exportVideoStops = Object.fromEntries(
        Object.entries(settings.exportVideoStops).filter(([key]) => key !== String(pixels)),
    )
}

/** Restore Defaults offers every size again. */
export const clearDeviceLimit = () => {
    settings.exportVideoPixelLimit = 0
    settings.exportVideoStops = {}
}
