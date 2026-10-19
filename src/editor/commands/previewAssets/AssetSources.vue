<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
import { i18n } from '../../../i18n'
import { platform } from '../../../platform'
import {
    assetSession,
    firstPaintBackgroundUrl,
    isAssetSafeModeActive,
    type AssetType,
} from '../../../preview/assets'
import { fallbacks } from '../../../preview/assets/active'
import { loadBuiltinInfo, type BuiltinInfo } from '../../../preview/assets/builtin'
import { choiceKey } from '../../../preview/assets/choice'
import { rowText } from '../../../preview/assets/fallbackText'
import { storedChoice, type AssetChooser } from '../../../preview/assets/files/chooser'
import type { ServerChooser } from '../../../preview/assets/server/chooser'
import { storedAssets, workerStore } from '../../../preview/assets/files/store'
import { displayOrigin } from '../../../preview/assets/serverUrl'
import type { AssetChoice } from '../../../preview/assets/types'
import { settings } from '../../../settings'
import { interpolateRaw } from '../../../utils/interpolate'
import AssetGlyph from './AssetGlyph.vue'
import AssetRow from './AssetRow.vue'
import ChooserView from './ChooserView.vue'
import { storedThumbnail } from './storedThumbnails'

const props = defineProps<{
    type: AssetType
    chooser: AssetChooser
    server: ServerChooser
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const groupName = useId()
const sources = useTemplateRef<HTMLElement>('sources')
const noteId = useId()
const hintId = useId()
const hasDefault = platform.capabilities.defaultAssets
// The web fetches no servers: a file is the only way to choose.
const hasServers = platform.capabilities.serverFetch

type Row = {
    id: string
    choice: AssetChoice
    name: string
    /** The author, and for a stored item its origin. */
    detail: string
    image: string | undefined
}

// Built-in's title, author and picture come from its package, read once the tab shows.
const builtin = ref<BuiltinInfo>()
let closed = false
onMounted(() => {
    void loadBuiltinInfo(props.type).then((info) => {
        if (!closed) builtin.value = info
    })
})
onBeforeUnmount(() => (closed = true))

const defaultName = computed(() =>
    props.type === 'skin'
        ? strings.value.defaultSkin
        : props.type === 'particle'
          ? strings.value.defaultParticle
          : strings.value.default,
)

const chosen = computed(() => settings.previewAssets[props.type])

const storedRow = (choice: AssetChoice & { source: 'file' | 'server' }, image?: string): Row => ({
    id: choiceKey(choice),
    choice,
    name: interpolateRaw(
        choice.source === 'file' ? strings.value.storedFile : strings.value.storedServer,
        choice.title,
    ),
    detail: [choice.author, displayOrigin(choice.origin)].filter(Boolean).join(' · '),
    image,
})

const rows = computed<Row[]>(() => {
    const list: Row[] = []
    if (hasDefault)
        list.push({
            id: 'default',
            choice: { source: 'default' },
            name: defaultName.value,
            detail: '',
            // Only the background has an image of its own to show.
            image: props.type === 'background' ? firstPaintBackgroundUrl : undefined,
        })
    list.push({
        id: 'builtin',
        // In the apps Default is Built-in, which the setting stores as Default.
        choice: { source: hasDefault ? 'builtin' : 'default' },
        name: strings.value.builtin,
        detail: builtin.value?.author ?? '',
        image: builtin.value?.image,
    })
    // The stored items of this type, newest first.
    for (const meta of storedAssets.value) {
        if (meta.type !== props.type) continue
        const choice = storedChoice(meta)
        if (choice.source === 'default' || choice.source === 'builtin') continue
        list.push(storedRow(choice, storedThumbnail(meta)))
    }
    // A choice whose package is gone still shows, so its reason can sit under it.
    const choice = chosen.value
    if (
        (choice.source === 'file' || choice.source === 'server') &&
        !list.some((row) => row.id === choiceKey(choice))
    )
        list.push(storedRow(choice))
    return list
})

const selectedId = computed(() => {
    const choice = chosen.value
    if (choice.source === 'file' || choice.source === 'server') return choiceKey(choice)
    return choice.source === 'default' && hasDefault ? 'default' : 'builtin'
})

// A package that left storage is picked again from a file.
const chooseAgain = () => {
    props.server.setMode('file')
    props.chooser.show()
}

const select = (row: Row) => {
    if (row.id === selectedId.value) return
    settings.previewAssets = { ...settings.previewAssets, [props.type]: row.choice }
    // Using a stored item marks it used; the mark is only a note.
    if (row.choice.source === 'file' || row.choice.source === 'server')
        void workerStore.touch(row.choice.key).catch(() => undefined)
}

const fallback = computed(() => fallbacks.value.find((item) => item.type === props.type))
const noteText = computed(() => {
    if (isAssetSafeModeActive)
        return fallback.value ? rowText(fallback.value) : hasDefault ? strings.value.safeMode : ''
    return fallback.value ? rowText(fallback.value) : ''
})
const hasWarning = computed(() => !!fallback.value)
// A package that left storage is picked again from the file.
const canChooseAgain = computed(
    () => fallback.value?.reason === 'fileGone' && chosen.value.source === 'file',
)

// Closing the chooser leaves the focus on the chosen row, where the keys are useful.
watch(
    () => props.chooser.open.value,
    async (now, before) => {
        if (!before || now) return
        await nextTick()
        sources.value?.querySelector<HTMLElement>('input:checked')?.focus({ focusVisible: false })
    },
)

// The chosen asset is still loading: a switch to a stored item can take a moment.
const isLoading = computed(() => {
    if (isAssetSafeModeActive) return false
    const slot = assetSession.slots[props.type].value
    if (slot.state === 'loading') return true
    return (
        slot.state === 'ready' &&
        !!slot.choice &&
        choiceKey(slot.choice) !== choiceKey(chosen.value)
    )
})
</script>

<template>
    <ChooserView v-if="chooser.open.value" :type="type" :chooser="chooser" :server="server" />
    <div
        v-else
        ref="sources"
        class="flex flex-col"
        role="radiogroup"
        :aria-label="strings[type]"
        data-asset-sources
    >
        <template v-for="row in rows" :key="row.id">
            <AssetRow
                :type="type"
                :name="row.name"
                :detail="row.detail"
                :image="row.image"
                :checked="row.id === selectedId"
                :group="groupName"
                :autofocus="row.id === selectedId"
                :describedby="row.id === selectedId && noteText ? noteId : undefined"
                :data-asset-row="row.id"
                @select="select(row)"
            />
            <template v-if="row.id === selectedId && noteText">
                <p
                    :id="noteId"
                    class="relative pl-[5.75rem] pr-3 pt-1 text-sm"
                    :class="canChooseAgain ? 'pb-1' : 'pb-2'"
                    data-asset-note
                >
                    <AssetGlyph
                        v-if="hasWarning"
                        type="warning"
                        class="absolute left-[4.25rem] top-[0.4375rem]"
                    />{{ noteText }}
                </p>
                <div v-if="canChooseAgain" class="pb-2 pl-[5.75rem] pr-3">
                    <button
                        type="button"
                        class="btn focus-out btn-secondary inline-flex h-7 items-center rounded-full px-3 text-sm"
                        data-asset-choose-again
                        @click="chooseAgain"
                    >
                        {{ strings.chooseAgain }}
                    </button>
                </div>
            </template>
            <p
                v-else-if="row.id === selectedId && isLoading"
                class="asset-loading pb-2 pl-[5.75rem] pr-3 pt-1 text-sm opacity-75"
                role="status"
                data-asset-loading
            >
                {{ i18n.modals.loading.loading }}
            </p>
        </template>
        <p v-if="type === 'effect'" class="px-3 pt-3 text-sm opacity-75" data-effect-hint>
            {{ strings.effectHint }}
        </p>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3">
            <button
                type="button"
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                :aria-describedby="hasServers ? hintId : undefined"
                data-asset-choose
                @click="chooser.show()"
            >
                {{ strings.choose }}
            </button>
            <span
                v-if="hasServers"
                :id="hintId"
                class="min-w-0 text-sm opacity-75"
                data-asset-choose-hint
                >{{ strings.chooseHint }}</span
            >
        </div>
    </div>
</template>

<style scoped>
/* A quick switch shows no "Loading…"; a slow one fades it in. */
.asset-loading {
    animation: asset-loading-in 0.2s 0.5s both;
}

@keyframes asset-loading-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 0.75;
    }
}
</style>
