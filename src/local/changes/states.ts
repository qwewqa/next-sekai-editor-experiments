import type { State } from '../../state'
import type { EntityOfType, EntityType } from '../../state/entities'
import type { RecordValue } from '../records/canonical'
import {
    bpmRecord,
    cameraEventRecord,
    headerRecord,
    slideRecord,
    stageMaskEventRecord,
    stagePivotEventRecord,
    stageStyleEventRecord,
    stageTransformEventRecord,
    timeScaleRecord,
} from '../records/records'
import type { KindName } from '../records/schema'
import type { ChangeTotals, DiffInput, KindCandidates } from './diff'

// The page's narrowing: two states in memory, for entries not stored yet. States
// along one undo stack share every untouched slide and grid bucket, so only those that differ by
// identity give their records; unrelated states give all of theirs, which cancel in the diff.

type Rec = readonly RecordValue[]

type Joint = Exclude<KindName, 'slides'>

/** Each event kind's entity type, and its record encoder. */
export const joints: Record<Joint, [EntityType, (entity: never) => Rec]> = {
    bpms: ['bpm', bpmRecord],
    timeScales: ['timeScale', timeScaleRecord],
    cameraEvents: ['cameraEventJoint', cameraEventRecord],
    stageMaskEvents: ['stageMaskEventJoint', stageMaskEventRecord],
    stagePivotEvents: ['stagePivotEventJoint', stagePivotEventRecord],
    stageStyleEvents: ['stageStyleEventJoint', stageStyleEventRecord],
    stageTransformEvents: ['stageTransformEventJoint', stageTransformEventRecord],
}

const headerOf = (state: State) =>
    JSON.stringify(
        headerRecord(state, {
            bgmOffset: state.bgm.offset,
            levelInfo: state.levelInfo,
            ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
        }),
    )

/** The candidates for `diffChanges` from two states. */
export const stateCandidates = (before: State, after: State): DiffInput => {
    const kinds: KindCandidates[] = []
    const a = before.store
    const b = after.store
    if (a.slides.note !== b.slides.note) {
        const records: KindCandidates = { kind: 'slides', before: [], after: [] }
        const old = a.slides.note
        const next = b.slides.note
        for (const [id, notes] of old) {
            const other = next.get(id)
            if (other === notes) continue
            if (notes.length) (records.before as Rec[]).push(slideRecord(notes))
        }
        for (const [id, notes] of next) {
            if (old.get(id) === notes) continue
            if (notes.length) (records.after as Rec[]).push(slideRecord(notes))
        }
        if (records.before.length || records.after.length) kinds.push(records)
    }
    for (const [kind, [type, encode]] of Object.entries(joints) as [
        Joint,
        [EntityType, (entity: never) => Rec],
    ][]) {
        const old = a.grid[type] as Map<number, Set<EntityOfType<EntityType>>>
        const next = b.grid[type] as Map<number, Set<EntityOfType<EntityType>>>
        if (old === next) continue
        const gone = new Set<EntityOfType<EntityType>>()
        const come = new Set<EntityOfType<EntityType>>()
        for (const key of new Set([...old.keys(), ...next.keys()])) {
            const x = old.get(key)
            const y = next.get(key)
            if (x === y) continue
            for (const entity of x ?? []) gone.add(entity)
            for (const entity of y ?? []) come.add(entity)
        }
        if (!gone.size && !come.size) continue
        kinds.push({
            kind,
            before: [...gone].map((entity) => encode(entity as never)),
            after: [...come].map((entity) => encode(entity as never)),
        })
    }
    return { header: headerOf(before) !== headerOf(after), kinds }
}

/** A state's objects: its notes and its events of every kind. */
export const totalsOf = (state: State): ChangeTotals => {
    let notes = 0
    for (const slide of state.store.slides.note.values()) notes += slide.length
    let events = 0
    for (const [type] of Object.values(joints)) {
        const seen = new Set<unknown>()
        for (const bucket of state.store.grid[type].values())
            for (const entity of bucket) seen.add(entity)
        events += seen.size
    }
    return { notes, events }
}
