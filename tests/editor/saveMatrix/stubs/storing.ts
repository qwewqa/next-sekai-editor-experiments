// A stand-in for src/local/storing.ts: the flusher and journal writer the Save core reads.
import type { Flusher } from '../../../../src/local/flush'

export let flusher: Flusher | undefined
export let journalWriter: { rewrite: () => void } | undefined

export const onFlusherStart = () => () => undefined

export const setFlusherForMatrix = (next: unknown, journal?: { rewrite: () => void }) => {
    flusher = next as Flusher | undefined
    journalWriter = journal
}
