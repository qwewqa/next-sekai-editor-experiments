<script setup lang="ts">
import {
    computed,
    onMounted,
    onUnmounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
    watchEffect,
} from 'vue'
import { interruptsDrags, isAppActive } from '../../activity'
import { updateClipboard } from '../../clipboard'
import { pushState, replaceState, state } from '../../history'
import { defaultGroupId } from '../../history/groups'
import { i18n } from '../../i18n'
import OffscreenNoteIndicators from '../OffscreenNoteIndicators.vue'
import {
    hitOffscreenIndicator,
    selectOffscreenNotes,
    useOffscreenIndicators,
} from '../offscreenIndicators'
import {
    groupOffscreenEdgeNotes,
    groupOffscreenNotes,
    isSameOffscreenGroups,
    offscreenSlotNear,
    offscreenBadgeHitWidth,
    type OffscreenNoteGroup,
} from '../offscreenNotes'
import { modals } from '../../modals'
import { isChromium } from '../../utils/browser'
import {
    confirmOnEnter,
    resyncInput,
    revertOnEscape,
    trackTypedText,
} from '../../modals/form/resync'
import { clearPreviewEdit, previewEdit, setPreviewEdit } from '../../preview/edit'
import { settings } from '../../settings'
import type { State } from '../../state'
import { hasSameChartData } from '../../state/data'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime } from '../../state/integrals/bpms'
import { nearGridBeat, snapBeat, stepGridBeat } from '../../state/integrals/grid'
import { editSelectedNote } from '../../state/operations/note'
import { getNoteFieldsIn } from '../../state/operations/properties/noteFields'
import { editChanges } from '../../state/operations/properties/plan'
import { createTransaction } from '../../state/transaction'
import { isComposingKey } from '../../utils/composition'
import { alignComputed, clamp, shiftComputed } from '../../utils/math'
import { committedGrid } from '../beatGrid'
import { createNameLayer, placeNames } from '../canvas/names'
import { createLabelSprites } from '../canvas/labelSprites'
import {
    clearTextWidths,
    FIGURE_MIDDLE,
    measureFigureMiddle,
    measureTextMiddle,
} from '../canvas/text'
import { createNoteRenderer } from '../canvas/notes'
import { compareShapeDistance, shapeDistance, shownNoteHitShape } from '../hitModel'
import { toCommittedEntity, toSceneEntity } from '../sceneState'
import { chartBackground } from '../canvas/nameColors'
import { createFrameScheduler } from '../canvas/surface'
import type { EditorDrawContext } from '../canvas/types'
import { getComposedLayout } from '../composedView'
import { activateEditorNavigation, controlsForNavigation, useCanvasCursor } from '../controls'
import { cancelMouseControls, hoverAgain } from '../controls/mouse'
import { cancelTouchControls } from '../controls/touch'
import type { Modifiers } from '../controls/gestures/pointer'
import { notifyPaneMoved } from '../controls/gestures/recognizers/drag'
import { editorNavigation, type EditorNavigation } from '../navigation'
import { closeContextMenu, contextMenu } from '../contextMenu'
import { constrainLaneObject, minimumNoteSize } from '../laneLimits'
import { isSidebarVisible, revealPropertiesSection } from '../sidebars'
import { panelTools, tools, toolName, type Tool } from '../tools'
import { applyBrushToEntities } from '../tools/brush'
import { hasWaitingPaste, pasteGhostInfos, waitToPaste } from '../tools/paste'
import { remove } from '../tools/eraser'
import { applyGeneratedSlideNotes } from '../tools/generateSlideNotes'
import { defaultNoteProperties } from '../tools/note'
import { defaultSlideProperties } from '../tools/slide'
import SelectionPropertiesModal from '../workspace/properties/SelectionPropertiesModal.vue'
import { quickEdit } from '../utils/quickEdit'
import LevelEditorToolbar from '../toolbar/LevelEditorToolbar.vue'
import EditorToolModalHost from '../EditorToolModalHost.vue'
import LevelEditorNotification from '../LevelEditorNotification.vue'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import CloseIcon from '../workspace/CloseIcon.vue'
import { hasToolModal, showToolModal } from '../toolModals'
import type { CommandName } from '../commands'
import { deselect } from '../commands/deselect'
import { fromDisplayedBeat, shortDisplayedBeat } from '../beatDisplay'
import { stepTapCycle, tapCycleSlack, type TapCycle } from '../tapCycle'
import { isNoteResizeStart, modifyEntities, offset, resize, resizeShift } from '../tools/utils'
import { scopeLookup } from '../scope'
import { isScopeReduced } from '../scopeRules'
import { dockKeysAttribute, isInWorkspaceDock } from '../workspace'
import { alignLane, view, focusViewAtBeat, hoveredEntities } from '../view'
import {
    elevationGridDivision,
    snapElevation,
    sameBeat,
    type ElevationNote,
    type ElevationRow,
} from './layout'
import {
    createElevationNote,
    elevationAddOrigin,
    elevationNoteMinimum,
    pasteElevationNotes,
    previewElevationNoteRow,
    previewElevationPasteRows,
} from './actions'
import {
    elevationLaneScale,
    elevationLayout,
    elevationNotes,
    elevationStageGrid,
    elevationState,
    getElevationStageProps,
} from './scene'
import {
    closeElevationEditor,
    elevationBeat,
    elevationToolNames,
    isElevationEditorOpen,
    isElevationSideBySide,
} from './state'
import {
    elevationBounds,
    elevationSelection,
    elevationViewport,
    fitElevationViewport,
    needsElevationFit,
} from './viewport'
import { drawElevationConnections, getElevationConnections } from './connections'
import SelectValue from '../../modals/form/SelectValue.vue'
import SquareGridIcon from './SquareGridIcon.vue'
import { elevationMoveDelta, inverseAttachedElevation, type AttachedElevationDrag } from './drag'

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const container = useTemplateRef<HTMLElement>('container')
const header = useTemplateRef<HTMLDivElement>('header')
const beatInput = useTemplateRef<HTMLInputElement>('beatInput')
const headerHeight = ref(80)
// Header controls follow the workspace chrome language: compact dark icon
// buttons whose hit area grows to 36px (fine) or 44px (coarse), and white
// pill fields with an accent focus ring on the dark band.
const headerIconButton =
    "relative flex size-8 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors before:absolute before:-inset-0.5 before:content-[''] hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:bg-accent active:text-on-accent disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:before:-inset-1.5"
// 1:1 is a toggle, so it rests as a raised pill, as other buttons and the fields do.
const headerButton =
    "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-button text-fg shadow-md outline-none -outline-offset-2 transition-colors before:absolute before:-inset-0.5 before:content-[''] hover:shadow-accent focus-visible:ring-2 focus-visible:ring-accent active:bg-accent active:text-on-accent [@media(pointer:coarse)]:before:-inset-1.5"
const headerField =
    'elevation-field h-8 w-20 appearance-none rounded-full bg-button px-3 text-base text-fg tabular-nums shadow-md transition-colors hover:shadow-accent outline-none focus:ring-accent active:bg-accent active:text-on-accent'
let navigation: EditorNavigation | undefined
const { cursor, cursorListeners } = useCanvasCursor(() => navigation)
const controlListeners = { ...controlsForNavigation(() => navigation), ...cursorListeners }
const activate = () => {
    if (navigation) activateEditorNavigation(navigation)
}
const xToLane = (x: number) =>
    elevationLayout.value.laneLeft + (x - elevationBounds.x) / elevationLayout.value.laneScale
const availableCommands: CommandName[] = [
    'open',
    'save',
    'reset',
    'properties',
    'utilities',
    'play',
    'stop',
    'speedUp',
    'speedDown',
    'toggleBgmVolume',
    'toggleSfxVolume',
    'bgm',
    'select',
    'elevation',
    'deselect',
    'eraser',
    'brush',
    'paste',
    'cut',
    'copy',
    'deleteSelection',
    'undo',
    'redo',
    'flip',
    'combineNotes',
    'splitHold',
    'scaleBeat',
    'scaleElevation',
    'scaleWidth',
    'makeVertical',
    'increaseNoteSize',
    'decreaseNoteSize',
    'note',
    'note0',
    'note1',
    'note2',
    'note3',
    'slide',
    'slide0',
    'slide1',
    'slide2',
    'slide3',
    'slide4',
    'generateSlideNotes',
    'manageGroups',
    'groupAll',
    'groupNext',
    'groupPrev',
    'manageStages',
    'stageAll',
    'stageNext',
    'stagePrev',
    'noteVisibility',
    'snapping',
    'division1',
    'division2',
    'division3',
    'division4',
    'division6',
    'division8',
    'division12',
    'division16',
    'divisionCustom',
    'laneSnapping',
    'laneDivision1',
    'laneDivision2',
    'laneDivision3',
    'laneDivision4',
    'laneDivision6',
    'laneDivision8',
    'laneDivision12',
    'laneDivision16',
    'laneDivisionCustom',
    'laneLimitNone',
    'laneLimitSix',
    'laneLimitCustom',
    'zoomXIn',
    'zoomXOut',
    'zoomYIn',
    'zoomYOut',
    'scrollLeft',
    'scrollRight',
    'scrollUp',
    'scrollDown',
    'scrollPageUp',
    'scrollPageDown',
]
// Fits once its pane has a size, when a chart load asks for it; it starts at 1:1.
const fitViewport = () => {
    if (!needsElevationFit.value || !elevationBounds.h) return
    needsElevationFit.value = false
    fitElevationViewport(
        elevationBounds.h,
        elevationNotes.value,
        squareScale.value,
        {
            top: (header.value?.clientHeight ?? 80) + Math.max(20, 1.25 * elevationLaneScale.value),
            // 0 keeps its margin above the toolbar.
            bottom: Number.isFinite(bottomChrome.value)
                ? elevationBounds.h - bottomChrome.value
                : 140,
        },
        // A note's drawn half height.
        0.3 * elevationLaneScale.value,
    )
}
// The y-scale of a 1:1 grid; while locked, it follows the lane zoom.
const squareScale = computed(() => clamp(elevationLaneScale.value, 1, 1200))
watch(
    [() => settings.elevationSquareGrid, squareScale],
    ([square, scale]) => {
        if (square) elevationViewport.scale = scale
    },
    { immediate: true, flush: 'sync' },
)
const frame = createFrameScheduler()
const notes = createNoteRenderer()
const nameSprites = createLabelSprites()
const pixelRatio = ref(devicePixelRatio || 1)
let pixelRatioQuery: MediaQueryList | undefined
const updatePixelRatio = () => {
    pixelRatio.value = devicePixelRatio || 1
    pixelRatioQuery?.removeEventListener('change', updatePixelRatio)
    pixelRatioQuery = matchMedia(`(resolution: ${pixelRatio.value}dppx)`)
    pixelRatioQuery.addEventListener('change', updatePixelRatio)
}
const redrawVersion = ref(0)
// The editor's font, as the chart's.
const fontFamily = ref('sans-serif')
const fontMiddle = ref(0.25)
const figureMiddle = ref(FIGURE_MIDDLE)
const updateFont = () => {
    if (container.value) {
        fontFamily.value = getComputedStyle(container.value).fontFamily
        fontMiddle.value = measureTextMiddle(fontFamily.value, container.value)
        figureMiddle.value = measureFigureMiddle(fontFamily.value)
    }
    clearTextWidths()
    nameSprites.clear()
    redrawVersion.value++
}
const restoreContext = () => {
    notes.clear()
    nameSprites.clear()
    // A restored surface has lost its pixels.
    redrawVersion.value++
}
const hovered = ref<NoteEntity>()
// The pane y badges were last placed from, unrounded.
let lastOffscreenAnchor = 0
// The elevation badges pan from; a zoom moves it onto the slot lattice near the middle.
const offscreenOrigin = computed<{ elevation: number; scale: number }>((previous) => {
    const { yAt, elevationScale: scale } = elevationLayout.value
    if (previous?.scale === scale) return previous
    if (!previous) return { elevation: 0, scale }
    const y = offscreenSlotNear(lastOffscreenAnchor, elevationBounds.h / 2)
    // Kept when already there, so float error can't flip a note on it between slots.
    if (Math.abs(yAt(previous.elevation) - y) < 1e-6)
        return { elevation: previous.elevation, scale }
    return { elevation: (yAt(0) - y) / scale, scale }
})
const offscreenAnchor = computed(() => {
    lastOffscreenAnchor = elevationLayout.value.yAt(offscreenOrigin.value.elevation)
    // Whole device pixels keep the badges sharp.
    const ratio = pixelRatio.value
    return Math.round(lastOffscreenAnchor * ratio) / ratio
})
// The top of the toolbar or tool dialog, which the bottom badges stay above.
const bottomChrome = ref(Infinity)
const updateBottomChrome = () => {
    const pane = container.value
    if (!pane) return
    const chrome =
        pane.querySelector('[data-tool-dialog]') ??
        pane.querySelector('[data-editor-toolbar] > div')
    const rect = chrome?.getBoundingClientRect()
    // The toolbar hides during drags; the badges keep their place.
    if (rect && !rect.height) return
    bottomChrome.value = rect ? rect.top - pane.getBoundingClientRect().top : Infinity
}
const chromeObserver = new ResizeObserver(updateBottomChrome)
// The toolbar and a tool dialog replace each other.
const observeBottomChrome = () => {
    chromeObserver.disconnect()
    for (const element of container.value?.querySelectorAll(
        '[data-tool-dialog], [data-editor-toolbar] > div',
    ) ?? [])
        chromeObserver.observe(element)
    updateBottomChrome()
}
const chromeMutations = new MutationObserver(observeBottomChrome)
// Axis labels move right of any left badges, which would cover them.
const axisLabelLeftOf = (groups: OffscreenNoteGroup[]) => {
    const left = groups.filter(({ side }) => side === 'left')
    return left.length
        ? Math.max(...left.map(({ count }) => offscreenBadgeHitWidth(count))) + 4
        : undefined
}
let labelMeasure: CanvasRenderingContext2D | null | undefined
// An axis label's width.
const measureLabel = (label: number, family: string) => {
    labelMeasure ??= document.createElement('canvas').getContext('2d')
    if (!labelMeasure) return 0
    labelMeasure.font = `12px ${family}`
    return labelMeasure.measureText(`${label}`).width
}
const offscreenGroups = computed<OffscreenNoteGroup<NoteEntity>[]>((previous) => {
    const selected = new Set(elevationState.value.selectedEntities)
    const layout = elevationLayout.value
    const { elevation: origin, scale } = offscreenOrigin.value
    const anchor = offscreenAnchor.value
    const notes = layout.rows.map((row) => ({
        left: row.x - row.w / 2,
        right: row.x + row.w / 2,
        // From the origin, so notes keep their slots while panning.
        y: -(row.elevation - origin) * scale,
        highlighted: selected.has(row.note),
        opacity: 1,
        // A pending draft's notes are picked as the committed ones they show.
        target: previewEdit.value?.isDraft
            ? toCommittedEntity(row.note, elevationState.value)
            : row.note,
    }))
    const ratio = pixelRatio.value
    // Badges land on device pixels.
    const pixel = (x: number) => Math.round(x * ratio) / ratio
    const width = pixel(elevationBounds.w)
    const height = pixel(elevationBounds.h)
    const top = headerHeight.value + 4
    const sides = groupOffscreenNotes(notes, width, top, height, 0, anchor)
    // Top and bottom badges keep right of the axis labels and clear of the right badges.
    const labelLeft = axisLabelLeftOf(sides)
    // Without left badges, the grid starts right of the labels.
    let labelRight = 38
    if (labelLeft !== undefined) {
        const { elevationCenter: center, height, elevationScale } = layout
        // The labels at the ends have the most characters.
        labelRight =
            labelLeft +
            Math.max(
                ...[
                    Math.ceil(center - height / 2 / elevationScale),
                    Math.floor(center + height / 2 / elevationScale),
                ].map((label) => measureLabel(label, fontFamily.value)),
            )
    }
    const rightReach = Math.max(
        0,
        ...sides
            .filter(({ side }) => side === 'right')
            .map(({ count }) => offscreenBadgeHitWidth(count)),
    )
    const edges = groupOffscreenEdgeNotes(notes, width, top, height, 0, anchor, {
        above: headerHeight.value - layout.laneScale * 0.3,
        below: height + layout.laneScale * 0.3,
        floor: pixel(bottomChrome.value - 4),
        left: labelRight + 4,
        right: width - rightReach - 4,
        // The end cells meet the side badges' hit areas.
        reachLeft: labelLeft === undefined ? 0 : labelLeft - 4,
        reachRight: elevationBounds.w - rightReach,
        origin: pixel(layout.xAt(0)),
        pixelRatio: ratio,
    })
    const groups = [...sides, ...edges]
    // Unchanged badges keep their array, so they don't re-render.
    return previous && isSameOffscreenGroups(previous, groups) ? previous : groups
})
useOffscreenIndicators({
    navigation: () => navigation,
    bounds: () => elevationBounds,
    groups: () => offscreenGroups.value,
    anchor: () => offscreenAnchor.value,
    edges: true,
})
// Whether a client point is on a top or bottom badge's pill.
const isOnEdgeBadge = ({ side, slot }: OffscreenNoteGroup, x: number, y: number) => {
    const rect = container.value
        ?.querySelector(`.offscreen-note-indicator[data-side="${side}"][data-slot="${slot}"]`)
        ?.getBoundingClientRect()
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
// Only the select-like tools pick notes from the badges. Off its pill, a top or bottom cell
// leaves the point to a note there.
const hitIndicator = (x: number, y: number) => {
    if (toolName.value !== 'select' && toolName.value !== 'elevation') return
    const indicator = hitOffscreenIndicator(x, y)
    if (indicator?.x === undefined || isOnEdgeBadge(indicator, x, y) || !hit(x, y)) return indicator
}
const hoveredOffscreenGroup = computed(() =>
    cursor.value === 'pointer' ? hitIndicator(view.pointer.x, view.pointer.y) : undefined,
)
// Shallow, so its notes stay the paste ghost's own and match its slides.
const creating = shallowRef<ElevationNote[]>([])
// Lane and origin are displayed, on the lattice of the stage new notes go on.
let adding: { lane: number; origin: number; elevation: number; slide: boolean } | undefined
let mounted = false
let drag:
    | {
          source: State
          row: ElevationRow
          targets: NoteEntity[]
          lane: number
          elevation: number
          deltaLane: number
          deltaElevation: number
          resizing: boolean
          // The grabbed side: every resized note keeps its left edge.
          fixedLeft: boolean
          movingEdge: number
          // Raw pointer lane delta, and each resized note's result.
          shift: number
          resized: string
          // Authored phase of the grabbed note's stage lattice, and whether lanes are Composed.
          origin: number
          composed: boolean
          attachment?: AttachedElevationDrag
      }
    | undefined
let marquee:
    | {
          lane: number
          elevation: number
          selected: State['selectedEntities']
          targets: State['selectedEntities']
      }
    | undefined

const yToElevation = (y: number) =>
    elevationViewport.center +
    (elevationBounds.h / 2 - y + elevationBounds.y) / elevationViewport.scale
/**
 * Rows at a point, as the chart's hits: `rows` ranked, `set` those that act together, without
 * rows reached only through their side slack when a row's own span holds the point, but with the first.
 */
const hitRows = (x: number, y: number, minimum = 1.5) => {
    const rows = elevationLayout.value.rows
    const matches = rows.filter(
        (row) =>
            Math.abs(x - elevationBounds.x - row.x) <=
                Math.max(row.w, minimum * elevationLayout.value.laneScale) / 2 + 10 &&
            Math.abs(y - elevationBounds.y - row.y) <=
                Math.max(14, elevationLayout.value.laneScale * 0.3 + 10),
    )
    // As the hit model orders the chart's: rows whose shape holds the point, later rows
    // over earlier ones; then the nearest shape, then the later row.
    const scale = elevationLayout.value.laneScale
    const distances = new Map(
        matches.map((row) => [
            row,
            shapeDistance(
                shownNoteHitShape(
                    row.note,
                    row.size,
                    elevationState.value.store.slides.info.get(row.note.slideId),
                ),
                (x - elevationBounds.x - row.x + row.w / 2) / scale,
                (y - elevationBounds.y - row.y) / scale,
            ),
        ]),
    )
    const distance = (row: ElevationRow) => distances.get(row) ?? 0
    const index = new Map(rows.map((row, i) => [row, i]))
    const ranked = matches.sort(
        (a, b) =>
            compareShapeDistance(distance(a), distance(b)) ||
            (index.get(b) ?? 0) - (index.get(a) ?? 0),
    )
    const isDirect = (row: ElevationRow) =>
        Math.abs(x - elevationBounds.x - row.x) <=
        Math.max(row.w, minimum * elevationLayout.value.laneScale) / 2
    // A pending Properties draft's rows are hit as the committed notes they show.
    const shown = ranked.flatMap((row) => {
        const note = previewEdit.value?.isDraft
            ? toCommittedEntity(row.note, elevationState.value)
            : row.note
        return note
            ? [{ row: note === row.note ? row : { ...row, note }, isDirect: isDirect(row) }]
            : []
    })
    const filtered = shown.some(({ isDirect }) => isDirect)
    return {
        rows: shown.map(({ row }) => row),
        set: shown.flatMap(({ row, isDirect }, i) => (!i || !filtered || isDirect ? [row] : [])),
    }
}
// A selected row in reach, else the first.
const pickRow = ({ rows, set }: ReturnType<typeof hitRows>) => {
    const selected = (previewEdit.value?.isDraft ? state : elevationState).value.selectedEntities
    return set.find((row) => selected.includes(row.note)) ?? rows[0]
}
const hit = (x: number, y: number) => pickRow(hitRows(x, y))
const cancel = () => {
    if (drag) clearPreviewEdit()
    drag = undefined
    marquee = undefined
    adding = undefined
    creating.value = []
    elevationSelection.value = undefined
}
const editedObject = (active: NonNullable<typeof drag>, note: NoteEntity) => {
    if (!getNoteFieldsIn(active.source.store, note).left)
        return { elevation: note.elevation + active.deltaElevation }
    const edge = note.left + (active.fixedLeft ? note.size : 0)
    // As the chart's select resize, every edge moves by the grabbed edge's snapped shift.
    const [left, size] = active.resizing
        ? resize(
              shiftComputed(note.left, active.fixedLeft ? 0 : note.size),
              edge + active.shift,
              minimumNoteSize(note.noteType),
              Number.POSITIVE_INFINITY,
              edge,
              [note.left, note.size],
              undefined,
              resizeShift(
                  active.movingEdge,
                  active.movingEdge + active.shift,
                  active.composed ? active.origin : 0,
              ),
          )
        : [
              active.deltaLane === 0 ? note.left : alignComputed(note.left + active.deltaLane),
              note.size,
          ]
    return constrainLaneObject(
        {
            noteType: note.noteType,
            left,
            size,
            elevation: note.elevation + active.deltaElevation,
        },
        {
            // A resize clamps on any pointer movement, as the chart's does.
            enabled:
                note === active.row.note &&
                (active.resizing
                    ? active.shift !== 0
                    : active.deltaLane !== 0 || active.deltaElevation !== 0),
            resizing: active.resizing,
        },
    )
}
const edit = (active: NonNullable<typeof drag>) => {
    const transaction = createTransaction(active.source)
    const replacements = new Map(
        active.targets.flatMap((note) => {
            const replacement = editSelectedNote(transaction, note, editedObject(active, note))[0]
            return replacement ? [[note, replacement] as const] : []
        }),
    )
    return transaction.commit(
        active.source.selectedEntities.map((entity) =>
            entity.type === 'note' ? (replacements.get(entity) ?? entity) : entity,
        ),
    )
}
const selectedFor = (notesOnly: boolean) =>
    notesOnly
        ? state.value.selectedEntities.filter((entity) => entity.type === 'note')
        : state.value.selectedEntities
type TapPoint = { beat: number; lane: number; elevation: number }
// The cycle of taps at a spot, as the chart's; the hover reads it, a tap keeps it.
let cycled: TapCycle<State['selectedEntities'][number], TapPoint> | undefined
const tapPointAt = (x: number, y: number): TapPoint => ({
    beat: elevationBeat.value,
    lane: xToLane(x),
    elevation: yToElevation(y),
})
const isNearTap = (a: TapPoint, b: TapPoint) =>
    sameBeat(a.beat, b.beat) &&
    Math.abs(a.lane - b.lane) * elevationLayout.value.laneScale <= tapCycleSlack &&
    Math.abs(a.elevation - b.elevation) * elevationViewport.scale <= tapCycleSlack
/**
 * What a tap selects among rows: with Ctrl all of them; cycling at a point, the next after the
 * selection's first; else the first.
 */
const selectTargets = (hits: ElevationRow[], modifiers: Modifiers, at?: TapPoint) => {
    if (modifiers.ctrl)
        return {
            targets: modifyEntities(
                hits.map((row) => row.note),
                modifiers,
            ),
        }
    if (!at) return { targets: modifyEntities(hits[0] ? [hits[0].note] : [], modifiers) }
    const current = state.value.selectedEntities[0]
    const step = stepTapCycle(
        cycled,
        hits.map((row) => row.note),
        current,
        at,
        isNearTap,
        // A pending draft's click replaces the selection it edits, which ends the cycle.
        !current || toSceneEntity(current, elevationState.value) === current,
    )
    return {
        cycle: step.cycle,
        targets: modifyEntities(step.target ? [step.target] : [], modifiers),
    }
}
const selectAt = (rows: ElevationRow[], modifiers: Modifiers, at?: TapPoint, notesOnly = false) => {
    const selected = selectedFor(notesOnly)
    if (modifiers.ctrl && !rows.length) return
    const { cycle, targets } = selectTargets(rows, modifiers, at)
    if (cycle) cycled = cycle
    replaceState({
        ...state.value,
        selectedEntities: modifiers.ctrl
            ? targets.every((entity) => selected.includes(entity))
                ? selected.filter((entity) => !targets.includes(entity))
                : [...new Set([...selected, ...targets])]
            : targets,
    })
}
const positionAtPoint = (x: number, y: number) => ({
    lane: xToLane(x),
    beat: elevationBeat.value,
    elevation: snapElevation(yToElevation(y), settings.elevationSnap),
})
// The Paste tool's tap or drag drops its paste on a tool switch; the context menu's comes from any tool.
const pasteAtPoint = async (
    x: number,
    y: number,
    modifiers: Modifiers,
    keepsTool = false,
    waits = true,
) => {
    const position = positionAtPoint(x, y)
    if (waits && !(await waitToPaste(updateClipboard, keepsTool))) return false
    if (!mounted || !isElevationEditorOpen.value || !sameBeat(elevationBeat.value, position.beat))
        return false
    await pasteElevationNotes(position.lane, position.elevation, position.beat, modifiers)
    creating.value = []
    return true
}
const visibleTargets = (entities: State['selectedEntities']) => {
    const visible = new Set(elevationNotes.value.map((item) => item.note))
    // Committed notes, shown as a pending draft draws them.
    return entities.filter(
        (entity): entity is NoteEntity =>
            entity.type === 'note' && visible.has(toSceneEntity(entity, elevationState.value)),
    )
}
const isSecondaryTool = () => ['eraser', 'brush', 'generateSlideNotes'].includes(toolName.value)
const secondaryTargets = (entities: State['selectedEntities'], modifiers: Modifiers) =>
    visibleTargets(toolName.value === 'brush' ? modifyEntities(entities, modifiers) : entities)
const applyToVisibleSelection = (
    { rows, set }: ReturnType<typeof hitRows>,
    modifiers: Modifiers,
) => {
    const selected = state.value.selectedEntities
    const hits = set.map((row) => row.note)
    const targets = hits.some((note) => selected.includes(note))
        ? selected
        : toolName.value === 'eraser'
          ? rows.slice(0, 1).map((row) => row.note)
          : hits
    return secondaryTargets(targets, modifiers)
}
const resolveDrag = (x: number, y: number) => {
    // Pressing an off-screen badge box-selects.
    if (hitIndicator(x, y)) return { type: 'marquee', row: undefined, indicator: true } as const
    const row = hit(x, y)
    if (toolName.value === 'paste') return { type: 'paste' } as const
    if (!row && (toolName.value === 'note' || toolName.value === 'slide'))
        return { type: 'add' } as const
    if (!row || ['eraser', 'brush', 'generateSlideNotes'].includes(toolName.value))
        return { type: 'marquee', row } as const
    if (row.attached)
        return {
            // As drawn, as the press reads it once it commits a pending draft.
            type: getNoteFieldsIn(
                elevationState.value.store,
                toSceneEntity(row.note, elevationState.value),
            ).elevation
                ? 'move'
                : 'select',
            row,
        } as const
    return {
        type: isNoteResizeStart({ left: row.lane - row.size / 2, size: row.size }, xToLane(x))
            ? 'resize'
            : 'move',
        row,
    } as const
}
const cursors = {
    paste: 'copy',
    add: 'crosshair',
    select: 'pointer',
    resize: 'ew-resize',
    move: 'move',
} as const
const controls: Pick<
    Tool,
    'hover' | 'tap' | 'cursor' | 'dragStart' | 'dragUpdate' | 'dragEnd' | 'dragCancel'
> = {
    hover(x, y, modifiers) {
        const indicator = hitIndicator(x, y)
        if (indicator) {
            hovered.value = undefined
            creating.value = []
            view.entities = { hovered: modifyEntities(indicator.targets, modifiers), creating: [] }
            return
        }
        // The hover shows what a tap there would act on, as far as it reaches.
        const hits = hitRows(x, y)
        const row = pickRow(hits)
        hovered.value = row?.note
        const position = positionAtPoint(x, y)
        if (!hovered.value && (toolName.value === 'note' || toolName.value === 'slide'))
            creating.value = [
                previewElevationNoteRow(
                    position.lane,
                    position.elevation,
                    position.beat,
                    toolName.value === 'slide',
                ),
            ]
        else if (toolName.value === 'paste')
            // As the chart's: a Composed paste is placed on the committed lattice, so it waits for a draft's commit.
            creating.value =
                previewEdit.value?.isDraft && getComposedLayout(elevationState.value)
                    ? []
                    : previewElevationPasteRows(
                          position.lane,
                          position.elevation,
                          position.beat,
                          modifiers,
                      )
        else creating.value = []
        view.entities = {
            hovered: isSecondaryTool()
                ? applyToVisibleSelection(hits, modifiers)
                : toolName.value === 'note' || toolName.value === 'slide'
                  ? modifyEntities(row ? [row.note] : [], modifiers)
                  : toolName.value === 'paste'
                    ? []
                    : selectTargets(hits.set, modifiers, tapPointAt(x, y)).targets,
            creating: creating.value.map((row) => row.note),
        }
    },
    tap(x, y, modifiers) {
        const indicator = hitIndicator(x, y)
        if (indicator) {
            selectOffscreenNotes(indicator.targets, modifiers)
            return
        }
        const hits = hitRows(x, y)
        const row = pickRow(hits)
        if (toolName.value === 'paste') {
            void pasteAtPoint(x, y, modifiers, true)
            return
        }
        if (row && toolName.value === 'eraser') {
            remove(applyToVisibleSelection(hits, modifiers))
            return
        }
        if (row && toolName.value === 'brush') {
            applyBrushToEntities(applyToVisibleSelection(hits, modifiers))
            return
        }
        if (row && toolName.value === 'generateSlideNotes') {
            applyGeneratedSlideNotes(applyToVisibleSelection(hits, modifiers))
            return
        }
        if (isSecondaryTool()) {
            selectAt([], { ctrl: false, shift: false })
            return
        }
        if (toolName.value === 'note' || toolName.value === 'slide') {
            if (!row) {
                const position = positionAtPoint(x, y)
                createElevationNote(
                    position.lane,
                    position.elevation,
                    position.beat,
                    toolName.value === 'slide',
                )
                creating.value = []
                return
            }
            const targets = modifyEntities([row.note], modifiers)
            if (
                !modifiers.ctrl &&
                targets.every((note) => state.value.selectedEntities.includes(note))
            ) {
                if (isSidebarVisible.value) {
                    revealPropertiesSection('selection')
                    quickEdit(
                        toolName.value === 'slide'
                            ? defaultSlideProperties.value
                            : defaultNoteProperties.value,
                    )
                } else
                    // The same docked tool dialog the main editor opens for this gesture.
                    void showToolModal(SelectionPropertiesModal, { kind: 'note' })
                return
            }
            selectAt([row], modifiers, undefined, true)
            return
        }
        selectAt(hits.set, modifiers, tapPointAt(x, y))
    },
    cursor(x, y) {
        const target = resolveDrag(x, y)
        if (target.type !== 'marquee') return cursors[target.type]
        if ('indicator' in target) return 'pointer'
        // A tap applies eraser, brush and generate to the row.
        if (target.row) return 'pointer'
        return ['eraser', 'brush', 'generateSlideNotes'].includes(toolName.value)
            ? 'crosshair'
            : 'default'
    },
    dragStart(x, y) {
        const target = resolveDrag(x, y)
        if (target.type === 'paste') return true
        if (target.type === 'add') {
            const position = positionAtPoint(x, y)
            const slide = toolName.value === 'slide'
            const origin = elevationAddOrigin(position.beat, slide)
            adding = {
                lane: alignLane(position.lane - origin) + origin,
                origin,
                elevation: position.elevation,
                slide,
            }
            return true
        }
        if (target.type === 'marquee') {
            marquee = {
                lane: xToLane(x),
                elevation: yToElevation(y),
                selected: state.value.selectedEntities,
                targets: [],
            }
            return true
        }
        const { row } = target
        if (!state.value.selectedEntities.includes(row.note))
            selectAt([row], { ctrl: false, shift: false })
        if (target.type === 'select') return false
        const eligible = new Set(
            elevationNotes.value
                .filter((item) => getNoteFieldsIn(state.value.store, item.note).elevation)
                .map((item) => item.note),
        )
        drag = {
            source: state.value,
            row,
            // Moves and resizes take the selected notes shown here.
            targets: state.value.selectedEntities.filter(
                (entity): entity is NoteEntity => entity.type === 'note' && eligible.has(entity),
            ),
            lane: xToLane(x),
            elevation: yToElevation(y),
            deltaLane: 0,
            deltaElevation: 0,
            resizing: target.type === 'resize',
            fixedLeft: xToLane(x) >= row.lane,
            movingEdge: xToLane(x) < row.lane ? row.note.left : row.note.left + row.note.size,
            shift: 0,
            resized: '',
            origin: getElevationStageProps(row.note.stageId, elevationBeat.value).gridOffset,
            composed: !!getComposedLayout(state.value),
        }
        if (row.attached) {
            const info = state.value.store.slides.info
                .get(row.note.slideId)
                ?.find((info) => info.note === row.note)
            if (info) {
                const { attachHead: head, attachTail: tail } = info
                drag.attachment = {
                    head: head.elevation,
                    tail: tail.elevation,
                    note: row.note.elevation,
                    headStage: getElevationStageProps(head.stageId, elevationBeat.value).elevation,
                    tailStage: getElevationStageProps(tail.stageId, elevationBeat.value).elevation,
                    headMoves: drag.targets.includes(head),
                    tailMoves: drag.targets.includes(tail),
                }
            }
        }
        return true
    },
    dragUpdate(x, y, modifiers) {
        if (adding) {
            const [left, size] = resize(
                adding.lane,
                xToLane(x),
                elevationNoteMinimum(elevationBeat.value, adding.slide),
                Number.POSITIVE_INFINITY,
                adding.lane,
                undefined,
                adding.origin,
            )
            creating.value = [
                previewElevationNoteRow(
                    left,
                    snapElevation(yToElevation(y), settings.elevationSnap),
                    elevationBeat.value,
                    adding.slide,
                    size,
                ),
            ]
            view.entities = { hovered: [], creating: creating.value.map((row) => row.note) }
            return
        }
        if (toolName.value === 'paste') {
            void controls.hover?.(x, y, modifiers)
            return
        }
        if (marquee) {
            // Anchored in lanes and elevations, as the chart's is in lanes and times.
            const lane = xToLane(x)
            const elevation = yToElevation(y)
            const rect = {
                laneMin: Math.min(marquee.lane, lane),
                laneMax: Math.max(marquee.lane, lane),
                elevationMin: Math.min(marquee.elevation, elevation),
                elevationMax: Math.max(marquee.elevation, elevation),
            }
            elevationSelection.value = rect
            const { rows, xAt, yAt, laneScale } = elevationLayout.value
            const left = xAt(rect.laneMin)
            const right = xAt(rect.laneMax)
            const top = yAt(rect.elevationMax)
            const bottom = yAt(rect.elevationMin)
            // Notes count as far as they are drawn: 0.6 lane tall.
            const half = laneScale * 0.3
            const hits = rows
                .filter(
                    (row) =>
                        row.x + row.w / 2 >= left &&
                        row.x - row.w / 2 <= right &&
                        row.y + half >= top &&
                        row.y - half <= bottom,
                )
                .map((row) => row.note)
            const targets = isSecondaryTool()
                ? secondaryTargets(hits, modifiers)
                : modifyEntities(hits, modifiers)
            marquee.targets = targets
            replaceState({
                ...state.value,
                selectedEntities:
                    modifiers.ctrl && !isSecondaryTool()
                        ? [...new Set([...marquee.selected, ...targets])]
                        : targets,
            })
            return
        }
        if (!drag) return
        const deltaLane = drag.attachment
            ? 0
            : offset(
                  drag.lane,
                  xToLane(x),
                  drag.resizing ? drag.movingEdge : drag.row.note.left,
                  drag.origin,
                  drag.resizing ? undefined : xToLane(x) - drag.lane,
              )
        const delta = yToElevation(y) - drag.elevation
        const displayedDelta = drag.resizing
            ? 0
            : elevationMoveDelta(drag.row.elevation, delta, settings.elevationSnap, view.snapping)
        // An unmoved row stays exact; its drawn elevation needn't invert to 0.
        const deltaElevation = drag.attachment
            ? displayedDelta === 0
                ? 0
                : inverseAttachedElevation(
                      drag.attachment,
                      drag.row.elevation + displayedDelta,
                      drag.deltaElevation,
                  )
            : displayedDelta
        // Resized notes can snap on their own, so their results key the preview.
        const next = {
            ...drag,
            deltaLane,
            deltaElevation,
            shift: drag.resizing ? xToLane(x) - drag.lane : 0,
        }
        const resized = drag.resizing
            ? next.targets
                  .map((note) => {
                      const object = editedObject(next, note)
                      return 'left' in object ? `${object.left} ${object.size}` : ''
                  })
                  .join()
            : ''
        drag.shift = next.shift
        if (
            deltaLane === drag.deltaLane &&
            deltaElevation === drag.deltaElevation &&
            resized === drag.resized
        )
            return
        drag.deltaLane = deltaLane
        drag.deltaElevation = deltaElevation
        drag.resized = resized
        const active = { ...drag }
        setPreviewEdit(active.source, () => edit(active), [
            active.targets,
            deltaLane,
            deltaElevation,
            resized,
        ])
    },
    dragEnd(x, y, modifiers) {
        controls.dragUpdate?.(x, y, modifiers)
        if (toolName.value === 'paste') {
            cancel()
            // As the chart's: it lands now, and a paste waiting on a read is then dropped.
            void pasteAtPoint(x, y, modifiers, true, !hasWaitingPaste())
            return
        }
        if (adding) {
            const current = adding
            const [left, size] = resize(
                current.lane,
                xToLane(x),
                elevationNoteMinimum(elevationBeat.value, current.slide),
                Number.POSITIVE_INFINITY,
                current.lane,
                undefined,
                current.origin,
            )
            const elevation = snapElevation(yToElevation(y), settings.elevationSnap)
            cancel()
            createElevationNote(left, elevation, elevationBeat.value, current.slide, size)
            return
        }
        if (marquee && ['eraser', 'brush', 'generateSlideNotes'].includes(toolName.value)) {
            const targets = visibleTargets(marquee.targets)
            cancel()
            if (toolName.value === 'eraser') remove(targets)
            else if (toolName.value === 'brush') applyBrushToEntities(targets)
            else applyGeneratedSlideNotes(targets)
            return
        }
        const active = drag
        cancel()
        // A drop that changes nothing adds no undo step.
        if (
            active &&
            (active.resizing || active.deltaLane || active.deltaElevation) &&
            active.targets.some((note) =>
                editChanges(active.source.store, note, editedObject(active, note)),
            )
        )
            pushState(() => i18n.value.elevation.history, edit(active))
    },
    dragCancel: cancel,
}

const previousBeat = computed(() => {
    const beat = Math.max(
        0,
        stepGridBeat(committedGrid.value, elevationBeat.value, view.division, -1),
    )
    return beat < elevationBeat.value ? beat : undefined
})
const nextBeat = computed(() => {
    const beat = stepGridBeat(committedGrid.value, elevationBeat.value, view.division, 1)
    return Number.isFinite(beat) && beat > elevationBeat.value ? beat : undefined
})
const changeBeat = (beat: number) => {
    if (!Number.isFinite(beat)) return
    cancelMouseControls()
    cancelTouchControls()
    cancel()
    const target = Math.max(0, beat)
    if (isElevationSideBySide.value) focusViewAtBeat(target)
    else view.cursorTime = beatToTime(state.value.bpms, target)
    // Moving the cursor converts back from time; keep the exact beat.
    elevationBeat.value = target
}
// Written on change only, so re-renders never overwrite the typing.
const beatField = computed({
    get: () => shortDisplayedBeat(elevationBeat.value),
    set: (value: number | string) => {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1)
            changeBeat(typedBeat(value))
    },
})
// A shown value is a grid line rounded to three decimals, so it stores that line, as Next does.
// A value with more decimals is kept as typed.
const typedBeat = (value: number) => {
    const beat = fromDisplayedBeat(value)
    const line = snapBeat(committedGrid.value, beat, view.division)
    return value === Number(value.toFixed(3)) &&
        view.division < 1000 &&
        Math.abs(line - beat) <= 5e-4 + 1e-9
        ? line
        : nearGridBeat(committedGrid.value, beat, view.division)
}
// Arrows step to the next grid line; shown values are rounded, so the native step would miss it.
const stepBeatField = (event: Event, direction: 1 | -1) => {
    event.preventDefault()
    // From a typed value too, as the native step does.
    const typed = (event.currentTarget as HTMLInputElement).valueAsNumber
    const from =
        Number.isFinite(typed) && typed !== beatField.value ? typedBeat(typed) : elevationBeat.value
    const beat = Math.max(0, stepGridBeat(committedGrid.value, from, view.division, direction))
    if (!(direction > 0 ? beat > from : beat < from)) return
    changeBeat(beat)
    // A step onto the committed beat leaves no re-render to replace the typed text.
    ;(event.currentTarget as HTMLInputElement).value = `${beatField.value}`
}
// Chromium steps a focused number field on the wheel, as with the arrows; other browsers don't.
const stepsOnWheel = isChromium(navigator)
const wheelBeatField = (event: WheelEvent) => {
    if (stepsOnWheel && event.deltaY && document.activeElement === event.currentTarget)
        stepBeatField(event, event.deltaY < 0 ? 1 : -1)
}
// Showing its committed beat, Ctrl+Z and Ctrl+Y go to the editor.
trackTypedText(beatInput, () => `${beatField.value}`)
// Pointer clicks on header buttons return keyboard shortcuts to the editor, as in docks.
const blurAfterPointer = (event: MouseEvent) => {
    if (event.detail > 0 && event.target instanceof Element) event.target.closest('button')?.blur()
}
const onKeydown = (event: KeyboardEvent) => {
    // An open drawer takes Escape first.
    if (modals.length || event.defaultPrevented || isComposingKey(event)) return
    if (editorNavigation.value !== navigation) return
    if (event.key !== 'Escape') return
    // The Beat field reverts uncommitted typing first.
    if (event.target === beatInput.value && beatInput.value?.value !== `${beatField.value}`) return
    if (event.target instanceof Element && event.target.closest('[role=separator]')) return
    // Workspace panels, their rails and menus handle their own Escape.
    if (isInWorkspaceDock(event.target instanceof Element ? event.target : null)) return
    event.preventDefault()
    event.stopPropagation()
    if (contextMenu.value) {
        closeContextMenu()
        return
    }
    // A drag's Escape only cancels it, before this runs.
    // Side by side, it runs Deselect, so a second press switches to Select as on the chart.
    if (!isElevationSideBySide.value) closeElevationEditor()
    // The Elevation tool already selects here, and closing returns the tool from before.
    else if (state.value.selectedEntities.length || toolName.value !== 'elevation')
        void deselect.execute()
}
// Its scroll and zoom move where a drag in it lands.
watch([() => elevationViewport.center, () => elevationViewport.scale], notifyPaneMoved)
// They, and its beat, move what a resting mouse hovers.
watch([() => elevationViewport.center, () => elevationViewport.scale, elevationBeat], () => {
    if (editorNavigation.value === navigation) hoverAgain()
})
watch([() => elevationBounds.w, () => elevationBounds.h], () => {
    cancelMouseControls()
    cancelTouchControls()
    cancel()
    pixelRatio.value = devicePixelRatio || 1
})
watch(elevationBeat, () => {
    if (editorNavigation.value === navigation) {
        cancelMouseControls()
        cancelTouchControls()
    }
    cancel()
})
// A chart load while open fits it now.
watch(needsElevationFit, fitViewport)
// Focus, hidden groups/stages and type filters change which notes are editable.
// Pure reveals (including authoring revealing its target) never hide a note.
watch([scopeLookup, () => view.visibilities], ([scope, visibilities], [previous, before]) => {
    if (visibilities === before && !isScopeReduced(previous, scope)) return
    cancelMouseControls()
    cancelTouchControls()
    cancel()
})
watch(interruptsDrags, (interrupted) => {
    if (interrupted) cancel()
})
watch(
    toolName,
    () => {
        hovered.value = undefined
        cancel()
    },
    { flush: 'sync' },
)
watch(
    state,
    (current, previous) => {
        if (!hasSameChartData(current, previous)) {
            hovered.value = undefined
            creating.value = []
        }
    },
    { flush: 'sync' },
)
watch(editorNavigation, (current) => {
    if (current !== navigation) {
        hovered.value = undefined
        creating.value = []
    }
})
// Its ghosts mirror the shared ones, which leaving the pane clears.
watch(
    () => view.entities.creating,
    (current) => {
        if (!current.length && creating.value.length) creating.value = []
    },
)

const connectorStore = computed(() => elevationState.value.store.slides.connector)
const connections = computed(() => {
    const rows = elevationLayout.value.rows
    const slideIds = new Set(rows.map((row) => row.note.slideId))
    return getElevationConnections(
        rows,
        [...slideIds].map((id) => connectorStore.value.get(id) ?? []),
        view.visibilities.connector,
        elevationState.value.bpms,
        elevationState.value.store.slides.info,
    )
})

watchEffect(() => {
    const element = canvas.value
    const layout = elevationLayout.value
    const current = elevationState.value
    const currentConnections = connections.value
    const belowNotes = currentConnections.filter(
        (connection) => connection.connector.segmentHead.connectorLayer !== 'over',
    )
    const aboveNotes = currentConnections.filter(
        (connection) => connection.connector.segmentHead.connectorLayer === 'over',
    )
    const selected = new Set(current.selectedEntities)
    const hover = new Set(
        hoveredEntities.value.map((entity) => toSceneEntity(entity, elevationState.value)),
    )
    const ghosts = creating.value.map((row) => ({
        ...row,
        x: layout.xAt(row.lane),
        y: layout.yAt(row.elevation),
        w: row.size * layout.laneScale,
    }))
    // A paste ghost's notes are drawn as their pasted slides make them, as on the chart.
    const ghostInfos = toolName.value === 'paste' ? pasteGhostInfos() : undefined
    const rect = elevationSelection.value
    const ratio = pixelRatio.value
    const labels = i18n.value.elevation
    const showGroupName = settings.showGroupName
    const showStageName = settings.showStageName
    const nameContrast = settings.nameContrast
    // Name contrast is measured against it.
    void chartBackground.value
    const elevationSnap = settings.elevationSnap
    const stageGrid = elevationStageGrid.value
    void redrawVersion.value
    const family = fontFamily.value
    const textMiddle = fontMiddle.value
    const numberMiddle = figureMiddle.value
    const axisLabelLeft = axisLabelLeftOf(offscreenGroups.value)
    if (!element || !layout.width || !layout.height || !isAppActive.value) {
        frame.cancel()
        // A collapsed pane's last frame would show stretched as it reopens.
        if (element && isAppActive.value) element.width = element.height = 0
        return
    }
    frame.schedule((timestamp) => {
        const w = Math.max(1, Math.round(layout.width * ratio))
        const h = Math.max(1, Math.round(layout.height * ratio))
        if (element.width !== w) element.width = w
        if (element.height !== h) element.height = h
        const ctx = element.getContext('2d')
        if (!ctx) return
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
        ctx.clearRect(0, 0, layout.width, layout.height)
        ctx.font = `12px ${family}`
        ctx.lineWidth = 2
        const min = layout.elevationCenter - layout.height / 2 / layout.elevationScale
        const max = layout.elevationCenter + layout.height / 2 / layout.elevationScale
        const division = elevationGridDivision(layout.elevationScale, elevationSnap)
        ctx.save()
        const labelBaseline = numberMiddle * 12
        const axisLabels: { label: string; y: number }[] = []
        for (let i = Math.ceil(min * division); i <= Math.floor(max * division); i++) {
            const y = layout.yAt(i / division)
            const label = i % division === 0 ? `${i / division}` : undefined
            // As the lanes: the stage's division multiples are brighter than other whole units.
            ctx.strokeStyle =
                label === undefined
                    ? '#ffffff06'
                    : i === 0
                      ? '#ffffff80'
                      : (i / division) % stageGrid.size === 0
                        ? '#ffffff40'
                        : '#ffffff0d'
            ctx.beginPath()
            ctx.moveTo(38, y)
            // Inside the grid, the line breaks around its label.
            if (label !== undefined && axisLabelLeft !== undefined) {
                ctx.lineTo(axisLabelLeft - 3, y)
                ctx.moveTo(axisLabelLeft + ctx.measureText(label).width + 3, y)
            }
            ctx.lineTo(layout.width, y)
            ctx.stroke()
            if (label !== undefined) axisLabels.push({ label, y })
        }
        ctx.restore()
        const laneDivision =
            layout.laneScale / view.laneDivision >= 8 && view.laneDivision <= 32
                ? view.laneDivision
                : 1
        // From where the selected stage's notes snap; its dividers are brighter.
        const { size, origin, divider } = stageGrid.lanes
        for (
            let i = Math.ceil((layout.laneLeft - origin) * laneDivision);
            i <= (layout.laneLeft + layout.width / layout.laneScale - origin) * laneDivision;
            i++
        ) {
            const lane = origin + i / laneDivision
            const x = layout.xAt(lane)
            // Lanes ±6 are drawn after.
            if (x < 38 || Math.abs(Math.abs(lane) - 6) < 1e-9) continue
            ctx.strokeStyle =
                i % laneDivision !== 0
                    ? '#ffffff06'
                    : (i / laneDivision - divider) % size === 0
                      ? '#ffffff40'
                      : '#ffffff0d'
            ctx.beginPath()
            ctx.moveTo(x, 52)
            ctx.lineTo(x, layout.height)
            ctx.stroke()
        }
        ctx.strokeStyle = '#ffffff80'
        for (const lane of [-6, 6]) {
            const x = layout.xAt(lane)
            if (x < 38 || x > layout.width) continue
            ctx.beginPath()
            ctx.moveTo(x, 52)
            ctx.lineTo(x, layout.height)
            ctx.stroke()
        }
        drawElevationConnections(ctx, belowNotes)
        const names = createNameLayer()
        const context: EditorDrawContext = {
            ctx,
            scale: layout.laneScale,
            pixelRatio: ratio,
            bounds: {
                l: 0,
                r: layout.width / layout.laneScale,
                t: 0,
                b: layout.height / layout.laneScale,
                w: layout.width / layout.laneScale,
                h: layout.height / layout.laneScale,
            },
            ups: 0,
            state: current,
            defaultGroupId: defaultGroupId.value,
            showGroupName,
            showStageName,
            nameContrast,
            recentlyActive: true,
            fontFamily: family,
            fontMiddle: textMiddle,
            figureMiddle: numberMiddle,
            names,
            nameSprites,
        }
        notes.beginFrame(timestamp)
        nameSprites.beginFrame(timestamp)
        const padding = layout.laneScale * 1.6 + 8
        const visibleRows = [...layout.rows, ...ghosts].filter(
            (row) =>
                row.y + padding >= 0 &&
                row.y - padding <= layout.height &&
                row.x + row.w / 2 + padding >= 0 &&
                row.x - row.w / 2 - padding <= layout.width,
        )
        const ghostSet = new Set(ghosts)
        const ghostContext = { ...context, slideInfos: ghostInfos }
        const drawRow = (row: ElevationRow, ghost = false) => {
            ctx.save()
            ctx.scale(layout.laneScale, layout.laneScale)
            notes.draw(
                ghost ? ghostContext : context,
                row.note,
                selected.has(row.note) || hover.has(row.note),
                ghost ? 0.5 : 1,
                {
                    left: (row.x - row.w / 2) / layout.laneScale,
                    y: row.y / layout.laneScale - 0.3,
                    size: row.size,
                },
            )
            ctx.restore()
        }
        for (const row of visibleRows) {
            if (!ghostSet.has(row) && !selected.has(row.note)) drawRow(row)
        }
        drawElevationConnections(ctx, aboveNotes)
        // Selected notes and creating previews stay in front, as on the chart.
        for (const row of visibleRows) {
            if (!ghostSet.has(row) && selected.has(row.note)) drawRow(row)
        }
        for (const row of visibleRows) {
            if (ghostSet.has(row)) drawRow(row, true)
        }
        // Axis labels go over every row and connection, as the chart's text does.
        ctx.save()
        ctx.font = `12px ${family}`
        ctx.textAlign = axisLabelLeft === undefined ? 'right' : 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = '#ffffff80'
        for (const { label, y } of axisLabels)
            ctx.fillText(label, axisLabelLeft ?? 28, y + labelBaseline)
        ctx.restore()
        // Names go over every row and connection, as on the chart.
        ctx.save()
        ctx.scale(layout.laneScale, layout.laneScale)
        placeNames(context, names)
        ctx.restore()
        for (const row of visibleRows) {
            if (selected.has(row.note) || hover.has(row.note)) {
                // As the chart's outlines: the hitbox and 0.1 lane around it.
                const pad = layout.laneScale * 0.1
                ctx.save()
                ctx.lineWidth = 2
                ctx.setLineDash([6, 4])
                ctx.strokeStyle = '#ffffff80'
                ctx.strokeRect(
                    row.x - row.w / 2 - pad,
                    row.y - layout.laneScale * 0.4,
                    row.w + 2 * pad,
                    layout.laneScale * 0.8,
                )
                ctx.restore()
            }
        }
        if (rect) {
            // The chart's box selection: a quarter white fill under a half white dashed edge.
            const left = layout.xAt(rect.laneMin)
            const top = layout.yAt(rect.elevationMax)
            const w = layout.xAt(rect.laneMax) - left
            const h = layout.yAt(rect.elevationMin) - top
            ctx.save()
            ctx.fillStyle = ctx.strokeStyle = '#fff'
            ctx.lineWidth = 2
            ctx.setLineDash([6, 4])
            ctx.globalAlpha = 0.25
            ctx.fillRect(left, top, w, h)
            ctx.globalAlpha = 0.5
            ctx.strokeRect(left, top, w, h)
            ctx.restore()
        }
        if (!layout.rows.length) {
            ctx.fillStyle = '#ffffff80'
            ctx.fillText(labels.empty, 48, 90)
        }
    })
})
onMounted(() => {
    mounted = true
    const updateBounds = () => {
        headerHeight.value = header.value?.clientHeight ?? 80
        const rect = container.value?.getBoundingClientRect()
        if (!rect) return
        Object.assign(elevationBounds, { x: rect.x, y: rect.y, w: rect.width, h: rect.height })
        updateBottomChrome()
    }
    const observer = new ResizeObserver(() => {
        updateBounds()
        fitViewport()
    })
    if (container.value) observer.observe(container.value)
    if (header.value) observer.observe(header.value)
    if (container.value) chromeMutations.observe(container.value, { childList: true })
    observeBottomChrome()
    window.addEventListener('resize', updateBounds)
    window.addEventListener('scroll', updateBounds, true)
    updateBounds()
    cleanupBounds = () => {
        observer.disconnect()
        window.removeEventListener('resize', updateBounds)
        window.removeEventListener('scroll', updateBounds, true)
    }
    window.addEventListener('keydown', onKeydown, true)
    updatePixelRatio()
    window.addEventListener('resize', updatePixelRatio)
    updateFont()
    document.fonts.addEventListener('loadingdone', updateFont)
    view.scrollingY = undefined
    view.scrollingX = undefined
    fitViewport()
    panelTools.value = Object.fromEntries(
        (Object.keys(tools) as (keyof typeof tools)[]).map((name) => [
            name,
            {
                ...(elevationToolNames.includes(name) ? tools[name] : tools.select),
                ...controls,
                secondaryTool: undefined,
                // Its paste reads the clipboard as it lands.
                press: undefined,
            },
        ]),
    )
    navigation = {
        bounds: elevationBounds,
        scrollY: (pixels) => {
            closeContextMenu()
            elevationViewport.center += pixels / elevationViewport.scale
        },
        getScaleX: () => elevationLayout.value.laneScale,
        getScaleY: () => elevationViewport.scale,
        setScaleY: (scale) => {
            closeContextMenu()
            // Locked, the lane zoom follows (the setting clamps it), and the y-scale with it.
            if (settings.elevationSquareGrid) settings.width = elevationBounds.w / (scale * 1.1)
            else elevationViewport.scale = clamp(scale, 1, 1200)
        },
        hitPoint: (x, y, minimum) => {
            const { rows, set } = hitRows(x, y, minimum)
            return { hits: rows.map((row) => row.note), set: set.map((row) => row.note) }
        },
        selectPoint: (x, y) => {
            const row = hit(x, y)
            selectAt(row ? [row] : [], { ctrl: false, shift: false })
        },
        positionAtPoint,
        pasteAtPoint,
        getContextMenuPoint: () => {
            const layout = elevationLayout.value
            const selected = new Set(state.value.selectedEntities)
            const row = layout.rows.find((row) => selected.has(row.note))
            return {
                x: elevationBounds.x + (row?.x ?? layout.xAt(0)),
                y: elevationBounds.y + (row?.y ?? layout.yAt(elevationViewport.center)),
            }
        },
    }
    activate()
})
let cleanupBounds: (() => void) | undefined
onUnmounted(() => {
    mounted = false
    cleanupBounds?.()
    chromeMutations.disconnect()
    chromeObserver.disconnect()
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('resize', updatePixelRatio)
    pixelRatioQuery?.removeEventListener('change', updatePixelRatio)
    document.fonts.removeEventListener('loadingdone', updateFont)
    cancel()
    frame.cancel()
    notes.clear()
    nameSprites.clear()
    panelTools.value = {}
    if (editorNavigation.value === navigation) editorNavigation.value = undefined
    view.scrollingX = undefined
    view.scrollingY = undefined
    view.entities = { hovered: [], creating: [] }
})
</script>

<template>
    <section
        ref="container"
        class="elevation-editor chart-pane absolute size-full [outline:none]"
        tabindex="-1"
        @pointerenter="activate"
        @focusin="activate"
        @pointerdown="container?.focus()"
        @keydown="onKeydown"
    >
        <div
            class="editor absolute size-full touch-none"
            :style="{ cursor }"
            v-on="controlListeners"
        >
            <canvas
                ref="canvas"
                class="elevation-canvas pointer-events-none absolute size-full"
                :aria-label="i18n.elevation.canvas"
                @contextrestored="restoreContext"
            />
            <OffscreenNoteIndicators
                :groups="offscreenGroups"
                :hovered="hoveredOffscreenGroup"
                :anchor="offscreenAnchor"
            />
        </div>
        <!-- Beside the main editor, notifications show in its pane instead. -->
        <LevelEditorNotification
            v-if="!isElevationSideBySide"
            pane="elevation"
            :inset="headerHeight"
        />
        <LevelEditorToolbar
            v-if="!hasToolModal('elevation')"
            pane="elevation"
            :available="availableCommands"
        />
        <EditorToolModalHost pane="elevation" />
        <div
            ref="header"
            :[dockKeysAttribute]="''"
            class="elevation-header absolute inset-x-0 top-0 isolate border-b border-white/10 bg-preview text-sm text-white/80"
            @click="blurAfterPointer"
        >
            <div class="elevation-header-layout px-4">
                <span
                    class="elevation-title min-w-0 truncate font-medium text-white"
                    :title="i18n.elevation.header"
                    >{{ i18n.elevation.header }}</span
                >
                <div class="elevation-controls">
                    <div class="elevation-beat">
                        <button
                            type="button"
                            :class="headerIconButton"
                            :aria-label="i18n.elevation.previousBeat"
                            :title="i18n.elevation.previousBeat"
                            :disabled="previousBeat === undefined"
                            @click="previousBeat !== undefined && changeBeat(previousBeat)"
                        >
                            <ChevronIcon direction="left" />
                        </button>
                        <label class="elevation-beat-field"
                            ><span class="elevation-label">{{ i18n.elevation.beat }}</span
                            ><input
                                ref="beatInput"
                                v-model.lazy="beatField"
                                :class="headerField"
                                class="focus:ring-2"
                                type="number"
                                min="1"
                                step="any"
                                :aria-label="i18n.elevation.beat"
                                @change="resyncInput($event, () => `${beatField}`)"
                                @keydown.esc="revertOnEscape($event, `${beatField}`)"
                                @keydown.enter="confirmOnEnter"
                                @keydown.up="stepBeatField($event, 1)"
                                @keydown.down="stepBeatField($event, -1)"
                                @wheel="wheelBeatField"
                        /></label>
                        <button
                            type="button"
                            :class="headerIconButton"
                            :aria-label="i18n.elevation.nextBeat"
                            :title="i18n.elevation.nextBeat"
                            :disabled="nextBeat === undefined"
                            @click="nextBeat !== undefined && changeBeat(nextBeat)"
                        >
                            <ChevronIcon direction="right" />
                        </button>
                    </div>
                    <div class="elevation-y">
                        <label class="elevation-snap"
                            ><span class="elevation-label">{{ i18n.elevation.snap }}</span
                            ><span class="elevation-select group"
                                ><select
                                    v-model="settings.elevationSnap"
                                    :title="
                                        settings.elevationSnap
                                            ? `1/${settings.elevationSnap}`
                                            : i18n.elevation.off
                                    "
                                    :class="headerField"
                                    class="cursor-pointer focus-visible:ring-2"
                                    :aria-label="i18n.elevation.snapping"
                                >
                                    <option :value="0">{{ i18n.elevation.off }}</option>
                                    <option
                                        v-for="division in [1, 2, 4, 8, 16, 32, 64]"
                                        :key="division"
                                        :value="division"
                                    >
                                        1/{{ division }}
                                    </option></select
                                ><SelectValue
                                    :value="
                                        settings.elevationSnap
                                            ? `1/${settings.elevationSnap}`
                                            : i18n.elevation.off
                                    "
                                    class="z-[2] px-3 text-base tabular-nums text-fg group-active:text-on-accent" /><span
                                    class="elevation-select-icon group-active:text-on-accent"
                                    aria-hidden="true"
                                    ><ChevronIcon direction="down" /></span></span
                        ></label>
                        <button
                            type="button"
                            class="elevation-square"
                            :class="headerButton"
                            :aria-label="i18n.elevation.squareGrid"
                            :title="i18n.elevation.squareGrid"
                            :aria-pressed="settings.elevationSquareGrid"
                            @click="settings.elevationSquareGrid = !settings.elevationSquareGrid"
                        >
                            <SquareGridIcon class="size-4" />
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    class="elevation-close"
                    :class="headerIconButton"
                    :aria-label="i18n.elevation.close"
                    :title="i18n.elevation.close"
                    @click="closeElevationEditor"
                >
                    <CloseIcon class="size-4" />
                </button>
            </div>
        </div>
    </section>
</template>

<style scoped>
/*
 * The header is workspace chrome over the canvas. Its layout follows its own
 * width; the canvas top margin is measured from the rendered header.
 * - Wide: the title, controls and close share one 32px row.
 * - Default: a title row, then one row of controls.
 * - Narrow: labels and fields in aligned grid columns.
 * - Narrowest: labels above their fields.
 */
.elevation-header {
    container-type: inline-size;
}

.elevation-header-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
        'title close'
        'controls controls';
    align-items: center;
    column-gap: 0.75rem;
    /* Two rows stay as short as the header was before 32px fields. */
    row-gap: 0.25rem;
    padding-block: 0.375rem;
}

.elevation-title {
    grid-area: title;
}

/* The title row stays one text line tall, and the glyph sits on the 16px gutter. */
.elevation-close {
    grid-area: close;
    margin-block: -0.375rem;
    margin-right: -0.5rem;
}

.elevation-controls {
    grid-area: controls;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 1rem;
    row-gap: 0.5rem;
}

/* The previous-beat glyph lines up with the title. */
.elevation-beat {
    display: flex;
    align-items: center;
    margin-left: -0.5rem;
}

.elevation-beat-field,
.elevation-snap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

/* The y-axis controls wrap together; the gap keeps 1:1 off the field. 1:1 ends the row. */
.elevation-y {
    display: flex;
    flex-grow: 1;
    align-items: center;
    gap: 0.25rem;
}

.elevation-square {
    margin-left: auto;
}

/* Its hit area covers the gap before it, reaching the snap field when the row is tight. */
@media not (pointer: coarse) {
    .elevation-square::before {
        left: -0.25rem;
    }
}

/* Pressed, it is filled and glows on hover as the toolbar's active tool does. */
@media not (forced-colors: active) {
    .elevation-square[aria-pressed='true']:not(:active) {
        @apply bg-accent text-on-accent;
    }

    .elevation-square[aria-pressed='true']:focus-visible {
        @apply ring-white;
    }
}

/* In high contrast, pressed is Highlight; focus is an inner ring, as on the toolbar's active tool. */
@media (forced-colors: active) {
    .elevation-square[aria-pressed='true'] {
        forced-color-adjust: none;
        background-color: Highlight;
        color: HighlightText;
    }

    .elevation-square[aria-pressed='true']:focus-visible {
        outline: 2px solid HighlightText;
        outline-offset: -2px;
        box-shadow:
            inset 0 0 0 4px Highlight,
            inset 0 0 0 6px HighlightText;
    }
}

.elevation-label {
    white-space: nowrap;
}

/* A field's own box wins over the hit area of the stepper beside it. */
.elevation-field {
    position: relative;
    z-index: 1;
}

/* Spinners are hidden (D8); arrow keys and the wheel still step. */
.elevation-field[type='number'] {
    -moz-appearance: textfield;
    appearance: textfield;
}

.elevation-field::-webkit-inner-spin-button,
.elevation-field::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
}

/* Over the controls row, the close button's hit area stops at it. */
@container not (min-width: 35rem) {
    .elevation-close::before {
        bottom: 0.125rem;
    }
}

@container (min-width: 35rem) {
    .elevation-header-layout {
        grid-template-columns: minmax(0, max-content) minmax(max-content, 1fr) auto;
        grid-template-areas: 'title controls close';
        column-gap: 1rem;
        padding-block: 0.5rem;
    }

    .elevation-close {
        margin-block: 0;
    }

    .elevation-controls {
        flex-wrap: nowrap;
    }

    .elevation-beat {
        margin-left: 0;
    }
}

/* Each field is sized for its values rather than squeezed to keep one row: the
   beat holds values such as 123.063, and snapping at most "1/64". Narrow
   headers wrap the snap field onto its own row instead. */
.elevation-beat-field .elevation-field {
    width: 5rem;
    padding-inline: 0.625rem;
}

.elevation-snap .elevation-field {
    width: 5rem;
    padding-right: 1.75rem;
}

/* A select carries a trailing chevron inside its pill, as form fields do. */
.elevation-select {
    position: relative;
    display: flex;
    min-width: 0;
}

.elevation-select-icon {
    pointer-events: none;
    position: absolute;
    inset-block: 0;
    right: 0.75rem;
    z-index: 2;
    display: flex;
    align-items: center;
    color: theme('colors.fg');
}

@container (max-width: 19rem) {
    /* The last column keeps its buttons 0.25rem off the fields, as wider layouts do. */
    .elevation-controls {
        display: grid;
        grid-template-columns: 2rem minmax(0, max-content) minmax(0, 1fr) 2.25rem;
        margin-inline: -0.5rem;
        column-gap: 0;
    }

    .elevation-beat,
    .elevation-beat-field,
    .elevation-y,
    .elevation-snap {
        display: contents;
    }

    .elevation-square {
        grid-column: 4;
    }

    .elevation-beat > button:last-child,
    .elevation-square {
        justify-self: end;
    }

    /* Hit areas reach the fields, and Next Beat and 1:1 meet across the row gap. */
    .elevation-beat > button:last-child::before,
    .elevation-square::before {
        left: -0.25rem;
    }

    .elevation-beat > button:last-child::before {
        bottom: -0.25rem;
    }

    .elevation-square::before {
        top: -0.25rem;
    }

    /* Its text starts where the snap value's does. */
    .elevation-beat-field .elevation-field {
        padding-inline: 0.75rem;
    }

    .elevation-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-right: 0.5rem;
    }

    .elevation-snap .elevation-label {
        grid-column: 2;
    }

    .elevation-controls .elevation-field {
        width: 100%;
    }
}

@container (max-width: 12rem) {
    /* Labels stack above their fields within the header's former height. */
    .elevation-controls {
        grid-template-columns: 2rem minmax(0, 1fr) 2.25rem;
        row-gap: 0.25rem;
    }

    .elevation-beat-field,
    .elevation-snap {
        display: flex;
        grid-column: 2;
        flex-direction: column;
        align-items: stretch;
        gap: 0;
    }

    .elevation-label {
        padding-right: 0;
    }

    .elevation-beat > button,
    .elevation-square {
        align-self: end;
    }

    .elevation-square {
        grid-column: 3;
    }
}
</style>
