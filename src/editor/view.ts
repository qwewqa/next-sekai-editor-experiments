import { computed, shallowReactive, watch } from 'vue'
import { times } from '.'
import type { GroupId } from '../chart/groups'
import type { StageId } from '../chart/stages'
import { bpms } from '../history/bpms'
import { settings } from '../settings'
import type { Entity } from '../state/entities'
import { beatToTime, timeToBeat } from '../state/integrals/bpms'
import { time } from '../time'
import { computedArray } from '../utils/array'
import { align, clamp, lerp, unlerp } from '../utils/math'
import { optional } from '../utils/optional'
import { requestAudioPreview } from './audioPreview'
import { getComposedLayout } from './composedView'
import type { Modifiers } from './controls/gestures/pointer'
import { integrateScrollInertia } from './inertia'
import { editorNavigation, getControlBounds } from './navigation'
import type { ScopeOverride } from './scope'

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
    // Touch has no hover; it shows the marker only while dragging.
    isHoverHidden: matchMedia('(hover: none)').matches,
    cursorTime: 0,

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
const scrollLanes = (lane: number) => {
    const limit = settings.maxScrollX
    const extent = getComposedLayout()?.displayedExtent()
    if (!extent) return { min: -limit, max: limit }
    const half = settings.width / 2
    // A view left outside by an edit or zoom scrolls back without a jump.
    return {
        min: Math.min(-limit, extent.min + half, lane),
        max: Math.max(limit, extent.max - half, lane),
    }
}

// The reach always includes the lane itself, so a zero step skips computing it.
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

export const focusViewAtBeat = (beat: number) => {
    focusView(beatToTime(bpms.value, beat))
}

export const focusView = (t: number) => {
    view.cursorTime = t

    panView(t)
}

export const focusEntityAtBeat = (beat: number) => {
    const time = beatToTime(bpms.value, beat)
    requestAudioPreview(time)
    panView(time)
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

const yToBeat = (y: number) => timeToBeat(bpms.value, Math.max(0, yToTime(y)))

export const yToValidBeat = (y: number) => align(yToBeat(y), view.division)

// Further below beat 0 than snapping reaches; yToValidBeat clamps such presses to 0.
export const isBelowSnapping = (y: number) => {
    const first = bpms.value[0]
    return !!first && align(yToTime(y) / first.s, view.division) < 0
}

export const yToBeatOffset = (y: number, beat: number) =>
    view.snapping === 'absolute'
        ? align(yToBeat(y), view.division) - beat
        : align(yToBeat(y) - beat, view.division)

export const snapYToBeat = (y: number, beat: number) => Math.max(0, beat + yToBeatOffset(y, beat))
