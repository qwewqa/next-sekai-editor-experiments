// Clip times as the dialog shows and reads them: `mm:ss.SSS`, or `h:mm:ss.SSS` on a strip that
// passes an hour. Pure.

const pad = (value: number, length: number) => `${value}`.padStart(length, '0')

/** Rounds to the shown millisecond first, so 59.9996 carries to the next second. */
export const formatClipTime = (time: number, hours = false) => {
    const ms = Math.max(0, Math.round(time * 1000))
    const seconds = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0')
    if (!hours) return `${pad(Math.floor(ms / 60000), 2)}:${seconds}`
    return `${Math.floor(ms / 3600000)}:${pad(Math.floor((ms % 3600000) / 60000), 2)}:${seconds}`
}

/**
 * A typed time in seconds: `m:ss.SSS`, `h:mm:ss.SSS` or plain seconds, with a comma counting as
 * the decimal point. Undefined when it cannot be read.
 */
export const parseClipTime = (text: string): number | undefined => {
    const parts = text.trim().replace(',', '.').split(':')
    if (parts.length > 3 || parts.some((part) => !/^\d*\.?\d*$/.test(part) || !/\d/.test(part)))
        return undefined
    // Only the last part may have a fraction.
    if (parts.slice(0, -1).some((part) => part.includes('.'))) return undefined
    const time = parts.reduce((total, part) => total * 60 + Number(part), 0)
    return Number.isFinite(time) ? time : undefined
}

/** A ruler label: `m:ss`, or `h:mm:ss` from an hour. */
export const rulerLabel = (time: number) => {
    const total = Math.round(time)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`
}

const rulerSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** The smallest step that keeps labels at least `gap` px apart at `perSecond` px a second. */
export const rulerStep = (perSecond: number, gap = 64) =>
    rulerSteps.find((step) => step * perSecond >= gap) ?? 3600 * Math.ceil(gap / perSecond / 3600)
