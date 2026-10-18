import { computed, ref, shallowRef, watch } from 'vue'
import { isResettingSettings, settings } from '../../settings'
import { isCommandName } from '../commands'
import { backToNow } from '../history/selection'
import { oneRowToolbarWidth, registeredGroups, toolbarGroups } from '../toolbar/layout'
import {
    panelPositions as allPanelPositions,
    carryAcrossShape,
    coarseRailSize,
    computeWorkspaceLayout,
    dockSides,
    hasRoomFor,
    panelIds,
    railSize,
    reduceTransient,
    reduceWorkspace,
    savedPanelIds,
    tabAction,
    transientPanel,
    transientState,
    withoutTransient,
    type DockSide,
    type PanelId,
    type PanelPosition,
    type SavedPanelId,
    type Transient,
    type WorkspaceAction,
    type WorkspaceLayoutInput,
    type WorkspaceToggleState,
} from './layout'

export type { DockSide, PanelId, PanelPosition } from './layout'

const positionKeys = {
    preview: 'previewPosition',
    groups: 'groupsPosition',
    stages: 'stagesPosition',
    properties: 'propertiesPosition',
    history: 'historyPosition',
} as const satisfies Record<PanelId, keyof typeof settings>

// The transient panel has no open key: it is never saved.
const openKeys = {
    preview: 'showPreview',
    groups: 'showGroups',
    stages: 'showStages',
    properties: 'showSidebar',
} as const satisfies Partial<Record<PanelId, keyof typeof settings>>

const sizeKeys = {
    left: 'leftDockWidth',
    right: 'rightDockWidth',
    top: 'topDockHeight',
} as const satisfies Record<DockSide, keyof typeof settings>

const collapsedKeys = {
    left: 'leftDockCollapsed',
    right: 'rightDockCollapsed',
    top: 'topDockCollapsed',
} as const satisfies Record<DockSide, keyof typeof settings>

const coarseQuery = matchMedia('(pointer: coarse)')
/** Coarse pointers get larger rails and touch targets. */
export const isCoarsePointer = ref(coarseQuery.matches)
coarseQuery.addEventListener('change', () => {
    isCoarsePointer.value = coarseQuery.matches
})

/**
 * Sizes shown during a resize drag. They are saved only when the drag ends,
 * so a cancelled drag never touches the saved preference.
 */
export const dockSizeDrafts = shallowRef<Partial<Record<DockSide, number>>>({})
export const panelWeightsDraft = shallowRef<Partial<Record<PanelId, number>>>()

/** The workspace's layout viewport size, measured by the app shell. */
export const workspaceSize = shallowRef({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
})

const readRootFontSize = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

/** The root font size, which scales the default side dock width. */
const rootFontSize = shallowRef(readRootFontSize())

/** Rereads the root font size, as the app shell does with the workspace size. */
export const measureRootFontSize = () => {
    const size = readRootFontSize()
    if (size !== rootFontSize.value) rootFontSize.value = size
}

/**
 * The shape used to resolve Auto placement. The app shell holds it while a
 * text field inside a dock has focus, so an on-screen keyboard cannot move the
 * field being edited to another dock.
 */
export const autoShape = shallowRef(workspaceSize.value)

export const getPanelPosition = (id: PanelId): PanelPosition => settings[positionKeys[id]]

export const setPanelPosition = (id: PanelId, position: PanelPosition) => {
    if (getPanelPosition(id) === position) return
    // As with a dock move, the panels the default showed stay as they were.
    if (!isResettingSettings()) keepDefaults()
    // Only History's setting lacks Disabled, and its tab menu never offers it.
    if (id === transientPanel && position === 'disabled') return
    ;(settings as Record<string, unknown>)[positionKeys[id]] = position
}

export const isPanelEnabled = (id: PanelId) => getPanelPosition(id) !== 'disabled'

/** The positions a panel can take: History, which the toolbar opens, is never Disabled. */
export const panelPositionsOf = (id: PanelId): readonly PanelPosition[] =>
    id === transientPanel
        ? allPanelPositions.filter((position) => position !== 'disabled')
        : allPanelPositions

export const setDockSize = (side: DockSide, size: number) => {
    settings[sizeKeys[side]] = Math.max(0, Math.round(size))
}

const panelPositions = computed(
    () =>
        Object.fromEntries(panelIds.map((id) => [id, getPanelPosition(id)])) as Record<
            PanelId,
            PanelPosition
        >,
)

// The main editor's toolbar, which side docks' defaults leave room for.
const toolbarWidth = computed(() =>
    oneRowToolbarWidth(
        toolbarGroups(registeredGroups(settings.toolbar, isCommandName)).length,
        rootFontSize.value,
        isCoarsePointer.value,
    ),
)

const layoutInput = (state: WorkspaceToggleState, transient?: Transient) => ({
    ...workspaceSize.value,
    autoShape: autoShape.value,
    positions: panelPositions.value,
    ...state,
    sizes: {
        left: dockSizeDrafts.value.left ?? settings.leftDockWidth,
        right: dockSizeDrafts.value.right ?? settings.rightDockWidth,
        top: dockSizeDrafts.value.top ?? settings.topDockHeight,
    },
    weights: panelWeightsDraft.value ?? settings.panelWeights,
    previewAspectRatio: settings.previewAspectRatio,
    railSize: isCoarsePointer.value ? coarseRailSize : railSize,
    coarse: isCoarsePointer.value,
    previewOverlay: settings.previewTransportPosition === 'overlay',
    rootFontSize: rootFontSize.value,
    toolbarWidth: toolbarWidth.value,
    ...(transient ? { transient } : {}),
})

const layoutOf = (state: WorkspaceToggleState) => computeWorkspaceLayout(layoutInput(state))

// Null until the user first acts on panels; Groups and Stages then default to
// open where there's room.
const savedOpenStates = computed(
    () =>
        Object.fromEntries(savedPanelIds.map((id) => [id, settings[openKeys[id]]])) as Record<
            SavedPanelId,
            boolean | null
        >,
)

const isPanelStateUnset = computed(() =>
    savedPanelIds.some((id) => savedOpenStates.value[id] === null),
)

// Display settings can be given as they were before a change.
const resolveToggleState = (display: Partial<WorkspaceLayoutInput> = {}): WorkspaceToggleState => {
    const saved = savedOpenStates.value
    const unset = savedPanelIds.filter((id) => saved[id] === null)
    const state = {
        // The transient panel is never open in the saved workspace.
        open: {
            ...(Object.fromEntries(savedPanelIds.map((id) => [id, !!saved[id]])) as Record<
                SavedPanelId,
                boolean
            >),
            [transientPanel]: false,
        },
        recency: settings.panelRecency,
        collapsed: {
            left: settings.leftDockCollapsed,
            right: settings.rightDockCollapsed,
            top: settings.topDockCollapsed,
        },
    }
    const enabled = unset.filter(isPanelEnabled)
    if (!enabled.length || !hasRoomFor({ ...layoutInput(state), ...display }, enabled)) return state
    return {
        ...state,
        open: { ...state.open, ...Object.fromEntries(enabled.map((id) => [id, true])) },
    }
}

/** The saved workspace's state, without the transient layer. */
const toggleState = computed(() => resolveToggleState())

/**
 * The temporary layer over the saved workspace (Part 1 §1.4.10.4): History while it is open.
 * Never saved, so a reload starts without it, and the saved state is never changed by it.
 */
const layer = shallowRef<Transient>()

/** What is on screen: the saved state with the layer on top. */
const shownState = computed(
    () =>
        (layer.value && transientState(layoutInput(toggleState.value, layer.value))) ??
        toggleState.value,
)

export const isPanelOpen = (id: PanelId) => shownState.value.open[id]

/** The layout of the saved workspace, which shape changes are judged against. */
const baseLayout = computed(() => layoutOf(toggleState.value))

export const workspaceLayout = computed(() =>
    layer.value
        ? computeWorkspaceLayout(layoutInput(toggleState.value, layer.value))
        : baseLayout.value,
)

/** Saves only what changed, so untouched settings are not rewritten. */
const commit = (state: WorkspaceToggleState) => {
    for (const id of savedPanelIds)
        if (settings[openKeys[id]] !== state.open[id]) settings[openKeys[id]] = state.open[id]
    const recency = state.recency.filter((id) => id !== transientPanel)
    if (recency.join() !== settings.panelRecency.join()) settings.panelRecency = recency
    for (const side of dockSides)
        if (settings[collapsedKeys[side]] !== state.collapsed[side])
            settings[collapsedKeys[side]] = state.collapsed[side]
}

/** Whether the layer's panel lives in this dock. */
const isLayerDock = (side: DockSide) =>
    !!layer.value && workspaceLayout.value.sides[layer.value.id] === side

const apply = (action: WorkspaceAction) => {
    const current = layer.value
    if (!current) {
        // The transient panel is opened as a layer, never saved.
        if ('id' in action && action.id === transientPanel) {
            if (action.type !== 'close') openHistory()
            return
        }
        commit(reduceWorkspace(toggleState.value, action, layoutOf))
        return
    }
    const result = reduceTransient(toggleState.value, current, action, layoutInput)
    // Folding and closing leave the saved workspace as it is, defaults included.
    if (result.saved !== toggleState.value) commit(result.saved)
    layer.value = result.transient
    // History displaced or closed: the peek ends with it.
    if (!result.transient) backToNow()
}

// Saves the open states shown by default, so later window sizes keep them.
const keepDefaults = () => {
    commit(toggleState.value)
}

export const setDockCollapsed = (side: DockSide, collapsed: boolean) => {
    // A drawer folded by Escape or an outside press closes the layer's panel with it.
    if (isLayerDock(side) && collapsed) closeHistory()
    keepDefaults()
    settings[collapsedKeys[side]] = collapsed
}

/** Whether History is open. */
export const isHistoryOpen = computed(() => !!layer.value)

/**
 * Opens History as a layer over the saved workspace: its dock unfolds if folded, it becomes the
 * most recent panel, and panels without room are displaced, as for any panel, but nothing is
 * saved. Open already, it only unfolds.
 */
export const openHistory = () => {
    if (layer.value) apply({ type: 'show', id: transientPanel })
    else layer.value = { id: transientPanel, folds: {} }
}

/** Drops the layer: the saved workspace shows again, exactly as it was. */
export const closeHistory = () => {
    layer.value = undefined
    backToNow()
}

export const toggleHistory = () => {
    if (layer.value) closeHistory()
    else openHistory()
}

/**
 * Changing a display setting the default's room depends on saves the panels it
 * showed, so a display tweak never opens or closes panels. The app shell starts
 * it once settings are loaded.
 */
export const keepDefaultsAcrossDisplay = () =>
    watch(
        [
            () => settings.previewAspectRatio,
            () => settings.previewTransportPosition,
            () => toolbarGroups(registeredGroups(settings.toolbar, isCommandName)).length,
        ],
        (_, [previewAspectRatio, transport, tools]) => {
            if (!isPanelStateUnset.value || isResettingSettings()) return
            commit(
                resolveToggleState({
                    previewAspectRatio,
                    previewOverlay: transport === 'overlay',
                    toolbarWidth: oneRowToolbarWidth(
                        tools,
                        rootFontSize.value,
                        isCoarsePointer.value,
                    ),
                }),
            )
        },
        { flush: 'sync' },
    )

/**
 * Keeps exactly the same panels shown when rotating a tablet, or resizing
 * across a placement threshold, moves Auto panels between docks. The app shell
 * starts it once settings are loaded.
 */
export const keepPanelsAcrossShape = () =>
    watch(
        [baseLayout, panelPositions],
        ([layout, positions], [previous, previousPositions]) => {
            if (positions !== previousPositions) return
            // Until the user acts on panels, each shape shows its own default.
            if (isPanelStateUnset.value) return
            if (panelIds.every((id) => layout.sides[id] === previous.sides[id])) return
            commit(carryAcrossShape(previous, layout, toggleState.value))
        },
        // Before rendering, against the layout last rendered: the size and the
        // shape for Auto update separately, and a layout between them was
        // never seen.
        { flush: 'pre' },
    )

export const getPanelSide = (id: PanelId) => workspaceLayout.value.sides[id]

/** The side dock currently open as a drawer over the editor, if any. */
export const drawerSide = computed(() =>
    (['left', 'right'] as const).find((side) => {
        const dock = workspaceLayout.value.docks[side]
        return dock?.overlay && dock.visible.length
    }),
)

/** Whether the panel's body is currently displayed (open and not covered). */
export const isPanelVisible = (id: PanelId) => {
    const side = getPanelSide(id)
    return !!side && !!workspaceLayout.value.docks[side]?.visible.includes(id)
}

export const setPanelWeights = (weights: Partial<Record<PanelId, number>>) => {
    settings.panelWeights = { ...settings.panelWeights, ...weights }
}

export const resetPanelWeights = (ids: PanelId[]) => {
    settings.panelWeights = Object.fromEntries(
        Object.entries(settings.panelWeights).filter(([id]) => !ids.includes(id as PanelId)),
    )
}

/**
 * Opens and reveals a panel, as commands do, without making any other panel
 * appear (see `reduceWorkspace`).
 */
export const showPanel = (id: PanelId) => {
    apply({ type: 'show', id })
}

/** Closes a panel without revealing another in its place. */
export const closePanel = (id: PanelId) => {
    apply({ type: 'close', id })
}

/** Docks a panel elsewhere and shows it there, leaving nothing revealed behind. */
export const movePanel = (id: PanelId, position: PanelPosition) => {
    if (id === transientPanel) {
        // Where History docks is a setting; the layer shows it there, with no saved panel changed.
        setPanelPosition(id, position)
        if (layer.value) layer.value = { id, folds: {} }
        return
    }
    // Moving a panel saves what is on screen without the layer, as any other action does.
    if (layer.value) commit(withoutTransient(shownState.value))
    keepDefaults()
    // Panels its old dock was not showing would otherwise take its place.
    const side = getPanelSide(id)
    const covered = (side && workspaceLayout.value.docks[side]?.covered) ?? []
    for (const other of covered)
        if (other !== id && other !== transientPanel) settings[openKeys[other]] = false
    setPanelPosition(id, position)
    showPanel(id)
}

/** Whether a click on the panel's name would hide it. */
export const isTabHiding = (id: PanelId) => {
    const action = tabAction(workspaceLayout.value, shownState.value.open, id)
    return action === 'close' || action === 'collapse'
}

/** A click on a panel's name hides it if visible and otherwise shows it. */
export const onPanelTab = (id: PanelId) => {
    apply({ type: 'tab', id })
}

/** Folds a dock away, or restores exactly the panels it showed. */
export const toggleDockCollapsed = (side: DockSide) => {
    apply({ type: 'toggleDock', side })
}

/** Marks dock elements so editor shortcuts ignore keys typed inside them. */
export const workspaceDockAttribute = 'data-workspace-dock'

export const isInWorkspaceDock = (element: Element | null) =>
    !!element?.closest(`[${workspaceDockAttribute}]`)

/** Marks chrome outside docks whose controls take keys as dock controls do. */
export const dockKeysAttribute = 'data-dock-keys'

export const takesDockKeys = (element: Element | null) =>
    !!element?.closest(`[${workspaceDockAttribute}], [${dockKeysAttribute}]`)
