<script setup lang="ts">
import { computed, ref, useTemplateRef, watch, watchEffect, type Ref } from 'vue'
import { isDynamicStages } from '../history/dynamicStages.ts'
import { slotLoading } from '../history'
import { folderPathParts, templateParts, type NamePart } from '../chart/folders'
import { groupFolders, groups } from '../history/groups'
import { stageFolders, stages } from '../history/stages'
import { i18n } from '../i18n'
import { detection } from '../platform/detect'
import { MINIMAP_WIDTH, settings } from '../settings'
import { interpolateRaw } from '../utils/interpolate'
import { vFocusRescue } from '../directives/focusRescue'
import LevelEditorCanvas from './canvas/LevelEditorCanvas.vue'
import { commands } from './commands'
import { runCommand } from './commands/runCommand'
import ManageGroupsIcon from './commands/manageGroups/ManageGroupsIcon.vue'
import ManageStagesIcon from './commands/manageStages/ManageStagesIcon.vue'
import ElevationEditor from './elevation/ElevationEditor.vue'
import { isElevationEditorOpen, isElevationSideBySide } from './elevation/state'
import AutoscrollMarker from './AutoscrollMarker.vue'
import LevelEditorContextMenu from './LevelEditorContextMenu.vue'
import { activateEditorNavigation, useControlLifecycle } from './controls'
import { useFocusControl } from './controls/focus'
import { useKeyboardControl } from './controls/keyboard'
import './peek'
import Minimap from './minimap/Minimap.vue'
import { isMinimapShown } from './minimap/state'
import LevelEditorNotification from './LevelEditorNotification.vue'
import PeekBar from './history/PeekBar.vue'
import ChangeBand from './history/ChangeBand.vue'
import FileChip from './file/FileChip.vue'
import { notStored } from './file/notStored'
import { workNotInFile } from './file/state'
import NotStoredBar from './NotStoredBar.vue'
import StatusLabel from './StatusLabel.vue'
import StatusScope from './StatusScope.vue'
import { groupScope, stageScope } from './scope'
import LevelEditorToolbar from './toolbar/LevelEditorToolbar.vue'
import EditorToolModalHost from './EditorToolModalHost.vue'
import { hasToolModal } from './toolModals'
import { switchToolTo, tool, toolName, type ToolName } from './tools'
import { brushProperties } from './tools/brush'
import { view } from './view'
import { minimapMaxWidth, minimapWidth, workspaceLayout } from './workspace'
import ResizeHandle from './workspace/ResizeHandle.vue'
import { formatCount } from '../utils/size'

useFocusControl()
useKeyboardControl()
useControlLifecycle()

const container: Ref<HTMLDivElement | null> = useTemplateRef('container')
const host = useTemplateRef<HTMLDivElement>('host')
const hostWidth = ref(0)
const compactStatus = computed(() => hostWidth.value < 768)
const iconStatus = computed(() => hostWidth.value < 320)
const statusItems = ['tool', 'label', 'warning', 'group', 'stage', 'division'] as const
watch(host, (element, _, cleanup) => {
    if (!element) return
    const update = () => {
        hostWidth.value = element.clientWidth
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    cleanup(() => {
        observer.disconnect()
    })
})
watchEffect(() => {
    isElevationSideBySide.value =
        settings.elevationEditorSideBySide === 'allow' ||
        (settings.elevationEditorSideBySide === 'auto' && hostWidth.value >= 800)
})

const splitMinimum = computed(() =>
    Math.min(50, Math.max(20, (201 / Math.max(1, hostWidth.value)) * 100)),
)
const splitWidth = computed(() =>
    Math.max(splitMinimum.value, Math.min(100 - splitMinimum.value, settings.elevationEditorWidth)),
)
const setSplitWidth = (width: number) => {
    settings.elevationEditorWidth = Math.max(
        splitMinimum.value,
        Math.min(100 - splitMinimum.value, width),
    )
}
// The elevation pane is on the right, so moving the divider right (a positive
// pixel delta) narrows it. The setting is a percentage of the editor width.
const pixelsToPercent = (pixels: number) => (pixels / Math.max(1, hostWidth.value)) * 100
let resizing: { original: number; origin: number } | undefined
const onResizeStart = () => {
    resizing = { original: settings.elevationEditorWidth, origin: splitWidth.value }
}
const onResizeMove = (delta: number) => {
    if (resizing) setSplitWidth(resizing.origin - pixelsToPercent(delta))
}
const onResizeEnd = () => {
    resizing = undefined
}
const onResizeCancel = () => {
    if (resizing) settings.elevationEditorWidth = resizing.original
    resizing = undefined
}

// The strip is on the right, so moving its edge right (a positive pixel delta) narrows it.
const setMinimapWidth = (width: number) => {
    settings.minimapWidth = Math.round(
        Math.max(MINIMAP_WIDTH.min, Math.min(minimapMaxWidth.value, width)),
    )
}
let minimapResizing: { original: number; origin: number } | undefined
const onMinimapResizeStart = () => {
    minimapResizing = { original: settings.minimapWidth, origin: minimapWidth.value }
}
const onMinimapResizeMove = (delta: number) => {
    if (minimapResizing) setMinimapWidth(minimapResizing.origin - delta)
}
const onMinimapResizeEnd = () => {
    minimapResizing = undefined
}
const onMinimapResizeCancel = () => {
    if (minimapResizing) settings.minimapWidth = minimapResizing.original
    minimapResizing = undefined
}

// iOS and iPadOS have no leave prompt, so the bar is their strong sign while work is only here.
const showNotStoredBar = computed(
    () => detection().os === 'ios' && notStored.value !== undefined && workNotInFile.value,
)
// The bar sits above the chart. The chart is centred on `view.time`, so when the bar's height
// changes, the time moves with it and the chart holds still under the eye.
let barHeight = 0
const measureBar = () =>
    host.value?.querySelector('[data-not-stored-bar]')?.getBoundingClientRect().height ?? 0

const updateBounds = () => {
    if (!container.value) return

    const bar = measureBar()
    if (bar !== barHeight) {
        view.time = Math.max(0, view.time - (bar - barHeight) / (2 * settings.pps))
        barHeight = bar
    }
    const rect = container.value.getBoundingClientRect()
    view.x = rect.x
    view.y = rect.y
    view.w = rect.width
    view.h = rect.height
}

watch(container, (element, _, onCleanup) => {
    if (!element) return

    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    // A chart pane that was not shown while the bar changed has nothing to hold still.
    barHeight = measureBar()
    updateBounds()

    window.addEventListener('resize', updateBounds)
    window.addEventListener('scroll', updateBounds, { capture: true, passive: true })
    window.visualViewport?.addEventListener('resize', updateBounds)
    window.visualViewport?.addEventListener('scroll', updateBounds)

    onCleanup(() => {
        observer.disconnect()
        window.removeEventListener('resize', updateBounds)
        window.removeEventListener('scroll', updateBounds, true)
        window.visualViewport?.removeEventListener('resize', updateBounds)
        window.visualViewport?.removeEventListener('scroll', updateBounds)
    })
})

// Panel layout changes can move the editor without changing its dimensions.
watch(workspaceLayout, updateBounds, { flush: 'post' })

watch([groups, () => view.groupId], () => {
    if (!view.groupId) return
    if (groups.value.has(view.groupId)) return

    view.groupId = undefined
})

watch([groups, () => brushProperties.value.groupId], () => {
    if (!brushProperties.value.groupId) return
    if (groups.value.has(brushProperties.value.groupId)) return

    brushProperties.value.groupId = undefined
})

// Event tools need dynamic stages, which undo can turn off; their events would not save.
const eventTools = new Set<ToolName>([
    'cameraEvent',
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
])
watch(isDynamicStages, (value) => {
    if (!value && eventTools.has(toolName.value)) switchToolTo('select')
})

watch([stages, isDynamicStages, () => view.stageId], () => {
    if (!view.stageId) return
    if (isDynamicStages.value && stages.value.has(view.stageId)) return

    view.stageId = undefined
})

watch([stages, isDynamicStages, () => brushProperties.value.stageId], () => {
    if (!brushProperties.value.stageId) return
    if (isDynamicStages.value && stages.value.has(brushProperties.value.stageId)) return

    brushProperties.value.stageId = undefined
})

// A scope label runs its manage command, as the toolbar tool and its hotkey do.
const onStatusChip = (event: MouseEvent, item: 'group' | 'stage') => {
    void runCommand(commands[item === 'group' ? 'manageGroups' : 'manageStages'], 'panel')
    // Pointer clicks return keyboard shortcuts to the editor.
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}

// The target leads with its folder, e.g. "Verse › Lead Group", so it reads as
// inside it; the folder shortens before the name.
const group = computed((): NamePart[] =>
    view.groupId === undefined
        ? [{ text: i18n.value.statusBar.group.all, role: 'name' }]
        : templateParts(i18n.value.statusBar.group.one, [
              folderPathParts(
                  groups.value,
                  groupFolders.value,
                  view.groupId,
                  i18n.value.workspace.folders.path,
              ),
          ]),
)

const stage = computed((): NamePart[] =>
    view.stageId === undefined
        ? [{ text: i18n.value.statusBar.stage.all, role: 'name' }]
        : templateParts(i18n.value.statusBar.stage.one, [
              folderPathParts(
                  stages.value,
                  stageFolders.value,
                  view.stageId,
                  i18n.value.workspace.folders.path,
              ),
          ]),
)

const groupPath = computed(() =>
    view.groupId === undefined
        ? group.value
        : folderPathParts(
              groups.value,
              groupFolders.value,
              view.groupId,
              i18n.value.workspace.folders.path,
          ),
)
const stagePath = computed(() =>
    view.stageId === undefined
        ? stage.value
        : folderPathParts(
              stages.value,
              stageFolders.value,
              view.stageId,
              i18n.value.workspace.folders.path,
          ),
)

// Shown separately from the authoring target, and only while something is hidden.
const shownCount = (shown: number, total: number, message: string) => {
    if (shown >= total) return
    return {
        short: `${formatCount(shown)}/${formatCount(total)}`,
        label: interpolateRaw(message, formatCount(shown), formatCount(total)),
    }
}
const groupCount = computed(() =>
    shownCount(
        groupScope.shownCount.value,
        groupScope.totalCount.value,
        i18n.value.statusBar.group.shown,
    ),
)
const stageCount = computed(() =>
    shownCount(
        stageScope.shownCount.value,
        stageScope.totalCount.value,
        i18n.value.statusBar.stage.shown,
    ),
)
</script>

<template>
    <!-- An own stacking context keeps editor overlays below docks and their popups. -->
    <!-- A move waiting about 150 ms for its undo slot shows the busy cursor. -->
    <div ref="host" class="isolate flex flex-col" :class="{ 'slot-busy': slotLoading }">
        <NotStoredBar v-if="showNotStoredBar" />
        <div class="relative flex min-h-0 flex-grow select-none overflow-hidden">
            <div
                v-if="!isElevationEditorOpen || isElevationSideBySide"
                ref="container"
                v-focus-rescue
                class="chart-pane relative min-w-0 flex-1 overflow-hidden [outline:none]"
                tabindex="-1"
                @pointerenter="activateEditorNavigation()"
                @focusin="activateEditorNavigation()"
                @pointerdown="container?.focus()"
            >
                <template v-if="view.w && view.h">
                    <LevelEditorCanvas />
                </template>
                <PeekBar />
                <ChangeBand />
                <LevelEditorNotification pane="main" />
                <LevelEditorToolbar v-if="!hasToolModal('main')" pane="main" />
                <EditorToolModalHost pane="main" />
            </div>
            <template v-if="isMinimapShown && (!isElevationEditorOpen || isElevationSideBySide)">
                <div class="relative z-10 w-0 flex-none">
                    <ResizeHandle
                        axis="x"
                        :label="i18n.workspace.resize.minimap"
                        :value="minimapWidth"
                        :min="MINIMAP_WIDTH.min"
                        :max="minimapMaxWidth"
                        @start="onMinimapResizeStart"
                        @move="onMinimapResizeMove"
                        @end="onMinimapResizeEnd"
                        @cancel="onMinimapResizeCancel"
                        @step="setMinimapWidth(minimapWidth - $event)"
                        @set="setMinimapWidth"
                        @reset="settings.minimapWidth = MINIMAP_WIDTH.default"
                    />
                </div>
                <Minimap />
            </template>
            <div
                v-if="isElevationEditorOpen && isElevationSideBySide"
                class="relative z-10 w-px flex-none bg-white/10"
            >
                <ResizeHandle
                    axis="x"
                    :label="i18n.elevation.resize"
                    :value="splitWidth"
                    :min="splitMinimum"
                    :max="100 - splitMinimum"
                    @start="onResizeStart"
                    @move="onResizeMove"
                    @end="onResizeEnd"
                    @cancel="onResizeCancel"
                    @step="setSplitWidth(splitWidth - pixelsToPercent($event))"
                    @set="setSplitWidth"
                    @reset="settings.elevationEditorWidth = 50"
                />
            </div>
            <div
                v-if="isElevationEditorOpen"
                class="relative min-w-0 flex-1 overflow-hidden"
                :style="isElevationSideBySide ? { flex: `0 0 ${splitWidth}%` } : undefined"
            >
                <ElevationEditor />
            </div>
            <LevelEditorContextMenu />
            <AutoscrollMarker />
        </div>
        <!-- Status height stays fixed when warnings arrive. -->
        <div
            class="status-bar surface-chrome z-10 flex shrink-0 flex-nowrap whitespace-nowrap bg-preview text-xs text-white/80"
            :class="[compactStatus ? 'status-bar-compact gap-x-1 px-1' : 'gap-x-4 px-2']"
            data-status-bar
        >
            <template v-for="item in statusItems" :key="item">
                <StatusLabel v-if="item === 'label'" :compact="compactStatus" />
                <FileChip v-else-if="item === 'warning'" :compact="compactStatus" />
                <span
                    v-else-if="item === 'tool' && !compactStatus"
                    class="min-w-12 flex-grow self-center truncate"
                    data-status-tool
                    >{{ tool.title() }}</span
                >
                <StatusScope
                    v-else-if="item === 'group' || (item === 'stage' && isDynamicStages)"
                    :compact="compactStatus"
                    :parts="item === 'group' ? group : stage"
                    :path="item === 'group' ? groupPath : stagePath"
                    :icon="item === 'group' ? ManageGroupsIcon : ManageStagesIcon"
                    :icons-only="iconStatus"
                    :count="item === 'group' ? groupCount : stageCount"
                    :class="
                        compactStatus
                            ? iconStatus
                                ? 'w-8 flex-none'
                                : 'min-w-[5.5rem] flex-1 basis-[5.5rem]'
                            : 'min-w-0 max-w-[40%]'
                    "
                    :title="
                        item === 'group'
                            ? i18n.commands.manageGroups.title
                            : i18n.commands.manageStages.title
                    "
                    @click="onStatusChip($event, item)"
                />
                <span
                    v-else-if="item === 'division' && !compactStatus"
                    class="shrink-0 self-center"
                    data-status-division
                    >1/{{ view.division }}</span
                >
            </template>
        </div>
    </div>
</template>

<style scoped>
.slot-busy,
.slot-busy :deep(*) {
    cursor: progress !important;
}

.status-bar {
    --status-row-height: 24px;
    height: var(--status-row-height);
}

.status-bar-compact {
    --status-row-height: 32px;
}
</style>
