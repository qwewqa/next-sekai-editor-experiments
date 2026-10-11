import { computed, shallowRef } from 'vue'
import { bpms } from '../history/bpms'
import { onResetState } from '../history/resetHooks'
import { settings } from '../settings'
import type { State } from '../state'
import type { Entity } from '../state/entities'
import type { BpmEntity } from '../state/entities/bpm'
import type { BpmIntegral, GridBpm } from '../state/integrals/bpms'
import { GLOBAL_GRID, toBeatGrid } from '../state/integrals/grid'
import { liftBpms } from '../state/mutations/bpm'

// Measure and Both show bars, so beats snap from them; Beat keeps the global grid.
export const isBarGrid = computed(() => settings.beatDisplay !== 'beat')

export const gridOf = (bpms: GridBpm[]) => (isBarGrid.value ? toBeatGrid(bpms) : GLOBAL_GRID)

type Lift = { source: BpmIntegral[]; bpms: GridBpm[]; drawn: boolean }

const lift = shallowRef<Lift>()

// Any commit since the press leaves it stale.
const activeLift = computed(() => (lift.value?.source === bpms.value ? lift.value : undefined))

/** The bars without the BPM changes being moved, frozen at the press. */
export const liftedBpms = computed(() => activeLift.value?.bpms)

/** The lifted bars, once the moved changes have left their beats. */
export const liftedDrawnBpms = computed(() =>
    activeLift.value?.drawn ? activeLift.value.bpms : undefined,
)

/** Moved BPM changes snap to the grid of what stays; the initial one never moves. */
export const liftForMove = (entities: readonly Entity[], source: Pick<State, 'store' | 'bpms'>) => {
    const moved = entities.filter(
        (entity): entity is BpmEntity => entity.type === 'bpm' && entity.beat !== 0,
    )
    lift.value = moved.length
        ? { source: bpms.value, bpms: liftBpms(source, moved), drawn: false }
        : undefined
}

export const setLiftDrawn = (drawn: boolean) => {
    const current = lift.value
    if (current && current.drawn !== drawn) lift.value = { ...current, drawn }
}

export const dropLift = () => {
    lift.value = undefined
}

onResetState(dropLift)

/** The committed chart's bar grid, whatever the display. */
export const committedBarGrid = computed(() => toBeatGrid(bpms.value))

/** The grid of the committed chart. */
export const committedGrid = computed(() => gridOf(bpms.value))

/** The grid pointers snap to: during a BPM change move, without the moved changes. */
export const snapGrid = computed(() => gridOf(liftedBpms.value ?? bpms.value))

/** A drag start that drops its lift if it throws. */
export const startingLift =
    <A extends unknown[], R>(start: (...args: A) => R) =>
    (...args: A): R => {
        try {
            return start(...args)
        } catch (error) {
            dropLift()
            throw error
        }
    }

/** A drag end that drops the lift after the drop, which it was built against, even on a throw. */
export const endingLift =
    <A extends unknown[]>(end: (...args: A) => void) =>
    (...args: A) => {
        try {
            end(...args)
        } finally {
            dropLift()
        }
    }
