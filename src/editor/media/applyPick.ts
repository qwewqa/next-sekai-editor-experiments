import { liveState, pushState } from '../../history/stack'
import type { Bgm, BgmMeta } from '../../state/bgm'
import { releaseWaveform, type Waveform } from '../../waveform'
import type { bgmOperation } from '../headerLabels'
import { attachHeld, cacheBgm, cacheHeld, storeHeld, type HeldParts } from './heldBgm'

// What Choose Audio… does with the file picked, decided on
// its hash alone. The file the state names is attached and stored again as no step, with the
// recorded meta kept; any other file is one BGM change.

/** A picked file, loaded: what a BGM change or an attach is made of. */
export type PickedBgm = {
    filename: string
    buffer: AudioBuffer
    waveform?: Waveform
    source: ArrayBuffer
    meta: BgmMeta
}

export type PickDecision =
    /** The file the state names, which has no audio yet: attach it, keeping the recorded meta. */
    | { kind: 'attach' }
    /** The state has its audio already: nothing to bring back. */
    | { kind: 'loaded' }
    /** Another file: one BGM change. `original` is the name of the file the state named. */
    | { kind: 'change'; named: boolean; original?: string }

export const decidePick = (live: Bgm, picked: { hash: string }): PickDecision => {
    if (live.meta?.hash === picked.hash)
        return live.buffer ? { kind: 'loaded' } : { kind: 'attach' }
    // The differs line is for audio the state named and lacked; a loaded BGM is changed as usual.
    return live.meta && !live.buffer
        ? {
              kind: 'change',
              named: true,
              ...(live.meta.filename ? { original: live.meta.filename } : {}),
          }
        : { kind: 'change', named: false }
}

const partsOf = (picked: PickedBgm): HeldParts => ({
    buffer: picked.buffer,
    source: picked.source,
    ...(picked.waveform ? { waveform: picked.waveform } : {}),
})

/** What applying a pick did, for the notice that follows. */
export type PickOutcome =
    | { kind: 'attached' }
    | { kind: 'unchanged' }
    | { kind: 'changed'; decision: Extract<PickDecision, { kind: 'change' }>; text: string }

/**
 * Applies a picked file to the live state of session `id`, which owns its waveform from here.
 * `operation` describes the BGM change as the editor does.
 */
export const applyPick = (
    picked: PickedBgm,
    id: string,
    operation: typeof bgmOperation,
): PickOutcome => {
    const decision = decidePick(liveState.value.bgm, picked.meta)
    if (decision.kind === 'loaded') {
        releaseWaveform(picked.waveform)
        return { kind: 'unchanged' }
    }
    if (decision.kind === 'attach') {
        // The state already names this file: nothing changes but that it has its audio, and storage
        // has its bytes again (the next flush would also, from `source`).
        const parts = partsOf(picked)
        cacheHeld(picked.meta.hash, parts)
        attachHeld(id, picked.meta.hash, parts)
        void storeHeld({
            hash: picked.meta.hash,
            bytes: picked.source.slice(0),
            type: picked.meta.type,
            filename: picked.meta.filename,
            kind: 'bgm',
        })?.catch(() => undefined)
        return { kind: 'attached' }
    }
    const old = liveState.value.bgm
    const { waveform: _waveform, ...rest } = old
    const next: Bgm = {
        ...rest,
        filename: picked.filename,
        buffer: picked.buffer,
        ...(picked.waveform ? { waveform: picked.waveform } : {}),
        source: picked.source,
        meta: picked.meta,
    }
    const described = operation(old, next)
    if (!pushState(described, { ...liveState.value, bgm: next })) {
        releaseWaveform(picked.waveform)
        return { kind: 'unchanged' }
    }
    cacheBgm(next)
    return { kind: 'changed', decision, text: described.fallback.text }
}
