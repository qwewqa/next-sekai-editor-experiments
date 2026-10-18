<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    shallowRef,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
import { i18n } from '../../../i18n'
import { vScrollEdges } from '../../../directives/scrollEdges'
import BaseModal from '../../../modals/BaseModal.vue'
import { platform } from '../../../platform'
import { assetTypes, withRecentServer } from '../../../preview/assets/choice'
import { reasonText, typeLabel } from '../../../preview/assets/fallbackText'
import { fallbacks } from '../../../preview/assets/active'
import { createAssetChooser, storedChoice } from '../../../preview/assets/files/chooser'
import type { SourcePackage } from '../../../preview/assets/files/package'
import { decodeToCheck } from '../../../preview/assets/files/audio'
import { decodeImageToCheck } from '../../../preview/assets/files/decodeImage'
import { importMessage } from '../../../preview/assets/files/importText'
import { refreshStored, storedAssets, workerStore } from '../../../preview/assets/files/store'
import { maxTextureSide } from '../../../preview/assets/files/textureLimit'
import { createServerChooser } from '../../../preview/assets/server/chooser'
import { liveServerClient } from '../../../preview/assets/server/live'
import { serverItemText } from '../../../preview/assets/server/liveText'
import { storedLine, type StoredSummary } from '../../../preview/assets/stored'
import type { AssetType } from '../../../preview/assets/types'
import { settings } from '../../../settings'
import { formatSize } from '../exportLevel/format'
import AssetGlyph from './AssetGlyph.vue'
import AssetSources from './AssetSources.vue'
import StoredAssets from './StoredAssets.vue'
import { clearStoredThumbnails } from './storedThumbnails'
import { isAssetTab, previewAssetsTabs, type PreviewAssetsTab } from './tabs'

const props = defineProps<{
    tab: PreviewAssetsTab
    /** A package picked elsewhere (Open File…): its chooser opens with the items already listed. */
    file?: File
    /** That package, already opened. */
    source?: SourcePackage
}>()

const emit = defineEmits<{
    close: []
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const active = shallowRef(props.tab)
const hasDefault = platform.capabilities.defaultAssets

// One chooser per type, kept for as long as the dialog is open: switching tabs leaves a chooser
// open as it was, and closing the dialog stops what any of them is doing.
const choosers = Object.fromEntries(
    assetTypes.map((type) => [
        type,
        createAssetChooser(type, {
            store: workerStore,
            maxTextureSide,
            decodeAudio: decodeToCheck,
            decodeImage: decodeImageToCheck,
            describe: importMessage,
            apply: (choices) => {
                settings.previewAssets = { ...settings.previewAssets, ...choices }
            },
            onStorageChanged: () => void refreshStored(),
        }),
    ]),
) as Record<AssetType, ReturnType<typeof createAssetChooser>>

// One server chooser per type, beside the file chooser: they share the open state and the choices.
const serverClient = liveServerClient()
const servers = Object.fromEntries(
    assetTypes.map((type) => [
        type,
        createServerChooser(type, {
            client: serverClient,
            store: workerStore,
            maxTextureSide,
            decodeAudio: decodeToCheck,
            decodeImage: decodeImageToCheck,
            describe: serverItemText,
            toChoice: storedChoice,
            apply: (choices) => {
                settings.previewAssets = { ...settings.previewAssets, ...choices }
            },
            recent: () => settings.recentServers,
            remember: (address) => {
                settings.recentServers = withRecentServer(settings.recentServers, address)
            },
            onStorageChanged: () => void refreshStored(),
            close: () => {
                choosers[type].cancel()
            },
            // A share link to another type's item: that tab opens on the server and connects,
            // unless it is downloading, which a new connection would stop.
            handOver: (other, input) => {
                active.value = other
                choosers[other].show()
                if (servers[other].phase.value !== 'working') void servers[other].connectTo(input)
            },
        }),
    ]),
) as Record<AssetType, ReturnType<typeof createServerChooser>>

onMounted(() => {
    void refreshStored()
    if (props.file && isAssetTab(active.value)) {
        const file = props.file
        void choosers[active.value].pick(file, file.name, props.source)
    }
})
onBeforeUnmount(() => {
    for (const chooser of Object.values(choosers)) chooser.dispose()
    for (const server of Object.values(servers)) server.dispose()
    clearStoredThumbnails()
})

const uid = useId()
const tabId = (tab: PreviewAssetsTab) => `${uid}-${tab}-tab`
const panelId = `${uid}-panel`
const tablist = useTemplateRef<HTMLElement>('tablist')

const label = (tab: PreviewAssetsTab) =>
    isAssetTab(tab) ? typeLabel(tab) : strings.value.storedTab
const fallbackOf = (tab: PreviewAssetsTab) =>
    isAssetTab(tab) ? fallbacks.value.find((fallback) => fallback.type === tab) : undefined
// The mark is for sighted users; the reason is in the tab's name.
const tabName = (tab: PreviewAssetsTab) => {
    const fallback = fallbackOf(tab)
    return fallback ? `${label(tab)}. ${reasonText(fallback)}` : label(tab)
}

// The strip scrolls sideways where its tabs do not fit, keeping the shown tab in view.
const showActive = () =>
    void nextTick(() => {
        const strip = tablist.value
        const tab = strip?.querySelector<HTMLElement>(`#${CSS.escape(tabId(active.value))}`)
        if (!strip || !tab) return
        // Centred, so its neighbours show part of themselves.
        if (
            tab.offsetLeft < strip.scrollLeft ||
            tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth
        )
            strip.scrollLeft = tab.offsetLeft + (tab.offsetWidth - strip.clientWidth) / 2
        updateEdges()
    })
watch(active, showActive)

// The strip fades at an edge that has more tabs beyond it.
const atStart = shallowRef(true)
const atEnd = shallowRef(true)
const updateEdges = () => {
    const strip = tablist.value
    if (!strip) return
    atStart.value = strip.scrollLeft <= 1
    atEnd.value = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1
}
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
    showActive()
    if (tablist.value && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(updateEdges)
        resizeObserver.observe(tablist.value)
    }
})
onBeforeUnmount(() => resizeObserver?.disconnect())

const onTab = (event: MouseEvent, tab: PreviewAssetsTab) => {
    active.value = tab
    // Pointer clicks leave no focus ring behind.
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}

const onTabKeydown = (event: KeyboardEvent) => {
    const tabs = previewAssetsTabs
    const index = tabs.indexOf(active.value)
    const next = {
        ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length],
        ArrowRight: tabs[(index + 1) % tabs.length],
        Home: tabs[0],
        End: tabs[tabs.length - 1],
    }[event.key]
    if (!next) return
    event.preventDefault()
    active.value = next
    tablist.value?.querySelector<HTMLElement>(`#${CSS.escape(tabId(next))}`)?.focus()
}

// The one-click helpers set every type at once.
const setAll = (source: 'default' | 'builtin') => {
    settings.previewAssets = Object.fromEntries(
        assetTypes.map((type) => [type, { source }]),
    ) as typeof settings.previewAssets
}
// In the apps Default is Built-in, so the choice that means Built-in is Default.
const builtinSource = hasDefault ? 'builtin' : 'default'
const allBuiltin = computed(() =>
    assetTypes.every((type) => {
        const { source } = settings.previewAssets[type]
        return source === builtinSource || (!hasDefault && source === 'builtin')
    }),
)
const allDefault = computed(() =>
    assetTypes.every((type) => settings.previewAssets[type].source === 'default'),
)

// The footer counts the stored packages, and says nothing while there are none.
const summary = computed<StoredSummary>(() => ({
    count: storedAssets.value.length,
    bytes: storedAssets.value.reduce((sum, item) => sum + item.size, 0),
}))
const storedText = computed(() => storedLine(strings.value.stored, summary.value, formatSize))

// While the shown tab's chooser is open, its Cancel and Use are the actions: the footer goes.
const choosing = computed(() => isAssetTab(active.value) && choosers[active.value].open.value)

const buttonClass =
    'h-9 min-w-24 max-w-full truncate rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent disabled:pointer-events-none disabled:opacity-40'
</script>

<template>
    <BaseModal :title="strings.modal.title" fill @close="emit('close')">
        <template #header>
            <div
                ref="tablist"
                class="preview-assets-tabs relative flex h-full min-w-0 self-stretch overflow-x-auto text-base"
                :class="{
                    'preview-assets-tabs-more-before': !atStart,
                    'preview-assets-tabs-more-after': !atEnd,
                }"
                role="tablist"
                @scroll.passive="updateEdges"
            >
                <button
                    v-for="item in previewAssetsTabs"
                    :id="tabId(item)"
                    :key="item"
                    type="button"
                    role="tab"
                    class="preview-assets-tab group flex shrink-0 items-center focus-visible:outline-none"
                    :class="{ 'preview-assets-tab-active': item === active }"
                    :data-preview-assets-tab="item"
                    :aria-label="tabName(item)"
                    :aria-selected="item === active"
                    :aria-controls="item === active ? panelId : undefined"
                    :tabindex="item === active ? 0 : -1"
                    @click="onTab($event, item)"
                    @keydown="onTabKeydown"
                >
                    <!-- The band's height is the hit area; the pill carries hover, press and focus. -->
                    <span
                        class="preview-assets-tab-pill flex h-9 items-center rounded-full px-3 transition-colors group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-fg group-active:bg-accent group-active:text-on-accent"
                    >
                        <span class="preview-assets-tab-label relative whitespace-nowrap">
                            <AssetGlyph
                                v-if="fallbackOf(item)"
                                type="warning"
                                class="mr-1 inline align-[-0.1em]"
                                data-tab-warning
                            />{{ label(item) }}
                        </span>
                    </span>
                </button>
            </div>
        </template>
        <div
            :id="panelId"
            class="flex min-h-0 flex-1 flex-col border-t border-fg/25"
            role="tabpanel"
            :aria-labelledby="tabId(active)"
        >
            <div v-scroll-edges class="min-h-0 flex-1 overflow-y-auto p-2">
                <AssetSources
                    v-if="isAssetTab(active)"
                    :key="active"
                    :type="active"
                    :chooser="choosers[active]"
                    :server="servers[active]"
                />
                <StoredAssets v-else />
            </div>

            <div
                v-if="!choosing"
                class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-fg/25 p-3"
                data-preview-assets-footer
            >
                <p v-if="summary.count > 0" class="min-w-0 max-[440px]:w-full" data-stored-line>
                    {{ storedText }}
                </p>
                <div
                    class="ml-auto flex gap-2 max-[440px]:ml-0 max-[440px]:w-full max-[440px]:flex-col"
                >
                    <button
                        type="button"
                        :class="[buttonClass, 'max-[440px]:w-full']"
                        :disabled="allBuiltin"
                        data-use-builtin-all
                        @click="setAll(builtinSource)"
                    >
                        {{ strings.useBuiltinAll }}
                    </button>
                    <button
                        v-if="hasDefault"
                        type="button"
                        :class="[buttonClass, 'max-[440px]:w-full']"
                        :disabled="allDefault"
                        data-reset-default
                        @click="setAll('default')"
                    >
                        {{ strings.resetDefault }}
                    </button>
                </div>
            </div>
        </div>
    </BaseModal>
</template>

<style scoped>
.preview-assets-tabs {
    scrollbar-width: none;
}

.preview-assets-tabs::-webkit-scrollbar {
    display: none;
}

.preview-assets-tabs-more-before {
    mask-image: linear-gradient(to right, transparent 0, #000 1.5rem);
}

.preview-assets-tabs-more-after {
    mask-image: linear-gradient(to left, transparent 0, #000 1.5rem);
}

.preview-assets-tabs-more-before.preview-assets-tabs-more-after {
    mask-image: linear-gradient(
        to right,
        transparent 0,
        #000 1.5rem,
        #000 calc(100% - 1.5rem),
        transparent 100%
    );
}

/* The shown tab's bar sits on the header's lower edge, as in the manager. */
.preview-assets-tab-active .preview-assets-tab-label::after {
    content: '';
    @apply pointer-events-none absolute -bottom-3 -left-2 -right-2 h-1 rounded-t-full bg-fg;
}

@media (forced-colors: active) {
    .preview-assets-tab-active .preview-assets-tab-label::after {
        background-color: CanvasText;
    }
}

@media (hover: hover) {
    .preview-assets-tab:not(.preview-assets-tab-active):not(:active):hover
        .preview-assets-tab-pill {
        @apply bg-header-hover;
    }
}
</style>
