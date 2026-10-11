import type { State } from '..'
import { buildPreviewChart } from '../../preview/engine/chart'
import { getStageProps } from '../../preview/engine/stage'
import type { Entity } from '../entities'
import { createSlideId } from '../entities/slides'
import type { NoteEntity } from '../entities/slides/note'
import { beatToTime } from '../integrals/bpms'
import { addNote, removeNote } from '../mutations/slides/note'
import { createTransaction } from '../transaction'
import { connectorProperties } from './connectorProperties'
import { getDetachedNotePositions } from './notePositions'

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
    const ticks = new Map<number, typeof unordered>()
    for (const item of unordered) {
        if (!item.attached) continue
        const list = ticks.get(item.note.slideId) ?? []
        list.push(item)
        ticks.set(item.note.slideId, list)
    }
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
    const positions = getDetachedNotePositions(
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
    // A heuristic that keeps most joins attached: slides ending at the beat come first and slides
    // starting there last, each by elevation; on a tie, one whose span across the beat's edge has
    // ticks goes outermost.
    const rank = (notes: typeof unordered) => {
        const first = notes.some((item) => item.first)
        const last = notes.some((item) => item.last)
        return first === last ? 1 : last ? 0 : 2
    }
    const outermost = (notes: typeof unordered, rank: number) => {
        const [first] = notes
        if (!first || rank === 1) return 0
        const block = new Set(notes.map(({ note }) => note))
        const crosses = ticks
            .get(first.note.slideId)
            ?.some(({ attachHead, attachTail }) =>
                rank === 0
                    ? block.has(attachTail) && !block.has(attachHead)
                    : block.has(attachHead) && !block.has(attachTail),
            )
        return crosses ? rank - 1 : 0
    }
    const notes = [...byBeat]
        .sort(([a], [b]) => a - b)
        .flatMap(([, slides]) => {
            const blocks = [...slides.values()]
            if (blocks.length < 2) return blocks.flat()
            return blocks
                .map((notes) => {
                    const order = rank(notes)
                    const tie = outermost(notes, order)
                    return { notes, elevation: elevation(notes[0]), rank: order, tie }
                })
                .sort((a, b) => a.rank - b.rank || a.elevation - b.elevation || a.tie - b.tie)
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
    return transaction.commit([...selected.filter((entity) => entity.type !== 'note'), ...combined])
}
