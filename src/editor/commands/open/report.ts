import { busy, record } from '../../../analytics/tally'

// The usage statistics’ `open` event: one per chart file opened with Open File…, recorded where
// the open ends. The facts gather in a module value while it runs, so the several paths of the
// open each add a line. One open runs at a time (`withSwitchRequest`).

type Format = 'nxsp' | 'levelData' | 'sus' | 'usc' | 'chcy' | 'other'
type Outcome = 'done' | 'cancelled' | 'refused' | 'failed'

let current: { size: number; since: number; format: Format } | undefined

/** A file was picked, and the open begins. */
export const startOpen = (file: File) => {
    if (!current) busy(true)
    current = { size: file.size, since: performance.now(), format: 'other' }
}

/** The file’s format, once known. */
export const openFormat = (format: Format) => {
    if (current) current.format = format
}

/** The file is not a chart (audio, an archive, a package): nothing to record. */
export const dropOpen = () => {
    if (current) busy(false)
    current = undefined
}

/** The open ended. A reason says why a file was refused, or `unsupported` or `invalid`. */
export const endOpen = (outcome: Outcome, reason?: 'unsupported' | 'invalid') => {
    if (!current) return
    const { size, since, format } = current
    current = undefined
    busy(false)
    record('open', { format, via: 'picker', size, outcome, ...(reason && { reason }) }, since)
}
