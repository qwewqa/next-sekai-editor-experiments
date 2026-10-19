<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import ChevronIcon from '../editor/workspace/ChevronIcon.vue'
import { i18n } from '../i18n'
import { isPlaying } from '../player'
import { settings } from '../settings'
import { firstPaintBackgroundUrl, isAssetSafeModeActive } from './assets'
import AssetFallbackLine from './AssetFallbackLine.vue'
import PreviewSettings from './PreviewSettings.vue'
import PreviewTransport from './PreviewTransport.vue'
import { usePreviewRendering } from './usePreviewRendering'
import { usePreviewResources } from './usePreviewResources'
import { usePreviewViewport } from './usePreviewViewport'

const container = useTemplateRef<HTMLDivElement>('container')
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const background = useTemplateRef<HTMLDivElement>('background')
const selectionCanvas = useTemplateRef<HTMLCanvasElement>('selection')
const resources = usePreviewResources()
const { status, errorDetail, loadVersion, reload } = resources
// Default's image shows from the first frame; any other choice leaves the colour until it loads.
const firstPaintUrl = computed(() =>
    isAssetSafeModeActive || settings.previewAssets.background.source === 'default'
        ? firstPaintBackgroundUrl
        : undefined,
)
// The image, blurred as its configuration says; the quad it fills is set per frame.
const backgroundStyle = computed(() => {
    const background = resources.background.value
    return background
        ? {
              backgroundImage: `url("${background.url}")`,
              filter: background.blur > 0 ? `blur(${background.blur}px)` : undefined,
          }
        : firstPaintUrl.value && { backgroundImage: `url("${firstPaintUrl.value}")` }
})
// Behind the image, where a contained or narrower one leaves the screen bare.
const backgroundColor = computed(() => {
    const color = resources.background.value?.color
    return color && color !== 'transparent' ? color : undefined
})
const backgroundMask = computed(() => resources.background.value?.mask)
// A load that fails while the browser reports no network says so.
const offline = ref(!navigator.onLine)
const updateOnline = () => (offline.value = !navigator.onLine)
onMounted(() => {
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
})
onBeforeUnmount(() => {
    window.removeEventListener('online', updateOnline)
    window.removeEventListener('offline', updateOnline)
})
const viewport = usePreviewViewport(container)
const {
    canvasStyle,
    controlsLayout,
    controlsStyle,
    controlsButtonStyle,
    settingsLayout,
    focusPlacementOnMount,
    areControlsExpanded,
    areTransportControlsVisible,
    onControlsResize,
    onTimeResize,
} = viewport
usePreviewRendering(canvas, background, resources, viewport, selectionCanvas)

const isErrorDetailOpen = ref(false)
</script>

<template>
    <div class="flex h-full w-full flex-col">
        <div ref="container" class="preview relative min-h-0 w-full flex-1">
            <!-- Until the skin is ready there is no strip to make room for, so the
        status fills the whole panel rather than leaving an empty band. -->
            <div
                class="preview-viewport absolute overflow-hidden bg-black"
                :class="{ 'inset-0': status !== 'ready' }"
                :style="[status === 'ready' ? canvasStyle : undefined, { backgroundColor }]"
            >
                <div
                    ref="background"
                    class="preview-background pointer-events-none absolute inset-0 origin-top-left"
                    :style="backgroundStyle"
                    aria-hidden="true"
                />
                <div
                    v-if="backgroundMask"
                    class="pointer-events-none absolute inset-0"
                    :style="{ backgroundColor: backgroundMask }"
                    aria-hidden="true"
                    data-background-mask
                />
                <canvas
                    ref="canvas"
                    :key="`${loadVersion}:${settings.previewAntialias}`"
                    class="absolute inset-0 h-full w-full"
                />

                <canvas
                    ref="selection"
                    :key="`selection:${loadVersion}`"
                    class="preview-selection pointer-events-none absolute inset-0 h-full w-full"
                    aria-hidden="true"
                />

                <div
                    v-if="status !== 'ready'"
                    class="absolute inset-0 flex overflow-y-auto bg-black/40 p-4 text-center text-sm text-white/90"
                >
                    <div class="m-auto flex w-full shrink-0 flex-col items-center gap-2">
                        <template v-if="status === 'loading'">{{
                            i18n.preview.loadingSkin
                        }}</template>
                        <template v-else>
                            <p>
                                {{
                                    status === 'error'
                                        ? i18n.preview.graphicsUnavailable
                                        : i18n.preview.skinUnavailable
                                }}
                            </p>
                            <p v-if="status === 'error'">{{ i18n.preview.graphicsHelp }}</p>
                            <p v-if="status === 'missing' && offline">
                                {{ i18n.commands.previewAssets.offline }}
                            </p>
                            <details
                                v-if="errorDetail"
                                class="max-h-32 max-w-full overflow-auto break-words"
                                @toggle="
                                    isErrorDetailOpen = ($event.target as HTMLDetailsElement).open
                                "
                            >
                                <!-- The shared chevron in place of the native marker. -->
                                <summary
                                    class="focus-ring flex h-8 cursor-pointer list-none items-center justify-center gap-2 rounded-full px-3 [&::-webkit-details-marker]:hidden"
                                >
                                    <ChevronIcon
                                        :direction="isErrorDetailOpen ? 'down' : 'right'"
                                    />
                                    {{ i18n.preview.errorDetails }}
                                </summary>
                                <p>{{ errorDetail }}</p>
                            </details>
                            <button
                                type="button"
                                class="btn btn-secondary h-8 rounded-full px-4"
                                @click="reload"
                            >
                                {{ i18n.preview.reload }}
                            </button>
                        </template>
                    </div>
                </div>
            </div>

            <PreviewTransport
                v-if="status === 'ready'"
                v-model="areTransportControlsVisible"
                :layout="controlsLayout"
                @time-resize="onTimeResize"
            />

            <PreviewSettings
                v-if="status === 'ready' && !isPlaying"
                v-model:expanded="areControlsExpanded"
                :button-hidden="!!settingsLayout?.isButtonBlocked"
                :button-style="controlsButtonStyle"
                :panel-style="controlsStyle"
                :placed="!!settingsLayout"
                :focus-placement="focusPlacementOnMount"
                :floating="
                    !!settingsLayout &&
                    settingsLayout.placement !== 'below' &&
                    settingsLayout.placement !== 'over'
                "
                @resize="onControlsResize"
            />
        </div>

        <AssetFallbackLine />
    </div>
</template>

<style scoped>
.preview-background {
    background-position: center;
    background-repeat: no-repeat;
    background-size: cover;
}
</style>
