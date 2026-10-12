import { computed, shallowReactive, watch } from 'vue'
import { times } from '.'
import type { GroupId } from '../chart/groups'
import type { StageId } from '../chart/stages'
import { bpms } from '../history/bpms'
import { onResetState } from '../history/resetHooks'
import { settings } from '../settings'
import type { Entity } from '../state/entities'
import { beatToTime, timeToBeat } from '../state/integrals/bpms'
import { cleanBeat, isGlobalGrid, snapBeat } from '../state/integrals/grid'
import { time } from '../time'
import { computedArray } from '../utils/array'
import { align, clamp, lerp, unlerp } from '../utils/math'
import { optional } from '../utils/optional'
import { requestAudioPreview } from './audioPreview'
import { committedBarGrid, committedGrid } from './beatGrid'
import { getComposedLayout } from './composedView'
import type { Modifiers } from './controls/gestures/pointer'
import { integrateScrollInertia } from './inertia'
import { editorNavigation, getControlBounds } from './navigation'
import type { ScopeOverride } from './scope'
import { snappedOffset } from './snapping'

export type Selection = {
    laneMin: number
    laneMax: number
    timeMin: number
    timeMax: number
}

export type EditorLayout = 'basic' | 'composed'

export const view = shallowReactive({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    layout: 'basic' as EditorLayout,
    time: 0,
    hoverTime: 0,
    // Touch has no hover; a drag shows it, and a tap leaves the touch marker.
    isHoverHidden: matchMedia('(hover: none)').matches,
    cursorTime: 0,
    // Where a touch tap placed the cursor or found an entity, shown while the hover is hidden.
    touchMarker: optional<{ kind: 'cursor' | 'entity'; beat: number }>(),
    // The chart's last pointer input; keys leave it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    input: (matchMedia('(hover: none)').matches ? 'touch' : 'mouse') as 'mouse' | 'touch',

    lane: 0,

    x: 0,
    y: 0,
    w: 0,
    h: 0,

    noteSize: 3,
    division: 4,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    snapping: 'absolute' as 'absolute' | 'relative',
    laneDivision: 1,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    laneSnapping: 'absolute' as 'absolute' | 'relative',

    groupId: optional<GroupId>(),
    stageId: optional<StageId>(),
    // Saved All-view visibility choices; isolation never modifies them. See scope.ts.
    groupVisibility: new Map() as ReadonlyMap<GroupId, ScopeOverride>,
    stageVisibility: new Map() as ReadonlyMap<StageId, ScopeOverride>,

    visibilities: {
        bpm: true,
        timeScale: true,

        cameraEventJoint: true,
        cameraEventConnection: true,

        stageMaskEventJoint: true,
        stageMaskEventConnection: true,

        stagePivotEventJoint: true,
        stagePivotEventConnection: true,

        stageStyleEventJoint: true,
        stageStyleEventConnection: true,

        stageTransformEventJoint: true,
        stageTransformEventConnection: true,

        note: true,
        connector: true,
    },

    pointer: {
        x: 0,
        y: 0,
        modifiers: { ctrl: false, shift: false },
    },
    selection: optional<Selection>(),
    entities: {
        hovered: new Array<Entity>(),
        creating: new Array<Entity>(),
    },

    lastActive: 0,

    scrollingX: optional<
        | {
              type: 'inertia'
              value: number
          }
        | {
              type: 'ease'
              from: {
                  time: number
                  viewLane: number
              }
              to: {
                  time: number
                  viewLane: number
              }
          }
    >(),
    scrollingY: optional<
        | {
              type: 'inertia'
              value: number
          }
        | {
              type: 'ease'
              from: {
                  time: number
                  viewTime: number
              }
              to: {
                  time: number
                  viewTime: number
              }
          }
    >(),
})

// Under reduced motion, eased scrolls jump to their end unless smooth scrolling is chosen.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const isInstant = () => reducedMotion.matches && !settings.mouseSmoothScrolling

watch(time, ({ now, delta }) => {
    if (view.scrollingX) {
        switch (view.scrollingX.type) {
            case 'inertia': {
                if (!view.scrollingX.value) {
                    view.scrollingX = undefined
                    break
                }

                const motion = integrateScrollInertia(view.scrollingX.value, delta)
                scrollViewXBy(motion.distance)
                view.scrollingX.value = motion.velocity
                break
            }
            case 'ease': {
                if (now >= view.scrollingX.to.time || isInstant()) {
                    view.lane = view.scrollingX.to.viewLane
                    view.scrollingX = undefined
                    break
                }

                view.lane = lerp(
                    view.scrollingX.from.viewLane,
                    view.scrollingX.to.viewLane,
                    1 - (1 - unlerp(view.scrollingX.from.time, view.scrollingX.to.time, now)) ** 2,
                )
                break
            }
        }
    }

    if (view.scrollingY) {
        switch (view.scrollingY.type) {
            case 'inertia': {
                if (!view.scrollingY.value) {
                    view.scrollingY = undefined
                    break
                }

                const motion = integrateScrollInertia(view.scrollingY.value, delta)
                scrollViewYBy(motion.distance)
                view.scrollingY.value = motion.velocity
                break
            }
            case 'ease': {
                if (now >= view.scrollingY.to.time || isInstant()) {
                    view.time = view.scrollingY.to.viewTime
                    view.scrollingY = undefined
                    break
                }

                view.time = lerp(
                    view.scrollingY.from.viewTime,
                    view.scrollingY.to.viewTime,
                    1 - (1 - unlerp(view.scrollingY.from.time, view.scrollingY.to.time, now)) ** 2,
                )
                break
            }
        }
    }
})

export const hoveredEntities = computedArray(() => view.entities.hovered)

export const isViewRecentlyActive = computed(() => time.value.now - view.lastActive < 0.5)

export const viewBox = computed(() => {
    const w = settings.width
    const h = (view.h / view.w) * w

    const l = -0.5 * w + view.lane
    const r = 0.5 * w + view.lane

    const y = -(view.time * settings.pps) / view.h
    const t = (y - 0.5) * h
    const b = (y + 0.5) * h

    const ups = -(settings.pps / view.h) * h

    return {
        w,
        h,

        l,
        r,

        y,
        t,
        b,

        ups,
    }
})

export const ups = computed(() => viewBox.value.ups)

// Composed also reaches the displayed chart, which stages can move past Max Scroll X.
const scrollReach = () => {
    const limit = settings.maxScrollX
    const extent = getComposedLayout()?.displayedExtent()
    if (!extent) return { min: -limit, max: limit }
    const half = settings.width / 2
    return { min: Math.min(-limit, extent.min + half), max: Math.max(limit, extent.max - half) }
}

const scrollLanes = (lane: number) => {
    const { min, max } = scrollReach()
    // A view left outside by an edit or zoom scrolls back without a jump.
    return { min: Math.min(min, lane), max: Math.max(max, lane) }
}

// A zero step keeps the lane without computing the reach, even past Basic's Max Scroll X.
const scrolledLane = (lane: number, delta: number) => {
    if (delta === 0) return lane
    const lanes = scrollLanes(lane)
    return clamp(lane + delta, lanes.min, lanes.max)
}

/** Returns a view scrolled past Basic's range, as Composed allows, into it. */
export const clampViewLane = () => {
    if (getComposedLayout() || Math.abs(view.lane) <= settings.maxScrollX) return
    view.scrollingX = undefined
    view.lane = clamp(view.lane, -settings.maxScrollX, settings.maxScrollX)
}

/** Brings the view, and any eased sideways scroll, within a reach that has just shrunk. */
export const clampViewToReach = () => {
    const { min, max } = scrollReach()
    // An ease aimed past the reach stops where it is; a new target would bend its curve back.
    const target = view.scrollingX?.type === 'ease' ? view.scrollingX.to.viewLane : undefined
    if (target !== undefined && (target < min || target > max)) view.scrollingX = undefined
    if (view.lane >= min && view.lane <= max) return
    view.scrollingX = undefined
    view.lane = clamp(view.lane, min, max)
}

// A newly loaded chart opens within its own reach, with no sideways scroll or touch marker left from the last one.
onResetState(() => {
    view.scrollingX = undefined
    view.touchMarker = undefined
    clampViewToReach()
})

export const scrollViewXBy = (dx: number, smooth = false) => {
    updateViewLastActive()
    const laneScale =
        editorNavigation.value?.getScaleX?.() ?? getControlBounds(view).w / settings.width

    if (smooth) {
        const base = view.scrollingX?.type === 'ease' ? view.scrollingX.to.viewLane : view.lane
        view.scrollingX = {
            type: 'ease',
            from: {
                time: time.value.now,
                viewLane: view.lane,
            },
            to: {
                time: time.value.now + 0.25,
                viewLane: scrolledLane(base, dx / laneScale),
            },
        }
    } else {
        view.lane = scrolledLane(view.lane, dx / laneScale)
    }
}

export const scrollViewYBy = (dy: number, smooth = false) => {
    updateViewLastActive()

    if (editorNavigation.value) {
        editorNavigation.value.scrollY(dy)
        return
    }

    if (smooth) {
        view.scrollingY = {
            type: 'ease',
            from: {
                time: time.value.now,
                viewTime: view.time,
            },
            to: {
                time: time.value.now + 0.25,
                viewTime: Math.max(
                    0,
                    (view.scrollingY?.type === 'ease' ? view.scrollingY.to.viewTime : view.time) +
                        dy / settings.pps,
                ),
            },
        }
    } else {
        view.time = Math.max(0, view.time + dy / settings.pps)
    }
}

export const setViewHover = (y: number) => {
    if (editorNavigation.value) return
    view.hoverTime = Math.max(0, yToTime(y))
    view.isHoverHidden = false
}

export const hideViewHover = () => {
    view.isHoverHidden = true
}

// Mouse input clears the touch marker, which only touch sets.
export const setViewInput = (input: 'mouse' | 'touch') => {
    view.input = input
    if (input === 'mouse') view.touchMarker = undefined
}

// Drags refocus every frame; an unchanged marker is left as it is.
const markTouch = (kind: 'cursor' | 'entity', beat: number) => {
    if (view.input !== 'touch' || editorNavigation.value) return
    if (view.touchMarker?.kind === kind && view.touchMarker.beat === beat) return
    view.touchMarker = { kind, beat }
}

/** Marks an entity's beat for touch, without a focus's audio preview or pan. */
export const markTouchBeat = (beat: number) => {
    markTouch('entity', beat)
}

export const focusViewAtBeat = (beat: number) => {
    focusView(beatToTime(bpms.value, beat))
    markTouch('cursor', beat)
}

export const focusView = (t: number) => {
    view.cursorTime = t

    panView(t)
}

export const focusEntityAtBeat = (beat: number) => {
    const time = beatToTime(bpms.value, beat)
    requestAudioPreview(time)
    panView(time)
    markTouch('entity', beat)
}

const panView = (t: number) => {
    updateViewLastActive()

    if (t >= times.value.min && t <= times.value.max) return

    view.scrollingY = {
        type: 'ease',
        from: {
            time: time.value.now,
            viewTime: view.time,
        },
        to: {
            time: time.value.now + 0.25,
            viewTime: t,
        },
    }
}

export const updateViewPointer = (pointer?: { x: number; y: number; modifiers?: Modifiers }) => {
    if (!pointer) return

    view.pointer = {
        x: pointer.x,
        y: pointer.y,
        modifiers: pointer.modifiers ?? view.pointer.modifiers,
    }

    updateViewLastActive()
}

export const updateViewLastActive = () => {
    view.lastActive = time.value.now
}

export const xToLane = (x: number) => ((x - view.x) / view.w - 0.5) * settings.width + view.lane

export const alignLane = (lane: number) => align(lane, view.laneDivision)

export const xToValidLane = (x: number) => alignLane(xToLane(x))

export const yToTime = (y: number) => (0.5 * view.h - y + view.y) / settings.pps + view.time

export const yToBeat = (y: number) => timeToBeat(bpms.value, Math.max(0, yToTime(y)))

// What moves where a still pointer snaps, for the watches that re-run it.
export const snappingSources = [
    () => view.division,
    () => committedGrid.value,
    () => view.snapping,
    () => view.laneDivision,
    () => view.laneSnapping,
] as const

export const yToValidBeat = (y: number) => snapBeat(committedGrid.value, yToBeat(y), view.division)

// Further below beat 0 than snapping reaches; yToValidBeat clamps such presses to 0.
export const isBelowSnapping = (y: number) => {
    const first = bpms.value[0]
    return !!first && align(yToTime(y) / first.s, view.division) < 0
}

export const yToBeatOffset = (y: number, beat: number) =>
    view.snapping === 'absolute'
        ? snapBeat(committedGrid.value, yToBeat(y), view.division) - beat
        : align(yToBeat(y) - beat, view.division)

/**
 * A move's beat offset, from the pointer's movement since its press, as for lanes:
 * relative snapping steps by it; absolute snaps the grabbed beat moved by it, once
 * that reaches half a step.
 */
export const yToMoveBeatOffset = (y: number, beat: number, pressBeat: number) => {
    const pointer = yToBeat(y)
    const grid = committedGrid.value
    // Past the half-step wait, it lands on the bar grid's nearest line.
    if (
        view.snapping === 'absolute' &&
        Math.abs(pointer - pressBeat) * view.division >= 0.5 &&
        !isGlobalGrid(grid, view.division)
    )
        return snapBeat(grid, beat + pointer - pressBeat, view.division) - beat
    return snappedOffset(
        pressBeat,
        pointer,
        beat,
        view.division,
        view.snapping,
        pointer - pressBeat,
    )
}

// A moved or pasted beat, without float noise on a small fraction, the grid, or the chart's bars
// as other content may sit there in the Beat display; unmoved, it stays exact.
export const toMovedBeat = (beat: number, offset: number) => {
    if (offset === 0) return beat
    const grid = committedGrid.value
    const bars = committedBarGrid.value
    return cleanBeat(grid === bars ? [grid] : [grid, bars], beat + offset, view.division)
}

export const snapYToBeat = (y: number, beat: number, pressBeat: number) =>
    Math.max(0, toMovedBeat(beat, yToMoveBeatOffset(y, beat, pressBeat)))
