import { ref, watch } from 'vue'
import { replaceState, state } from '../../../../history'
import { settings } from '../../../../settings'
import { time } from '../../../../time'
import { unlerp } from '../../../../utils/math'
import { editorNavigation, getControlBounds } from '../../../navigation'
import { clearNotification, notification } from '../../../notification'
import { quickScrollWidth } from '../../../quickScroll'
import { tool, type Tool } from '../../../tools'
import {
    scrollViewXBy,
    scrollViewYBy,
    setViewHover,
    snappingSources,
    view,
    viewBox,
} from '../../../view'
import type { HoldPoint, Modifiers } from '../pointer'
import type { Recognizer } from './recognizer'

export const isDragging = ref(0)

// Counts view moves the chart's own view box doesn't show, such as another pane's scroll.
const paneMoves = ref(0)
export const notifyPaneMoved = () => {
    paneMoves.value++
}

// An edge zone's inner bounds, moved to a held start point inside it.
const panZone = (held: number | undefined) => ({
    low: Math.min(0.2, held ?? 1),
    high: Math.max(0.8, held ?? 0),
})
// A point inside an edge zone, else none.
const holdIn = (p: number) => (p < 0.2 || p > 0.8 ? p : undefined)

export const drag = (quickScroll: boolean, hold?: HoldPoint): Recognizer<1> => {
    // A scroll follows the finger; the tool gets the held point.
    const toolPoint = (id: number, x: number, y: number) => hold?.(id, x, y) ?? { x, y }
    const updates: {
        t: number
        dy: number
    }[] = []
    let active:
        | {
              type: 'drag'
              id: number
              tool: Tool
              state: (typeof state)['value']
              // The last notice the drag posted, if any.
              notice?: number
              // The touch marker before the drag, back on a cancel.
              marker: (typeof view)['touchMarker']
              pointer: { x: number; y: number; modifiers: Modifiers }
          }
        | {
              type: 'scroll'
              sy: number
              id: number
          }
        | undefined

    let update:
        | {
              x: number
              y: number
              modifiers: Modifiers
          }
        | undefined
    // Where a drag started inside an edge zone; it pans that way only from deeper.
    let held: { x?: number; y?: number } = {}

    watch(time, ({ delta }) => {
        if (!update) return
        const { x, y, modifiers } = update
        const bounds = getControlBounds(view)

        let updated = 0

        if (settings.dragToPanX) {
            const px = (x - bounds.x) / bounds.w
            if (holdIn(px) === undefined) held.x = undefined
            const { low, high } = panZone(held.x)
            if (px < low) {
                scrollViewXBy(-unlerp(low, 0, px) * bounds.w * delta)
                updated++
            } else if (px > high) {
                scrollViewXBy(unlerp(high, 1, px) * bounds.w * delta)
                updated++
            }
        }

        if (settings.dragToPanY) {
            const py = (y - bounds.y) / bounds.h
            if (holdIn(py) === undefined) held.y = undefined
            const { low, high } = panZone(held.y)
            if (py < low) {
                scrollViewYBy(unlerp(low, 0, py) * bounds.h * delta)
                updated++
            } else if (py > high) {
                scrollViewYBy(-unlerp(high, 1, py) * bounds.h * delta)
                updated++
            }
        }

        if (active?.type === 'drag') updateDrag(x, y, modifiers)

        if (!updated) {
            update = undefined
        }
    })

    const updateDrag = (x: number, y: number, modifiers: Modifiers) => {
        if (active?.type !== 'drag') return
        const before = notification.value.id
        active.tool.dragUpdate?.(x, y, modifiers)
        if (notification.value.id !== before) active.notice = notification.value.id
    }

    // A scroll, zoom or snapping change under a still pointer moves where the drag lands.
    watch([viewBox, paneMoves, ...snappingSources, () => settings.elevationSnap], () => {
        if (active?.type !== 'drag' || update) return
        const { x, y, modifiers } = active.pointer
        updateDrag(x, y, modifiers)
    })

    return {
        count: 1,

        recognize([id, { isActive, sx, sy, x, y, modifiers }]) {
            if (!isActive) return false
            if (Math.hypot(x - sx, y - sy) <= 20) return false

            const bounds = getControlBounds(view)
            // Where the press landed decides, not where it was recognized.
            if (!quickScroll || sx - bounds.x <= bounds.w - quickScrollWidth(bounds.w)) {
                // Tools hold one drag; another input's drag leaves this press inert.
                if (isDragging.value) return true
                const startState = state.value
                const noticeBefore = notification.value.id
                // Its focus marks where it lands; a cursor marker holds while the cursor does.
                const marker = view.touchMarker
                if (!editorNavigation.value && marker?.kind === 'entity')
                    view.touchMarker = undefined
                const kept = view.touchMarker
                if (!tool.value.dragStart?.(sx, sy, modifiers)) {
                    view.touchMarker = marker
                    return true
                }

                isDragging.value++
                held = {
                    x: holdIn((sx - bounds.x) / bounds.w),
                    y: holdIn((sy - bounds.y) / bounds.h),
                }

                const at = toolPoint(id, x, y)
                // Shows the finger, not the start's focus marker, before the first update.
                if (view.touchMarker !== kept) setViewHover(at.y)
                active = {
                    type: 'drag',
                    id,
                    tool: tool.value,
                    state: startState,
                    notice:
                        notification.value.id !== noticeBefore ? notification.value.id : undefined,
                    marker,
                    pointer: { ...at, modifiers },
                }
                update = {
                    ...at,
                    modifiers,
                }
                return true
            } else {
                active = {
                    type: 'scroll',
                    sy,
                    id,
                }
                return true
            }
        },

        update(pointers) {
            if (!active) return

            const p = pointers.get(active.id)
            if (!p) return

            if (active.type === 'drag') {
                const { x, y } = toolPoint(active.id, p.x, p.y)
                if (p.isActive) {
                    update = {
                        x,
                        y,
                        modifiers: p.modifiers,
                    }
                    active.pointer = update
                } else {
                    isDragging.value--
                    const completed = active.tool
                    active = undefined
                    update = undefined
                    // Committing changes history synchronously. Boundary
                    // watchers must not cancel this already completed drag.
                    void completed.dragEnd?.(x, y, p.modifiers)
                }
            } else {
                // A quick scroll is vertical only.
                const dy = p.y - active.sy
                scrollViewYBy(dy)
                updates.push({
                    t: time.value.now,
                    dy,
                })
                active.sy = p.y
            }
        },

        reset(cancelled) {
            if (cancelled && active?.type === 'drag') {
                isDragging.value--
                const cancelled = active
                active = undefined
                update = undefined
                cancelled.tool.dragCancel?.()
                // Its own notice, such as "Moving", no longer holds.
                if (notification.value.id === cancelled.notice) clearNotification()
                // Selection tools update the current selection while dragging.
                // Restore it only if no committed edit/reset replaced the store.
                if (
                    state.value.store === cancelled.state.store &&
                    state.value.selectedEntities !== cancelled.state.selectedEntities
                ) {
                    replaceState({
                        ...state.value,
                        selectedEntities: cancelled.state.selectedEntities,
                    })
                }
                view.selection = undefined
                view.entities = { hovered: [], creating: [] }
                if (view.input === 'touch') view.touchMarker = cancelled.marker
            }
            if (!cancelled && active?.type === 'scroll' && settings.touchScrollInertia) {
                const dy = updates
                    .filter(({ t }) => time.value.now - t <= 0.1)
                    .reduce((sum, { dy }) => sum + dy, 0)
                view.scrollingY = {
                    type: 'inertia',
                    value: dy / 0.1,
                }
            }

            updates.length = 0
            active = undefined
            update = undefined
        },
    }
}
