import { watch } from 'vue'
import { state } from '../../history'
import { previewEdit } from '../../preview/edit'
import { settings } from '../../settings'
import { clamp } from '../../utils/math'
import { beginAudioPreviewInteraction } from '../audioPreview'
import { runCommand } from '../commands/runCommand'
import { zoomXIn } from '../commands/zooms/zoomXIn'
import { zoomXOut } from '../commands/zooms/zoomXOut'
import { zoomYIn } from '../commands/zooms/zoomYIn'
import { zoomYOut } from '../commands/zooms/zoomYOut'
import { closeContextMenu, openContextMenu } from '../contextMenu'
import { isElevationEditorOpen } from '../elevation/state'
import { editorNavigation, getControlBounds } from '../navigation'
import { cancelPreviewFollow, stopPlayer } from '../player'
import { sceneState } from '../sceneState'
import { scopeLookup } from '../scope'
import { switchToolTo, tool, toolName } from '../tools'
import { secondarySwitchBack } from '../tools/state'
import {
    scrollViewXBy,
    scrollViewYBy,
    setViewHover,
    setViewInput,
    snappingSources,
    updateViewPointer,
    view,
    viewBox,
} from '../view'
import { lockCursor, unlockCursor } from './cursor'
import { gesture } from './gestures/gesture'
import { drag, isDragging } from './gestures/recognizers/drag'
import { tap } from './gestures/recognizers/tap'
import { clearPageSelection } from './pageSelection'

const mouseGesture = gesture(drag(false), tap(Infinity))

export const hasMouseControls = () => mouseGesture.pointerCount > 0

// The pane a press started in; the press follows the mouse outside it until release.
let pressedPane: Element | undefined
// The event the window listeners already handled for the press.
let tracked: Event | undefined
const isTracked = (event: Event) => event === tracked && event.currentTarget !== window

const toP = (event: MouseEvent) => {
    // Outside its pane, a press stays at the pane's edge.
    const rect = pressedPane?.getBoundingClientRect()
    return {
        id: 1,
        x: rect ? clamp(event.clientX, rect.left, rect.right) : event.clientX,
        y: rect ? clamp(event.clientY, rect.top, rect.bottom) : event.clientY,
        modifiers: {
            // Cmd plays Ctrl's part on Apple platforms, where Ctrl+click is a right click.
            ctrl: event.ctrlKey || event.metaKey,
            shift: event.shiftKey,
        },
    }
}

const trackMove = (event: MouseEvent) => {
    tracked = event
    // A release the page never saw ends the press.
    if (event.buttons) mousemove(event)
    else mouseup(event)
}
const trackUp = (event: MouseEvent) => {
    tracked = event
    mouseup(event)
}
const stopTracking = () => {
    if (!pressedPane) return
    pressedPane = undefined
    removeEventListener('mousemove', trackMove, true)
    removeEventListener('mouseup', trackUp, true)
}

let switchingSecondaryTool = false
let contextClick: { x: number; y: number } | undefined
// The mouse rests over the chart, unpressed.
let isHovering = false

/** Ends the mouse's rest over the chart, as a touch takes over, and its ghosts unless pressed. */
export const endMouseHover = () => {
    isHovering = false
    if (mouseGesture.pointerCount || isDragging.value) return
    if (view.entities.hovered.length || view.entities.creating.length)
        view.entities = { hovered: [], creating: [] }
}

// Mouse events fired for a touch don't make the input a mouse.
const markMouseInput = (
    event: MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null },
) => {
    if (!event.sourceCapabilities?.firesTouchEvents) setViewInput('mouse')
}

export const cancelMouseControls = (restoreTool = true) => {
    if (switchingSecondaryTool) return
    contextClick = undefined
    closeContextMenu()
    mouseGesture.cancel()
    stopTracking()
    unlockCursor()
    const previous = secondarySwitchBack.value
    secondarySwitchBack.value = undefined
    if (restoreTool && previous) switchToolTo(previous)
}
// Opening the Elevation Editor ends a right press there, as its Select would if the tool changed.
watch(
    isElevationEditorOpen,
    (open) => {
        if (open && secondarySwitchBack.value) cancelMouseControls(false)
    },
    { flush: 'sync' },
)

const mousedown = (event: MouseEvent) => {
    isHovering = false
    markMouseInput(event)
    closeContextMenu()
    // Selected page text would keep its native copy over the objects pressed after it.
    clearPageSelection()
    const p = toP(event)
    updateViewPointer(p)

    view.scrollingY = undefined
    view.scrollingX = undefined
    view.scrollingPane = undefined
    stopPlayer(false)
    if (!mouseGesture.pointerCount) beginAudioPreviewInteraction()

    if (
        !mouseGesture.pointerCount &&
        event.buttons & 2 &&
        !secondarySwitchBack.value &&
        tool.value.secondaryTool !== false
    ) {
        secondarySwitchBack.value = toolName.value
        switchingSecondaryTool = true
        try {
            switchToolTo(
                settings.mouseSecondaryTool === 'selectContextMenu'
                    ? 'select'
                    : settings.mouseSecondaryTool,
            )
        } finally {
            switchingSecondaryTool = false
        }
    }

    if (
        settings.mouseSecondaryTool === 'selectContextMenu' &&
        tool.value.secondaryTool !== false &&
        !mouseGesture.pointerCount &&
        event.button === 2 &&
        event.buttons === 2 &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
    )
        contextClick = { x: p.x, y: p.y }

    // The press point is where dragStart decides; keep its cursor until release.
    if (!mouseGesture.pointerCount) {
        tool.value.press?.(p.x, p.y)
        lockCursor(tool.value.cursor?.(p.x, p.y) ?? 'default')
    }

    if (!pressedPane && event.currentTarget instanceof Element) {
        pressedPane = event.currentTarget
        addEventListener('mousemove', trackMove, true)
        addEventListener('mouseup', trackUp, true)
    }
    mouseGesture.start([p])

    event.preventDefault()
}

const mousemove = (event: MouseEvent) => {
    if (isTracked(event)) return
    const p = toP(event)
    updateViewPointer(p)
    if (contextClick && Math.hypot(p.x - contextClick.x, p.y - contextClick.y) > 20)
        contextClick = undefined

    if (mouseGesture.pointerCount) {
        mouseGesture.move([p])
    } else if (!isDragging.value) {
        isHovering = true
        markMouseInput(event)
        setViewHover(p.y)
        void tool.value.hover?.(p.x, p.y, p.modifiers)
    }

    event.preventDefault()
}

const mouseup = (event: MouseEvent) => {
    if (isTracked(event)) return
    const pane = pressedPane
    const p = toP(event)
    updateViewPointer(p)

    const showMenu =
        contextClick &&
        event.button === 2 &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        Math.hypot(p.x - contextClick.x, p.y - contextClick.y) <= 20
    contextClick = undefined
    if (showMenu) mouseGesture.cancel()
    else mouseGesture.end([p])

    if (!mouseGesture.pointerCount && secondarySwitchBack.value) {
        switchToolTo(secondarySwitchBack.value)
        secondarySwitchBack.value = undefined
    }
    if (!mouseGesture.pointerCount) {
        unlockCursor()
        stopTracking()
        // A release over the chart rests there again; leaving it does not.
        const over = pane ?? event.currentTarget
        if (event.type === 'mouseup' && over instanceof Element && event.target instanceof Node)
            isHovering = over.contains(event.target)
    }

    if (showMenu) openContextMenu(p.x, p.y)
    // A gesture that changed nothing still leaves the mouse resting here; a landed paste keeps
    // its ghost hidden until the mouse moves.
    else if (!mouseGesture.pointerCount && toolName.value !== 'paste') hoverAgain()
    event.preventDefault()
}

const mouseleave = (event: MouseEvent) => {
    isHovering = false
    contextClick = undefined
    // A press continues outside the pane; only its release lands it.
    if (pressedPane) return
    mouseup(event)
    // Off the pane, or over UI on it, a click hits nothing there, so nothing shows hovered.
    if (!isDragging.value && (view.entities.hovered.length || view.entities.creating.length))
        view.entities = { hovered: [], creating: [] }
}

const wheel = (event: WheelEvent) => {
    const bounds = getControlBounds(view)
    if (event.ctrlKey) {
        if (event.shiftKey) {
            if (event.deltaY) {
                if (event.deltaY > 0) {
                    void runCommand(zoomXOut)
                } else {
                    void runCommand(zoomXIn)
                }
            }
            if (event.deltaX) {
                if (event.deltaX > 0) {
                    void runCommand(zoomYOut)
                } else {
                    void runCommand(zoomYIn)
                }
            }
        } else {
            if (event.deltaY) {
                if (event.deltaY > 0) {
                    void runCommand(zoomYOut)
                } else {
                    void runCommand(zoomYIn)
                }
            }
            if (event.deltaX) {
                if (event.deltaX > 0) {
                    void runCommand(zoomXOut)
                } else {
                    void runCommand(zoomXIn)
                }
            }
        }
    } else {
        const mode = event.deltaMode
        if (event.shiftKey ? event.deltaX : event.deltaY) cancelPreviewFollow()
        if (event.shiftKey) {
            switch (mode) {
                case WheelEvent.DOM_DELTA_PIXEL:
                    scrollViewXBy(event.deltaY, settings.mouseSmoothScrolling)
                    if (event.deltaX) scrollViewYBy(-event.deltaX, settings.mouseSmoothScrolling)
                    break
                case WheelEvent.DOM_DELTA_LINE:
                    scrollViewXBy(event.deltaY * 20, settings.mouseSmoothScrolling)
                    if (event.deltaX)
                        scrollViewYBy(-(event.deltaX * 20), settings.mouseSmoothScrolling)
                    break
                case WheelEvent.DOM_DELTA_PAGE:
                    scrollViewXBy(event.deltaY * bounds.w, settings.mouseSmoothScrolling)
                    if (event.deltaX)
                        scrollViewYBy(-event.deltaX * bounds.h, settings.mouseSmoothScrolling)
                    break
            }
        } else {
            switch (mode) {
                case WheelEvent.DOM_DELTA_PIXEL:
                    scrollViewXBy(event.deltaX, settings.mouseSmoothScrolling)
                    if (event.deltaY) scrollViewYBy(-event.deltaY, settings.mouseSmoothScrolling)
                    break
                case WheelEvent.DOM_DELTA_LINE:
                    scrollViewXBy(event.deltaX * 20, settings.mouseSmoothScrolling)
                    if (event.deltaY)
                        scrollViewYBy(-(event.deltaY * 20), settings.mouseSmoothScrolling)
                    break
                case WheelEvent.DOM_DELTA_PAGE:
                    scrollViewXBy(event.deltaX * bounds.w, settings.mouseSmoothScrolling)
                    if (event.deltaY)
                        scrollViewYBy(-event.deltaY * bounds.h, settings.mouseSmoothScrolling)
                    break
            }
        }
    }

    event.preventDefault()
}

/** Hovers again under a resting mouse; a tool without a hover, such as a dialog's, shows none. */
export const hoverAgain = () => {
    if (!isHovering || view.isHoverHidden) return
    if (mouseGesture.pointerCount || isDragging.value) return
    const { x, y, modifiers } = view.pointer
    setViewHover(y)
    if (tool.value.hover) void tool.value.hover(x, y, modifiers)
    else view.entities = { hovered: [], creating: [] }
}

// Scrolling under a still mouse, as playback, the wheel or a pan does, moves what it hovers.
watch([viewBox, () => view.x, () => view.y], () => {
    if (!editorNavigation.value) hoverAgain()
})

// A snapping, lane limit or layout change under a still mouse moves where a click lands, in either pane.
watch(
    [...snappingSources, () => settings.elevationSnap, () => settings.maxLane, () => view.layout],
    hoverAgain,
)

// The hover previews a tap, which edits, undo, selection and scope changes all move. A landed
// paste keeps its ghost hidden until the mouse moves.
watch(
    [state, sceneState, scopeLookup, () => view.visibilities, () => settings.showOtherObjects],
    () => {
        if (toolName.value !== 'paste') hoverAgain()
    },
)
watch(tool, hoverAgain)
// A Composed paste ghost hidden during a draft is placed again once the draft ends.
watch(
    () => !!previewEdit.value?.isDraft,
    (draft, was) => {
        if (was && !draft && toolName.value === 'paste') hoverAgain()
    },
)

// Ctrl and Shift change what a tap would act on; the hover follows them without a move.
const followModifiers = (event: KeyboardEvent) => {
    const modifiers = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }
    const { ctrl, shift } = view.pointer.modifiers
    if (modifiers.ctrl === ctrl && modifiers.shift === shift) return
    view.pointer = { ...view.pointer, modifiers }
    hoverAgain()
}
addEventListener('keydown', followModifiers)
addEventListener('keyup', followModifiers)
// A key released in another window never reaches this one.
addEventListener('blur', () => {
    view.pointer = { ...view.pointer, modifiers: { ctrl: false, shift: false } }
    hoverAgain()
})

export const mouseControlListeners = {
    mousedown,
    mousemove,
    mouseup,
    mouseleave,
    wheel,
}
