import type { BaseEntity } from '.'
import type { BpmObject } from '../../chart/bpm'
import { formatBpm } from '../../utils/format'

export type BpmEntity = BaseEntity & {
    type: 'bpm'
    bpm: number
    meter: number
}

// The chart labels a change from lane 6.1 in a 0.5-lane font.
export const BPM_LABEL = { lane: 6.1, size: 0.5 }

// An upper bound in common fonts: figures up to 0.64 em, a point half that.
const labelWidth = (bpm: number) => {
    const text = formatBpm(bpm)
    return (text.length - (text.includes('.') ? 0.5 : 0)) * 0.64 * BPM_LABEL.size
}

export const toBpmEntity = (object: BpmObject): BpmEntity => {
    // From lane 6, past the label's end.
    const w = Math.max(0.5, (BPM_LABEL.lane - 6 + labelWidth(object.bpm)) / 2)
    return {
        type: 'bpm',
        hitbox: {
            lane: 6 + w,
            beat: object.beat,
            w,
            h: 0.4,
        },

        beat: object.beat,
        bpm: object.bpm,
        meter: object.meter ?? 4,
    }
}
