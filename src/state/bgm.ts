import type { Waveform } from '../waveform'
import type { MediaRef } from './levelInfo'

/** Which audio a state uses, recorded whether or not its bytes are held (§1.6.11.1's `bgm`). */
export type BgmMeta = MediaRef & {
    /** The decoded length, `Math.round(duration * 1000)`, when known. */
    readonly durationMs?: number
}

export type Bgm = {
    filename?: string
    buffer?: AudioBuffer
    waveform?: Waveform
    offset: number
    meta?: BgmMeta
}
