// This device's own record of exports that stopped before they ended. A tab killed mid-export
// leaves its `exportVideoRunning.<id>` marker.

import { videoLock } from '../../platform/videoOutput'
import { settings } from '../../settings'

const PREFIX = 'exportVideoRunning.'

/**
 * Counts the markers whose job lock is free as stops, and removes them.
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
        stops[pixels] = (stops[pixels] ?? 0) + 1
    }
    settings.exportVideoStops = Object.fromEntries(
        Object.entries(stops).filter(([, count]) => count > 0),
    )
    return false
}

/** A finished export clears its size's count. */
export const clearStops = (pixels: number) => {
    if (!(pixels in settings.exportVideoStops)) return
    settings.exportVideoStops = Object.fromEntries(
        Object.entries(settings.exportVideoStops).filter(([key]) => key !== String(pixels)),
    )
}

/** Reset the stop record. */
export const clearDeviceLimit = () => {
    settings.exportVideoStops = {}
}
