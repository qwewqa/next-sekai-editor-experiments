<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
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
    packageUrls,
    type AssetType,
} from '../../../preview/assets'
import { fallbacks } from '../../../preview/assets/active'
import { loadPackageInfo, builtinUrl, type PackageInfo } from '../../../preview/assets/builtin'
import { choiceKey } from '../../../preview/assets/choice'
import { defaultName, rowText } from '../../../preview/assets/fallbackText'
import { storedChoice, type AssetChooser } from '../../../preview/assets/files/chooser'
import type { ServerChooser } from '../../../preview/assets/server/chooser'
import { storedAssets, workerStore } from '../../../preview/assets/files/store'
import { displayOrigin } from '../../../preview/assets/serverUrl'
import type { AssetChoice } from '../../../preview/assets/types'
import { settings } from '../../../settings'
import { interpolateRaw } from '../../../utils/interpolate'
import SeverityIcon from '../../SeverityIcon.vue'
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
const hasDefault = platform.capabilities.defaultAssets

type Row = {
    id: string
    choice: AssetChoice
    name: string
    /** The author, and for a stored item its origin. */
    detail: string
    image: string | undefined
}

// The Next SEKAI 02 package a type has, if any.
const bundledId = props.type === 'skin' ? 'skin2' : props.type === 'effect' ? 'effect2' : undefined

// The author and picture of Built-in, Default and Next SEKAI 02 come from their packages, read once the tab shows.
const builtin = ref<PackageInfo>()
const defaultInfo = ref<PackageInfo>()
const bundledInfo = ref<PackageInfo>()
let closed = false
const read = (url: string | undefined, target: typeof builtin) => {
    if (url)
        void loadPackageInfo(url, props.type).then((info) => {
            if (!closed) target.value = info
        })
}
onMounted(() => {
    read(builtinUrl(props.type), builtin)
    if (hasDefault && props.type !== 'background') read(packageUrls[props.type], defaultInfo)
    if (hasDefault && bundledId) read(packageUrls[bundledId], bundledInfo)
})
onBeforeUnmount(() => (closed = true))

const defaultRowName = computed(() => defaultName(props.type))

const chosen = computed(() => settings.previewAssets[props.type])

const storedRow = (choice: AssetChoice & { source: 'file' | 'server' }, image?: string): Row => ({
    id: choiceKey(choice),
    choice,
    name: choice.title,
    detail: [choice.author, displayOrigin(choice.origin)].filter(Boolean).join(' · '),
    image,
})

const rows = computed<Row[]>(() => {
    const list: Row[] = [
        {
            id: 'builtin',
            // In the apps Default is Built-in, which the setting stores as Default.
            choice: { source: hasDefault ? 'builtin' : 'default' },
            name: strings.value.builtin,
            detail: builtin.value?.author ?? '',
            image: builtin.value?.image,
        },
    ]
    if (hasDefault)
        list.push({
            id: 'default',
            choice: { source: 'default' },
            name: defaultRowName.value,
            detail: defaultInfo.value?.author ?? '',
            image: props.type === 'background' ? firstPaintBackgroundUrl : defaultInfo.value?.image,
        })
    if (hasDefault && bundledId && packageUrls[bundledId]) {
        const choice: AssetChoice = { source: 'bundled', id: bundledId }
        list.push({
            id: choiceKey(choice),
            choice,
            name: strings.value.nextSekai02,
            detail: bundledInfo.value?.author ?? '',
            image: bundledInfo.value?.image,
        })
    }
    // The stored items of this type, newest first.
    for (const meta of storedAssets.value) {
        if (meta.type !== props.type) continue
        const choice = storedChoice(meta)
        if (choice.source !== 'file' && choice.source !== 'server') continue
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

const bundledType = { skin2: 'skin', effect2: 'effect' } as const

const selectedId = computed(() => {
    const choice = chosen.value
    if (choice.source === 'file' || choice.source === 'server') return choiceKey(choice)
    if (choice.source === 'bundled' && hasDefault && props.type === bundledType[choice.id])
        return choiceKey(choice)
    return choice.source === 'default' && hasDefault ? 'default' : 'builtin'
})

// A package that left storage is picked again from a file.
const chooseAgain = () => {
    props.server.setMode('file')
    props.chooser.show()
}

const select = (row: Row) => {
    if (choiceKey(row.choice) === choiceKey(chosen.value)) return
    settings.previewAssets = { ...settings.previewAssets, [props.type]: row.choice }
    // Using a stored item marks it used; the mark is only a note.
    if (row.choice.source === 'file' || row.choice.source === 'server')
        void workerStore.touch(row.choice.key).catch(() => undefined)
}

const fallback = computed(() => fallbacks.value.find((item) => item.type === props.type))
const noteText = computed(() => {
    if (isAssetSafeModeActive)
        return fallback.value
            ? rowText(fallback.value)
            : hasDefault
              ? interpolateRaw(strings.value.safeMode, defaultRowName.value)
              : ''
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

// A quick switch shows no "Loading…" and makes no room for it: the line is not in the list at all
// until the load has run for a while. (A line held back by an animation delay alone would still
// take its height, and the rows under the chosen one would stand apart from it.)
const loadingDelay = 500
const loadingShown = shallowRef(false)
let loadingTimer: ReturnType<typeof setTimeout> | undefined
watch(
    isLoading,
    (now) => {
        clearTimeout(loadingTimer)
        loadingShown.value = false
        if (now)
            loadingTimer = setTimeout(() => {
                loadingShown.value = true
            }, loadingDelay)
    },
    { immediate: true },
)
onBeforeUnmount(() => {
    clearTimeout(loadingTimer)
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
                    <SeverityIcon
                        v-if="hasWarning"
                        severity="warning"
                        class="absolute left-[4.25rem] top-[0.375rem] size-4"
                    />{{ noteText }}
                </p>
                <div v-if="canChooseAgain" class="pb-2 pl-[5.75rem] pr-3">
                    <button
                        type="button"
                        class="btn focus-out btn-secondary relative inline-flex h-7 items-center rounded-full px-3 text-sm before:absolute before:-inset-0.5"
                        data-asset-choose-again
                        @click="chooseAgain"
                    >
                        {{ strings.chooseAgain }}
                    </button>
                </div>
            </template>
            <p
                v-else-if="row.id === selectedId && loadingShown"
                class="asset-loading pb-2 pl-[5.75rem] pr-3 pt-1 text-sm text-fg/80"
                role="status"
                data-asset-loading
            >
                {{ i18n.modals.loading.loading }}
            </p>
        </template>
        <div class="px-3 pt-3">
            <button
                type="button"
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                data-asset-choose
                @click="chooser.show()"
            >
                {{ strings.choose }}
            </button>
        </div>
    </div>
</template>

<style scoped>
/* A slow switch fades "Loading…" in. */
.asset-loading {
    animation: asset-loading-in 0.2s both;
}

@keyframes asset-loading-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}
</style>
