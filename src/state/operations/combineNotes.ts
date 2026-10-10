import type { State } from '..'
import { buildPreviewChart } from '../../preview/engine/chart'
import { getStageProps } from '../../preview/engine/stage'
import { nearlyEqual } from '../../utils/math'
import type { Entity } from '../entities'
import { createSlideId } from '../entities/slides'
import type { NoteEntity } from '../entities/slides/note'
import { beatToTime } from '../integrals/bpms'
import { addNote, removeNote } from '../mutations/slides/note'
import { createTransaction } from '../transaction'
import { connectorProperties } from './connectorProperties'
import { getMaterializedNotePositions } from './notePositions'

export const combineNotes = (source: State, selected: Entity[]): State => {
    const slideIds = new Set(
        selected.filter((entity) => entity.type === 'note').map((note) => note.slideId),
    )
    if (slideIds.size < 2) return source

    const unordered = [...source.store.slides.info]
        .filter(([id]) => slideIds.has(id))
        .flatMap(([, infos]) =>
            infos.map((info, index) => ({
                note: info.note,
                index,
                first: index === 0,
                last: index === infos.length - 1,
                attached: info.note.isAttached && index > 0 && index < infos.length - 1,
                attachHead: info.attachHead,
                attachTail: info.attachTail,
                properties: connectorProperties(infos[index + 1]?.segmentHead ?? info.segmentHead),
            })),
        )
    const byBeat = new Map<number, Map<number, typeof unordered>>()
    for (const item of unordered) {
        const slides = byBeat.get(item.note.beat) ?? new Map<number, typeof unordered>()
        const block = slides.get(item.note.slideId) ?? []
        block.push(item)
        slides.set(item.note.slideId, block)
        byBeat.set(item.note.beat, slides)
    }
    const hasElevationTies = [...byBeat.values()].some((slides) => slides.size > 1)
    const chart =
        (source.isDynamicStages && hasElevationTies) || unordered.some(({ attached }) => attached)
            ? buildPreviewChart(source, 10)
            : undefined
    const stages = chart?.stages ?? []
    const positions = getMaterializedNotePositions(
        source,
        unordered.map(({ note }) => note),
        chart,
    )
    const stageIndexes = new Map([...source.stages.keys()].map((id, index) => [id, index]))
    const elevation = (item: (typeof unordered)[number] | undefined) => {
        if (!item) return 0
        const { note } = item
        const index = stageIndexes.get(note.stageId)
        const stage = index === undefined ? undefined : stages[index]
        return (
            (positions.get(note)?.elevation ?? note.elevation) +
            (stage ? getStageProps(stage, beatToTime(source.bpms, note.beat)).elevation : 0)
        )
    }
    // At equal elevation, a slide ending at the beat joins before one starting there.
    const rank = (notes: typeof unordered) => {
        const first = notes.some((item) => item.first)
        const last = notes.some((item) => item.last)
        return first === last ? 1 : last ? 0 : 2
    }
    const notes = [...byBeat]
        .sort(([a], [b]) => a - b)
        .flatMap(([, slides]) => {
            const blocks = [...slides.values()]
            if (blocks.length < 2) return blocks.flat()
            return blocks
                .map((notes) => ({ notes, elevation: elevation(notes[0]), rank: rank(notes) }))
                .sort((a, b) => a.elevation - b.elevation || a.rank - b.rank)
                .flatMap(({ notes }) => notes)
        })

    // A tick stays attached while nothing from another slide comes between its anchors,
    // so it interpolates between the same notes as before.
    const order = new Map(notes.map(({ note }, index) => [note, index]))
    const indexes = new Map(unordered.map(({ note, index }) => [note, index]))
    const span = (
        indexes: Map<NoteEntity, number>,
        { attachHead, attachTail }: (typeof unordered)[number],
    ) => (indexes.get(attachTail) ?? NaN) - (indexes.get(attachHead) ?? NaN)
    const kept = new Set(
        unordered
            .filter((item) => item.attached && span(order, item) === span(indexes, item))
            .map(({ attachHead }) => attachHead),
    )

    for (;;) {
        const transaction = createTransaction(source)
        for (const { note } of notes) removeNote(transaction, note)

        const slideId = createSlideId()
        const combined = notes.flatMap(({ note, properties, attached, attachHead }, index) => {
            const previous = notes[index - 1]?.properties
            const changed = previous && JSON.stringify(previous) !== JSON.stringify(properties)
            const isAttached = attached && kept.has(attachHead)
            return addNote(transaction, slideId, {
                ...note,
                // Other ticks are re-anchored by the interleaved slide; keep where they play.
                ...(isAttached ? undefined : positions.get(note)),
                ...properties,
                isAttached,
                isConnectorSeparator: note.isConnectorSeparator || !!changed,
            })
        })
        const result = transaction.commit([
            ...selected.filter((entity) => entity.type !== 'note'),
            ...combined,
        ])
        if (!kept.size) return result

        // Detach any span whose ticks would not play exactly where they did.
        const slide = result.store.slides.note.get(slideId) ?? []
        const ticks = slide.filter((note) => note.isAttached)
        const played = getMaterializedNotePositions(result, ticks)
        const moved = notes.filter(({ note, attached, attachHead }, index) => {
            if (!attached || !kept.has(attachHead)) return false
            const before = positions.get(note)
            const added = slide[index]
            const after = added && played.get(added)
            return !(
                before &&
                after &&
                nearlyEqual(before.left, after.left) &&
                nearlyEqual(before.size, after.size) &&
                nearlyEqual(before.elevation, after.elevation)
            )
        })
        if (!moved.length) return result
        for (const { attachHead } of moved) kept.delete(attachHead)
    }
}
