/**
 * The largest coordinates a chart may hold. The grid keeps a bucket for each beat a connector
 * spans, and the preview a slot lane for each lane of a note’s width, so values past these would
 * hang or exhaust memory.
 */
export const maxBeat = 100000
export const maxLane = 5000
export const maxSize = 5000
