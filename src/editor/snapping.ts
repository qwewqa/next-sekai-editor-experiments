import { align } from '../utils/math'

export type Snapping = 'absolute' | 'relative'

// Given the pointer's own movement, absolute snapping waits for half a step of it and snaps relatively until then.
export const snappedOffset = (
    start: number,
    current: number,
    anchor: number,
    division: number,
    snapping: Snapping,
    moved?: number,
) =>
    snapping === 'absolute' && (moved === undefined || Math.abs(moved) * division >= 0.5)
        ? align(anchor + current - start, division) - anchor
        : align(current - start, division)
