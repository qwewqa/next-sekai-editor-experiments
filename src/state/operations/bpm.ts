import type { State } from '..'
import type { BpmObject } from '../../chart/bpm'
import type { BpmEntity } from '../entities/bpm'
import { findIntegral } from '../integrals'
import { addBpm, removeBpm, replaceBpm } from '../mutations/bpm'
import { getInStoreGrid } from '../store/grid'
import type { Transaction } from '../transaction'
import { editOutcomeReceipt } from './historyReceipts'

export const editSelectedBpm = (
    transaction: Transaction,
    entity: BpmEntity,
    object: Partial<BpmObject>,
) => {
    const edited = {
        beat: object.beat ?? entity.beat,
        bpm: object.bpm ?? entity.bpm,
        meter: object.meter ?? entity.meter,
    }
    // Same-beat changes keep their order.
    if (edited.beat === entity.beat) return replaceBpm(transaction, entity, edited)

    removeBpm(transaction, entity)
    return addBpm(transaction, edited)
}

/** Removes every BPM change at the beat that `keeps` does not keep, and returns them. */
export const replaceBpmsAt = (
    transaction: Transaction,
    beat: number,
    keeps: (entity: BpmEntity) => boolean = () => false,
) => {
    const replaced = (getInStoreGrid(transaction.store.grid, 'bpm', beat) ?? []).filter(
        (entity) => entity.beat === beat && !keeps(entity),
    )
    for (const entity of replaced) removeBpm(transaction, entity)
    return replaced
}

// A move replaces every BPM change at its destination and preserves the initial BPM at zero.
// Batch property edits retain their existing remove-and-add semantics.
export const editBpmWithReceipt = (
    transaction: Transaction,
    entity: BpmEntity,
    object: Partial<BpmObject>,
) => {
    const beat = object.beat ?? entity.beat
    if (beat === entity.beat) {
        const entities = editSelectedBpm(transaction, entity, object)
        return { entities, receipt: editOutcomeReceipt(entity, entities) }
    }

    if (entity.beat) removeBpm(transaction, entity)
    const displaced = replaceBpmsAt(transaction, beat)
    const entities = addBpm(transaction, {
        beat,
        bpm: object.bpm ?? entity.bpm,
        meter: object.meter ?? entity.meter,
    })
    return {
        entities,
        receipt: editOutcomeReceipt(entity, entities, displaced, !entity.beat),
    }
}

export const editBpm = (...args: Parameters<typeof editBpmWithReceipt>) =>
    editBpmWithReceipt(...args).entities

/** The BPM change in effect at a beat: the last one at the greatest beat at or before it, else the first. */
export const bpmInEffect = (state: Pick<State, 'bpms' | 'store'>, beat: number) => {
    const first = state.bpms[0]
    if (!first) return
    const { x } = beat >= first.x ? findIntegral(state.bpms, 'x', beat) : first
    return getInStoreGrid(state.store.grid, 'bpm', x)
        ?.filter((entity) => entity.beat === x)
        .at(-1)
}
