<script setup lang="ts">
import { computed, ref, useTemplateRef, watch, watchEffect, type Ref } from 'vue'
import { isDynamicStages } from '../history/dynamicStages.ts'
import { folderPathParts, templateParts, type NamePart } from '../chart/folders'
import { groupFolders, groups } from '../history/groups'
import { stageFolders, stages } from '../history/stages'
import { i18n } from '../i18n'
import { settings } from '../settings'
import { interpolateRaw } from '../utils/interpolate'
import LevelEditorCanvas from './canvas/LevelEditorCanvas.vue'
import ElevationEditor from './elevation/ElevationEditor.vue'
import { isElevationEditorOpen, isElevationSideBySide } from './elevation/state'
import LevelEditorContextMenu from './LevelEditorContextMenu.vue'
import { activateEditorNavigation, useControlLifecycle } from './controls'
import { useFocusControl } from './controls/focus'
import { useKeyboardControl } from './controls/keyboard'
import './peek'
import LevelEditorNotification from './LevelEditorNotification.vue'
import PeekBar from './history/PeekBar.vue'
import ChangeBand from './history/ChangeBand.vue'
import FileChip from './file/FileChip.vue'
import StatusLabel from './StatusLabel.vue'
import StatusScope from './StatusScope.vue'
import { groupScope, stageScope } from './scope'
import LevelEditorToolbar from './toolbar/LevelEditorToolbar.vue'
import EditorToolModalHost from './EditorToolModalHost.vue'
import { hasToolModal } from './toolModals'
import { switchToolTo, tool, toolName, type ToolName } from './tools'
import { brushProperties } from './tools/brush'
import { view } from './view'
import { workspaceLayout } from './workspace'
import { showManager, type ManagerTab } from './workspace/manager/modal'
import ResizeHandle from './workspace/ResizeHandle.vue'

useFocusControl()
useKeyboardControl()
useControlLifecycle()

const container: Ref<HTMLDivElement | null> = useTemplateRef('container')
const host = useTemplateRef<HTMLDivElement>('host')
const hostWidth = ref(0)
const compactStatus = computed(() => hostWidth.value < 768)
const narrowStatus = computed(() => hostWidth.value < 560)
const statusItems = computed(() =>
    narrowStatus.value
        ? (['label', 'warning', 'break', 'tool', 'group', 'stage', 'division'] as const)
        : (['tool', 'label', 'warning', 'group', 'stage', 'division'] as const),
)
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

const updateBounds = () => {
    if (!container.value) return

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

// Chips show the panels; the manage commands open the dialog.
const onStatusChip = (event: MouseEvent, tab: ManagerTab) => {
    showManager(tab)
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

const groupTarget = computed(() =>
    view.groupId === undefined
        ? group.value
        : templateParts(i18n.value.statusBar.group.one, [
              [{ text: groups.value.get(view.groupId)?.name ?? '', role: 'name' }],
          ]),
)
const stageTarget = computed(() =>
    view.stageId === undefined
        ? stage.value
        : templateParts(i18n.value.statusBar.stage.one, [
              [{ text: stages.value.get(view.stageId)?.name ?? '', role: 'name' }],
          ]),
)
const groupFolder = computed(() => {
    const id = view.groupId === undefined ? undefined : groups.value.get(view.groupId)?.folderId
    return id === undefined ? undefined : groupFolders.value.get(id)?.name
})
const stageFolder = computed(() => {
    const id = view.stageId === undefined ? undefined : stages.value.get(view.stageId)?.folderId
    return id === undefined ? undefined : stageFolders.value.get(id)?.name
})

// Shown separately from the authoring target, and only while something is hidden.
const shownCount = (shown: number, total: number, message: string) => {
    if (shown >= total) return
    return {
        short: `${shown}/${total}`,
        label: interpolateRaw(message, `${shown}`, `${total}`),
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
    <div class="isolate flex flex-col">
        <div ref="host" class="relative flex min-h-0 flex-grow select-none overflow-hidden">
            <div
                v-if="!isElevationEditorOpen || isElevationSideBySide"
                ref="container"
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
        </div>
        <!-- Touch-capable rows reserve their full target height before a warning arrives. -->
        <div
            class="status-bar z-10 flex shrink-0 bg-preview text-xs text-white/80"
            :class="[
                compactStatus ? 'status-bar-compact gap-x-1 px-1' : 'gap-x-4 px-2',
                narrowStatus ? 'status-bar-narrow flex-wrap' : '',
            ]"
            data-status-bar
        >
            <template v-for="item in statusItems" :key="item">
                <StatusLabel
                    v-if="item === 'label'"
                    :compact="compactStatus"
                    :narrow="narrowStatus"
                />
                <FileChip v-else-if="item === 'warning'" :compact="compactStatus" />
                <span
                    v-else-if="item === 'break'"
                    class="h-0 basis-full"
                    aria-hidden="true"
                    data-status-break
                />
                <span
                    v-else-if="item === 'tool'"
                    class="min-w-12 self-center truncate"
                    :class="narrowStatus ? 'w-12 flex-none' : 'shrink-[1000000] flex-grow'"
                    data-status-tool
                    >{{ tool.title() }}</span
                >
                <StatusScope
                    v-else-if="item === 'group' || (item === 'stage' && isDynamicStages)"
                    :compact="compactStatus"
                    :parts="item === 'group' ? group : stage"
                    :target="item === 'group' ? groupTarget : stageTarget"
                    :folder="item === 'group' ? groupFolder : stageFolder"
                    :count="item === 'group' ? groupCount : stageCount"
                    :class="
                        narrowStatus
                            ? 'min-w-11 flex-1 basis-0'
                            : compactStatus
                              ? 'min-w-28'
                              : 'min-w-11 max-w-[40%]'
                    "
                    :title="
                        item === 'group'
                            ? i18n.commands.manageGroups.title
                            : i18n.commands.manageStages.title
                    "
                    @click="onStatusChip($event, item === 'group' ? 'groups' : 'stages')"
                />
                <span
                    v-else-if="item === 'division'"
                    class="shrink-0 self-center"
                    data-status-division
                    >1/{{ view.division }}</span
                >
            </template>
        </div>
    </div>
</template>

<style scoped>
.status-bar {
    --status-row-height: 24px;
    height: var(--status-row-height);
}

.status-bar-compact {
    --status-row-height: 32px;
}

.status-bar-narrow {
    height: calc(2 * var(--status-row-height));
}

@media (any-pointer: coarse) {
    .status-bar {
        --status-row-height: 44px;
    }
}
</style>
