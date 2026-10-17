import type { StageId } from '../../../src/chart/stages'
import type { State } from '../../../src/state'
import { toBpmIntegral } from '../../../src/state/integrals/bpms'

// What a state plays at one beat, read two ways: each track's chain (its connections from the
// range's first joint), which the serializer writes as `next`, and the grid's buckets sorted by
// beat, which the editor's preview player and the selection operations read. D4 needs both to
// agree, and BPMs' grid order to agree with the tempo integrals.

type Joint = { beat: number }

type StageJoint = Joint & { stageId: StageId }

const stageKinds = [
    ['stageMaskEventJoint', 'stageMaskEventConnection'],
    ['stagePivotEventJoint', 'stagePivotEventConnection'],
    ['stageStyleEventJoint', 'stageStyleEventConnection'],
    ['stageTransformEventJoint', 'stageTransformEventConnection'],
] as const

const gridEntities = <T>(grid: Map<number, Set<T>>) => {
    const entities = new Set<T>()
    for (const bucket of grid.values()) for (const entity of bucket) entities.add(entity)
    return [...entities]
}

const byBeat = <T extends Joint>(entities: T[]) => [...entities].sort((a, b) => a.beat - b.beat)

const chainFrom = <T extends Joint>(
    head: T | undefined,
    connections: Map<number, Set<{ min: T; max: T }>>,
) => {
    const next = new Map<T, T>()
    for (const { min, max } of gridEntities(connections)) next.set(min, max)
    const chain: T[] = []
    for (let joint = head; joint && !chain.includes(joint); joint = next.get(joint))
        chain.push(joint)
    return chain
}

/** Each track's joints: in chain order, and in the grid's order sorted by beat. */
export const stateTracks = (state: State) => {
    const { grid, globalEventRanges, stageEventRanges } = state.store
    const tracks = new Map<string, { chain: Joint[]; grid: Joint[] }>()
    tracks.set('camera', {
        chain: chainFrom(globalEventRanges.cameraEventJoint?.min, grid.cameraEventConnection),
        grid: byBeat(gridEntities(grid.cameraEventJoint)),
    })
    for (const [kind, connectionKind] of stageKinds) {
        const connections = grid[connectionKind] as unknown as Map<
            number,
            Set<{ min: Joint; max: Joint }>
        >
        const joints = gridEntities(grid[kind] as Map<number, Set<StageJoint>>)
        const stageIds = new Set([
            ...stageEventRanges[kind].keys(),
            ...joints.map((j) => j.stageId),
        ])
        for (const stageId of stageIds)
            tracks.set(`${kind}:${stageId}`, {
                chain: chainFrom(
                    stageEventRanges[kind].get(stageId)?.min as Joint | undefined,
                    connections,
                ),
                grid: byBeat(joints.filter((joint) => joint.stageId === stageId)),
            })
    }
    return tracks
}

/** Where a state's chains and grid disagree, or its BPM integrals and grid. */
export const stateOrderDifferences = (state: State) => {
    const differences: string[] = []
    for (const [track, { chain, grid }] of stateTracks(state))
        if (chain.length !== grid.length || chain.some((joint, i) => joint !== grid[i]))
            differences.push(`${track}: chain and grid differ`)
    const bpms = byBeat(gridEntities(state.store.grid.bpm)).map(toBpmIntegral)
    if (
        bpms.length !== state.bpms.length ||
        bpms.some((bpm, i) => bpm.x !== state.bpms[i]?.x || bpm.s !== state.bpms[i].s)
    )
        differences.push('bpm: grid and integrals differ')
    return differences
}

/** A track's joints at one beat, in chain order. */
export const chainAt = (state: State, track: string, beat: number) =>
    stateTracks(state)
        .get(track)
        ?.chain.filter((joint) => joint.beat === beat) ?? []
