import { align } from '../utils/math'

export type Snapping = 'absolute' | 'relative'

// Given the pointer's own movement, absolute snapping waits for half a step of it and snaps relatively until then.
// An infinite movement forces it at once, rounding a tie up through float noise.
export const snappedOffset = (
    start: number,
    current: number,
    anchor: number,
    division: number,
    snapping: Snapping,
    moved?: number,
) =>
    snapping === 'absolute' && (moved === undefined || Math.abs(moved) * division >= 0.5)
        ? (moved === Number.POSITIVE_INFINITY
              ? Math.round((anchor + current - start) * division + 1e-6) / division
              : align(anchor + current - start, division)) - anchor
        : align(current - start, division)

/** A lane lattice: its offset and its subdivisions' phase. */
export type Lattice = { offset: number; grid: number }

const isWholeSteps = (value: number, division: number) =>
    Math.abs(value * division - Math.round(value * division)) < 1e-6

/** A lattice moved by part of a step, or its parity changed, so absolute snapping can't wait. */
export const isLatticeMoved = (
    from: Lattice | undefined,
    to: Lattice | undefined,
    division: number,
) =>
    !!from &&
    !!to &&
    (!isWholeSteps(to.offset - from.offset, division) ||
        !isWholeSteps(to.grid - from.grid, division))
