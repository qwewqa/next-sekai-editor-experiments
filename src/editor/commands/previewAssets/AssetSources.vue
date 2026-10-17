<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { i18n } from '../../../i18n'
import { platform } from '../../../platform'
import {
    firstPaintBackgroundUrl,
    isAssetSafeModeActive,
    type AssetType,
} from '../../../preview/assets'
import { loadBuiltinInfo, type BuiltinInfo } from '../../../preview/assets/builtin'
import { choiceKey } from '../../../preview/assets/choice'
import { rowText } from '../../../preview/assets/fallbackText'
import { fallbacks } from '../../../preview/assets/active'
import type { AssetChoice } from '../../../preview/assets/types'
import { settings } from '../../../settings'
import { interpolateRaw } from '../../../utils/interpolate'

const props = defineProps<{
    type: AssetType
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const groupName = useId()
const hasDefault = platform.capabilities.defaultAssets

type Row = {
    id: string
    choice: AssetChoice
    name: string
    /** The author, and for a stored item its origin. */
    detail: string
    thumbnail: string | undefined
}

// Built-in's title, author and thumbnail come from its package, read once the tab shows.
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

const rows = computed<Row[]>(() => {
    const list: Row[] = []
    if (hasDefault)
        list.push({
            id: 'default',
            choice: { source: 'default' },
            name: defaultName.value,
            detail: '',
            // Only the background has an image of its own to show.
            thumbnail: props.type === 'background' ? firstPaintBackgroundUrl : undefined,
        })
    list.push({
        id: 'builtin',
        // In the apps Default is Built-in, which the setting stores as Default.
        choice: { source: hasDefault ? 'builtin' : 'default' },
        name: hasDefault ? strings.value.builtin : strings.value.builtinDefault,
        detail: builtin.value?.author ?? '',
        thumbnail: builtin.value?.thumbnail,
    })
    // A stored item that is the choice shows even before the Stored tab lists them all.
    const choice = chosen.value
    if (choice.source === 'file' || choice.source === 'server')
        list.push({
            id: choiceKey(choice),
            choice,
            name: interpolateRaw(
                choice.source === 'file' ? strings.value.storedFile : strings.value.storedServer,
                choice.title,
            ),
            detail: [choice.author, choice.origin].filter(Boolean).join(' · '),
            thumbnail: undefined,
        })
    return list
})

const selectedId = computed(() => {
    const choice = chosen.value
    if (choice.source === 'file' || choice.source === 'server') return choiceKey(choice)
    return choice.source === 'default' && hasDefault ? 'default' : 'builtin'
})

const select = (row: Row) => {
    if (row.id === selectedId.value) return
    settings.previewAssets = { ...settings.previewAssets, [props.type]: row.choice }
}

const fallback = computed(() => fallbacks.value.find((item) => item.type === props.type))
const noteText = computed(() =>
    isAssetSafeModeActive
        ? hasDefault
            ? strings.value.safeMode
            : strings.value.safeModeApp
        : fallback.value
          ? rowText(fallback.value)
          : '',
)
</script>

<template>
    <div class="flex flex-col" role="radiogroup" :aria-label="strings[type]" data-asset-sources>
        <template v-for="row in rows" :key="row.id">
            <label
                class="asset-row relative flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-1 transition-colors has-[:active]:bg-accent has-[:checked]:bg-button has-[:active]:text-on-accent has-[:checked]:shadow-md has-[:checked]:outline has-[:checked]:outline-1 has-[:checked]:outline-transparent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg [@media(hover:hover)]:hover:bg-band-hover [@media(hover:hover)]:has-[:checked]:hover:bg-button [@media(pointer:coarse)]:min-h-14"
                :data-asset-row="row.id"
            >
                <input
                    type="radio"
                    class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none"
                    :name="groupName"
                    :checked="row.id === selectedId"
                    @change="select(row)"
                />
                <span
                    class="pointer-events-none relative size-4 shrink-0 rounded-full border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-full after:bg-fg after:transition-transform peer-checked:after:scale-100"
                    aria-hidden="true"
                />
                <span
                    class="pointer-events-none size-10 shrink-0 overflow-hidden rounded-lg bg-recess"
                    aria-hidden="true"
                >
                    <img
                        v-if="row.thumbnail"
                        :src="row.thumbnail"
                        alt=""
                        class="size-full object-cover"
                    />
                </span>
                <span class="pointer-events-none min-w-0 flex-1">
                    <span class="block truncate">{{ row.name }}</span>
                    <span v-if="row.detail" class="block truncate text-sm opacity-75">{{
                        row.detail
                    }}</span>
                </span>
            </label>
            <p
                v-if="row.id === selectedId && noteText"
                class="pb-2 pl-[4.75rem] pr-3 pt-1 text-sm"
                data-asset-note
            >
                <span v-if="!isAssetSafeModeActive" aria-hidden="true">⚠ </span>{{ noteText }}
            </p>
        </template>
        <p v-if="type === 'effect'" class="px-3 pt-3 text-sm opacity-75" data-effect-hint>
            {{ strings.effectHint }}
        </p>
    </div>
</template>
