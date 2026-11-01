<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import { MINIMAP_WIDTH, settings } from '../../settings'
import { minimapMaxWidth, minimapWidth } from '../workspace'
import ResizeHandle from '../workspace/ResizeHandle.vue'
import Minimap from './Minimap.vue'
import { isMinimapShown } from './state'

/**
 * The minimap strip and its resize edge, for one side of the chart pane. The editor places one
 * on each side, and the one on the Minimap Side setting's side shows the strip. The edge and the
 * strip's hairline face the chart pane.
 */
const props = defineProps<{ side: 'left' | 'right' }>()

const isShown = computed(() => isMinimapShown.value && settings.minimapSide === props.side)
// A positive pixel delta moves the edge right, which widens a strip on the left.
const sign = computed(() => (props.side === 'left' ? 1 : -1))

const setWidth = (width: number) => {
    settings.minimapWidth = Math.round(
        Math.max(MINIMAP_WIDTH.min, Math.min(minimapMaxWidth.value, width)),
    )
}
let resizing: { original: number; origin: number } | undefined
const onResizeStart = () => {
    resizing = { original: settings.minimapWidth, origin: minimapWidth.value }
}
const onResizeMove = (delta: number) => {
    if (resizing) setWidth(resizing.origin + sign.value * delta)
}
const onResizeEnd = () => {
    resizing = undefined
}
const onResizeCancel = () => {
    if (resizing) settings.minimapWidth = resizing.original
    resizing = undefined
}
</script>

<template>
    <template v-if="isShown">
        <Minimap v-if="side === 'left'" class="shadow-[inset_-1px_0_0_rgb(255_255_255/0.1)]" />
        <div class="relative z-10 w-0 flex-none">
            <ResizeHandle
                axis="x"
                :label="i18n.workspace.resize.minimap"
                :value="minimapWidth"
                :min="MINIMAP_WIDTH.min"
                :max="minimapMaxWidth"
                @start="onResizeStart"
                @move="onResizeMove"
                @end="onResizeEnd"
                @cancel="onResizeCancel"
                @step="setWidth(minimapWidth + sign * $event)"
                @set="setWidth"
                @reset="settings.minimapWidth = MINIMAP_WIDTH.default"
            />
        </div>
        <Minimap v-if="side === 'right'" class="shadow-[inset_1px_0_0_rgb(255_255_255/0.1)]" />
    </template>
</template>
