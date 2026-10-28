<script setup lang="ts">
import {
    computed,
    defineAsyncComponent,
    defineComponent,
    h,
    useTemplateRef,
    watch,
    type Component,
    type CSSProperties,
} from 'vue'
import { recordError } from '../../diagnostics'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { clamp } from '../../utils/math'
import {
    dockSizeDrafts,
    drawerSide,
    groupsStagesSplitDraft,
    panelWeightsDraft,
    resetPanelWeights,
    setDockSize,
    setPanelWeights,
    workspaceDockAttribute,
    workspaceLayout,
    workspaceSize,
    type DockSide,
    type PanelId,
} from '.'
import { defaultGroupsShare, resizeTileUnits, separatorSize, type DockTile } from './layout'
import PanelRail from './PanelRail.vue'
import { panelTileId, panelTitle } from './panels'
import GroupsPanel from './panels/GroupsPanel.vue'
import PreviewPanel from './panels/PreviewPanel.vue'
import PropertiesPanel from './panels/PropertiesPanel.vue'
import StagesPanel from './panels/StagesPanel.vue'
import ResizeHandle from './ResizeHandle.vue'

const props = defineProps<{
    side: DockSide
}>()

// The tile of a History panel whose code did not load (offline after a deploy).
const HistoryFailed = defineComponent(
    () => () =>
        h(
            'div',
            {
                class: 'flex h-full items-center justify-center px-3 text-center text-sm text-fg/80',
                'data-history-failed': '',
            },
            i18n.value.history.loadFailed,
        ),
)

// History loads when it is first opened: it brings the storage modules' readers.
const components: Record<PanelId, Component> = {
    preview: PreviewPanel,
    groups: GroupsPanel,
    stages: StagesPanel,
    properties: PropertiesPanel,
    history: defineAsyncComponent({
        loader: () => import('../history/HistoryPanel.vue'),
        errorComponent: HistoryFailed,
        onError: (error, _retry, fail) => {
            recordError(error)
            fail()
        },
    }),
}

const dock = computed(() => workspaceLayout.value.docks[props.side])
const row = computed(() => props.side === 'top')
const length = (size: number) => (row.value ? { width: `${size}px` } : { height: `${size}px` })
const thickness = (size: number) => (row.value ? { height: `${size}px` } : { width: `${size}px` })

// Outer dock resizing shows a draft size and saves it only when the drag ends,
// so display clamps never write back and a cancelled drag changes nothing.
// A resize that ends within a pixel of where it started saves nothing either.
// While the side docks shrink to fit, a resize holds the other side at its width
// and saves that width too, so the other side never grows into the room this one gives up.
type DockSizes = Partial<Record<DockSide, number>>
let dockDrag: { base: number; held: DockSizes } | undefined
const direction = computed(() => (props.side === 'right' ? -1 : 1))

const clampDockSize = (size: number) =>
    dock.value ? clamp(size, dock.value.min, dock.value.max) : size
const heldDockSizes = (): DockSizes => {
    const other = props.side === 'left' ? 'right' : props.side === 'right' ? 'left' : undefined
    const shown = other && workspaceLayout.value.docks[other]
    return other && shown?.shrunk ? { [other]: Math.floor(shown.size) } : {}
}
const moved = (size: number, from: number) => Math.abs(size - from) >= 1
const saveDockSizes = (sizes: DockSizes) => {
    for (const [side, size] of Object.entries(sizes)) setDockSize(side as DockSide, size)
}
const setDockDrafts = (sizes: DockSizes | undefined) => {
    const own = [props.side, ...Object.keys(dockDrag?.held ?? {})]
    const rest = Object.entries(dockSizeDrafts.value).filter(([side]) => !own.includes(side))
    dockSizeDrafts.value = { ...Object.fromEntries(rest), ...sizes }
}
const onDockStart = () => {
    dockDrag = { base: dock.value?.size ?? 0, held: heldDockSizes() }
}
const onDockMove = (delta: number) => {
    if (dockDrag)
        setDockDrafts({
            ...dockDrag.held,
            [props.side]: clampDockSize(dockDrag.base + delta * direction.value),
        })
}
const onDockEnd = () => {
    const draft = dockSizeDrafts.value[props.side]
    if (dockDrag && draft !== undefined && moved(draft, dockDrag.base))
        saveDockSizes({ ...dockDrag.held, [props.side]: draft })
    onDockCancel()
}
const onDockCancel = () => {
    setDockDrafts(undefined)
    dockDrag = undefined
}
const setDisplayedDockSize = (size: number) => {
    const target = clampDockSize(size)
    if (moved(target, dock.value?.size ?? 0))
        saveDockSizes({ ...heldDockSizes(), [props.side]: target })
}

const isPaired = (id: PanelId) => id === 'groups' || id === 'stages'
// The tiles on one side of a separator: one tile, or Groups and Stages side by side.
const unitAt = (index: number) => {
    const tiles = dock.value?.tiles ?? []
    const tile = tiles[index]
    if (!tile) return []
    return dock.value?.sideBySide && isPaired(tile.id)
        ? tiles.filter(({ id }) => isPaired(id))
        : [tile]
}
const unitsAround = (index: number) => {
    const a = unitAt(index).map((tile) => ({ ...tile }))
    const b = unitAt(index + 1).map((tile) => ({ ...tile }))
    return a.length && b.length ? { a, b } : undefined
}
// The separator after Groups is the divider between Groups and Stages side by side.
const isSplit = (index: number) =>
    !!dock.value?.sideBySide && dock.value.tiles[index]?.id === 'groups'

type Separator = { axis: 'x' | 'y'; label: string; value: number; min: number; max: number }
const separators = computed(() =>
    (dock.value?.tiles ?? []).slice(0, -1).map((_, index): Separator => {
        const beside = dock.value?.sideBySide
        if (beside && isSplit(index))
            return {
                axis: 'x',
                label: interpolateRaw(
                    i18n.value.workspace.resizeTiles,
                    panelTitle('groups'),
                    panelTitle('stages'),
                ),
                value: beside.groups,
                min: beside.min,
                max: beside.max,
            }
        const a = unitAt(index)
        const b = unitAt(index + 1)
        const names = [...a, ...b].map(({ id }) => panelTitle(id))
        return {
            axis: row.value ? 'x' : 'y',
            label: interpolateRaw(
                names.length > 2
                    ? i18n.value.workspace.resizeTileRow
                    : i18n.value.workspace.resizeTiles,
                ...names,
            ),
            value: a[0]?.size ?? 0,
            min: Math.max(...a.map((tile) => tile.min)),
            max: (a[0]?.size ?? 0) + (b[0]?.size ?? 0),
        }
    }),
)

// Side by side, the body is a grid: Groups, the divider and Stages share a row, and
// every other tile and separator spans it. The sections stay the same elements, so
// the panels keep their state when the arrangement changes.
const grid = computed(() => {
    const current = dock.value
    if (!current?.sideBySide) return
    const rows: string[] = []
    const cell = (column: string): CSSProperties => ({
        gridRow: String(rows.length),
        gridColumn: column,
    })
    const tiles: CSSProperties[] = []
    const after: CSSProperties[] = []
    for (const [index, tile] of current.tiles.entries()) {
        if (tile.id !== 'stages') rows.push(`${tile.size}px`)
        tiles.push(cell(tile.id === 'groups' ? '1' : tile.id === 'stages' ? '3' : '1 / -1'))
        if (tile.id === 'groups') after.push(cell('2'))
        else if (index < current.tiles.length - 1) {
            rows.push(`${separatorSize}px`)
            after.push(cell('1 / -1'))
        }
    }
    const { groups, stages } = current.sideBySide
    return {
        body: {
            gridTemplateRows: rows.join(' '),
            gridTemplateColumns: `${groups}px ${separatorSize}px ${stages}px`,
        },
        tiles,
        separators: after,
    }
})

// A separator between stacked tiles adjusts only their relative weights, and the
// divider between Groups and Stages side by side sets Groups' share of the width.
// A drag shows a draft and saves it only when it ends.
let tileDrag: { a: DockTile[]; b: DockTile[] } | undefined
let splitDrag: { base: number } | undefined
const splitShare = (width: number) => {
    const current = dock.value
    if (!current?.sideBySide) return defaultGroupsShare
    const { min, max } = current.sideBySide
    return clamp(width, min, max) / (current.size - separatorSize)
}
const onSeparatorStart = (index: number) => {
    if (isSplit(index)) splitDrag = { base: dock.value?.sideBySide?.groups ?? 0 }
    else tileDrag = unitsAround(index)
}
const onSeparatorMove = (delta: number) => {
    if (splitDrag) groupsStagesSplitDraft.value = splitShare(splitDrag.base + delta)
    else if (tileDrag)
        panelWeightsDraft.value = {
            ...settings.panelWeights,
            ...resizeTileUnits(tileDrag.a, tileDrag.b, (tileDrag.a[0]?.size ?? 0) + delta),
        }
}
const onSeparatorCancel = () => {
    tileDrag = undefined
    splitDrag = undefined
    panelWeightsDraft.value = undefined
    groupsStagesSplitDraft.value = undefined
}
const onSeparatorEnd = () => {
    if (splitDrag && groupsStagesSplitDraft.value !== undefined)
        settings.groupsStagesSplit = groupsStagesSplitDraft.value
    if (tileDrag && panelWeightsDraft.value) settings.panelWeights = panelWeightsDraft.value
    onSeparatorCancel()
}
const onSeparatorStep = (index: number, delta: number) => {
    const beside = dock.value?.sideBySide
    if (beside && isSplit(index)) {
        settings.groupsStagesSplit = splitShare(beside.groups + delta)
        return
    }
    const units = unitsAround(index)
    if (units) setPanelWeights(resizeTileUnits(units.a, units.b, (units.a[0]?.size ?? 0) + delta))
}
const onSeparatorReset = (index: number) => {
    if (isSplit(index)) {
        settings.groupsStagesSplit = defaultGroupsShare
        return
    }
    const units = unitsAround(index)
    if (units) resetPanelWeights([...units.a, ...units.b].map(({ id }) => id))
}

// Going side by side or back changes the tiles beside a separator, so a drag
// between tiles ends then as with Escape. A drag of the dock edge goes on.
const separatorHandles = useTemplateRef<{ cancel: () => void }[]>('separatorHandles')
watch(
    () => !!dock.value?.sideBySide,
    () => {
        for (const handle of separatorHandles.value ?? []) handle.cancel()
    },
)
// A window resize changes the room a dock edge drag started from, so the drag ends as with Escape.
const dockHandle = useTemplateRef<{ cancel: () => void }>('dockHandle')
watch(workspaceSize, () => dockHandle.value?.cancel())

// A drawer opens above the editor and the top dock.
const isDrawerOpen = computed(() => drawerSide.value === props.side)
</script>

<template>
    <div
        v-if="dock"
        :[workspaceDockAttribute]="side"
        class="workspace-dock relative flex shrink-0 select-none bg-preview"
        :class="{
            'z-30': !isDrawerOpen,
            'z-40': isDrawerOpen,
            'flex-col': side === 'top',
            'flex-row': side === 'left',
            'flex-row-reverse': side === 'right',
        }"
    >
        <PanelRail :side :dock />

        <div
            v-if="dock.visible.length"
            class="workspace-dock-body min-h-0 min-w-0 shrink-0"
            :class="[
                grid ? 'grid' : ['flex', row ? 'flex-row' : 'flex-col'],
                `workspace-dock-body-${side}`,
                dock.overlay
                    ? ['absolute inset-y-0', side === 'left' ? 'left-full' : 'right-full']
                    : 'relative',
            ]"
            :style="[thickness(dock.size), grid?.body]"
        >
            <template v-for="(tile, index) in dock.tiles" :key="tile.id">
                <section
                    :id="panelTileId(tile.id)"
                    class="workspace-tile relative min-h-0 min-w-0 shrink-0"
                    :class="[
                        tile.id === 'preview' ? 'z-10' : 'overflow-hidden',
                        { 'workspace-tile-split': grid && tile.id === 'groups' },
                    ]"
                    :style="grid?.tiles[index] ?? length(tile.size)"
                    :aria-label="panelTitle(tile.id)"
                >
                    <component :is="components[tile.id]" />
                </section>
                <!-- Tiles sit apart on the dock's chrome, like the rail beside
                them, so the handle between them shows the same white line states as the dock edge handle. -->
                <div
                    v-if="separators[index]"
                    class="relative z-20 shrink-0 bg-preview"
                    :style="grid?.separators[index] ?? length(separatorSize)"
                >
                    <ResizeHandle
                        ref="separatorHandles"
                        :axis="separators[index].axis"
                        :class="separators[index].axis === 'x' ? 'left-1/2' : 'top-1/2'"
                        :label="separators[index].label"
                        :value="separators[index].value"
                        :min="separators[index].min"
                        :max="separators[index].max"
                        @start="onSeparatorStart(index)"
                        @move="onSeparatorMove"
                        @end="onSeparatorEnd"
                        @cancel="onSeparatorCancel"
                        @step="onSeparatorStep(index, $event)"
                        @set="onSeparatorStep(index, $event - separators[index].value)"
                        @reset="onSeparatorReset(index)"
                    />
                </div>
            </template>

            <div
                class="absolute"
                :class="{
                    'inset-y-0 right-0 w-0': side === 'left',
                    'inset-y-0 left-0 w-0': side === 'right',
                    'inset-x-0 bottom-0 h-0': side === 'top',
                }"
            >
                <ResizeHandle
                    ref="dockHandle"
                    :axis="row ? 'y' : 'x'"
                    :label="i18n.workspace.resize[side]"
                    :value="dock.size"
                    :min="dock.min"
                    :max="dock.max"
                    @start="onDockStart"
                    @move="onDockMove"
                    @end="onDockEnd"
                    @cancel="onDockCancel"
                    @step="setDisplayedDockSize(dock.size + $event * direction)"
                    @set="setDisplayedDockSize"
                    @reset="setDockSize(side, 0)"
                />
            </div>
        </div>
    </div>
</template>

<style scoped>
/* A soft edge where the dock meets the editor. */
.workspace-dock-body-left {
    box-shadow:
        1px 0 0 var(--dock-edge),
        6px 0 12px -6px rgb(0 0 0 / 0.45);
}

.workspace-dock-body-right {
    box-shadow:
        -1px 0 0 var(--dock-edge),
        -6px 0 12px -6px rgb(0 0 0 / 0.45);
}

.workspace-dock-body-top {
    box-shadow:
        0 1px 0 var(--dock-edge),
        0 6px 12px -6px rgb(0 0 0 / 0.45);
}

/* Overlay scrollbars keep clear of the resize handle's half over the dock, and
   Groups' keeps clear of the divider beside Stages. */
.workspace-dock-body-left,
.workspace-tile-split {
    --overlay-scrollbar-inset: 0.375rem;
}
</style>
