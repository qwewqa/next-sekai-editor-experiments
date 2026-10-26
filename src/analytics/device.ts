import { workspaceSize } from '../editor/workspace'
import { detection } from '../platform/detect'
import type { EventData } from './catalogue'
import { bucket, measured } from './scales'

// The device an event ran on. The recorded events (open, save, export, check, bgm) take it as the
// action ends, through the reader that start.ts gives `tally.record`, so a resize or a move to
// another screen before the send does not relabel it. Startup, peek and perf, which cover a
// stretch of time, take it when the client builds them. A few reads, nothing heavier.

export type Device = Pick<
    EventData<'perf'>,
    'cores' | 'deviceMemory' | 'engine' | 'touch' | 'dpr' | 'viewport'
>

/** The browser’s approximate memory in GiB, where it reports one. */
const deviceMemory = (): Device['deviceMemory'] => {
    const value = (navigator as { deviceMemory?: unknown }).deviceMemory
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return
    if (value >= 16) return '16+'
    if (value <= 0.25) return '0.25'
    const label = String(value)
    return label === '0.5' || label === '1' || label === '2' || label === '4' || label === '8'
        ? label
        : 'other'
}

/** What every measured event repeats: the device it ran on, and the workspace’s width. */
export const device = (): Device => {
    const cores = navigator.hardwareConcurrency
    const memory = deviceMemory()
    const dpr = devicePixelRatio
    const viewport = measured('viewport', workspaceSize.value.width)
    return {
        ...(cores > 0 && { cores: bucket('cores', cores) }),
        ...(memory && { deviceMemory: memory }),
        engine: detection().engine,
        touch: matchMedia('(pointer: coarse)').matches,
        ...(dpr > 0 && { dpr: bucket('dpr', dpr) }),
        ...(viewport && { viewport }),
    }
}

/** The recorded events that carry the device they ran on. */
const measuredEvents = new Set(['open', 'save', 'export', 'check', 'bgm'])

/** Reads the device for a recorded event that carries it, as the action ends. */
export const deviceOf = (name: string) => (measuredEvents.has(name) ? device() : undefined)
