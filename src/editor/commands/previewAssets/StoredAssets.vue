<script setup lang="ts">
import { computed, shallowRef, useId } from 'vue'
import { i18n } from '../../../i18n'
import { showChoice } from '../../../modals/choice'
import { assetTypes, choiceKey } from '../../../preview/assets/choice'
import { storedChoice } from '../../../preview/assets/files/chooser'
import {
    refreshStored,
    storedAssets,
    storedLoaded,
    storedUnavailable,
    workerStore,
} from '../../../preview/assets/files/store'
import type { AssetChoice } from '../../../preview/assets/types'
import { settings } from '../../../settings'
import { interpolateRaw } from '../../../utils/interpolate'
import { formatSize } from '../exportLevel/format'
import AssetGlyph from './AssetGlyph.vue'
import { storedThumbnail } from './storedThumbnails'

// The Stored tab (Part 2, 2.6): every stored file and server item, with its size, whether a type
// uses it, and Remove, which asks first for one in use.
const strings = computed(() => i18n.value.commands.previewAssets)
const uid = useId()

const sameStored = (choice: AssetChoice, key: string) =>
    (choice.source === 'file' || choice.source === 'server') && choice.key === key

const rows = computed(() =>
    storedAssets.value.map((meta) => {
        const choice = storedChoice(meta)
        return {
            meta,
            key: choiceKey(choice),
            users: assetTypes.filter((type) => sameStored(settings.previewAssets[type], meta.key)),
        }
    }),
)

const label = (type: (typeof assetTypes)[number]) => strings.value[type]

/** The row whose Remove failed, until the next Remove. */
const failedKey = shallowRef<string>()

const remove = async (row: (typeof rows.value)[number]) => {
    failedKey.value = undefined
    if (row.users.length) {
        const confirmed = await showChoice({
            title: () => strings.value.remove,
            message: () => interpolateRaw(strings.value.removeInUse, row.meta.title),
            choices: [{ value: true, label: () => strings.value.remove, danger: true }],
            // Nothing is removed by a stray Enter.
            cancelIsDefault: true,
        })
        if (!confirmed) return
    }
    try {
        await workerStore.remove(row.meta.key)
    } catch (error) {
        console.error('Could not remove the stored preview asset:', error)
        failedKey.value = row.meta.key
        return
    }
    // The types that used it use Default again.
    const next = { ...settings.previewAssets }
    for (const type of row.users) next[type] = { source: 'default' }
    if (row.users.length) settings.previewAssets = next
    await refreshStored()
}

const buttonClass =
    'h-9 min-w-24 max-w-full truncate rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11'
</script>

<template>
    <p v-if="storedUnavailable" class="relative py-2 pl-10 pr-3" data-stored-unavailable>
        <AssetGlyph type="warning" class="absolute left-3 top-[0.6875rem]" />{{
            strings.storedUnavailable
        }}
    </p>
    <p v-else-if="!rows.length && storedLoaded" class="px-3 py-2 opacity-75" data-stored-empty>
        {{ strings.storedEmpty }}
    </p>
    <ul v-if="rows.length" class="flex flex-col" data-stored-list>
        <li
            v-for="row in rows"
            :key="row.meta.key"
            class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-1.5"
            :data-stored-item="row.meta.key"
        >
            <span
                class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-recess"
                aria-hidden="true"
            >
                <img
                    v-if="storedThumbnail(row.meta)"
                    :src="storedThumbnail(row.meta)"
                    alt=""
                    class="size-full object-cover"
                />
                <AssetGlyph v-else :type="row.meta.type" class="opacity-60" />
            </span>
            <span class="min-w-0 flex-1 basis-40">
                <span :id="`${uid}-${row.meta.key}`" class="block truncate" data-stored-title>{{
                    row.meta.title
                }}</span>
                <span class="block truncate text-sm opacity-75" data-stored-detail>{{
                    [label(row.meta.type), row.meta.origin].join(' · ')
                }}</span>
            </span>
            <span
                class="flex shrink-0 items-center gap-3 max-[440px]:w-full max-[440px]:pl-[3.25rem]"
            >
                <span class="text-sm opacity-75" data-stored-size>{{
                    formatSize(row.meta.size)
                }}</span>
                <!-- The pill keeps its place in a row not in use, so the columns line up. -->
                <span
                    class="rounded-full bg-fg/10 px-2 py-0.5 text-sm"
                    :class="{ invisible: !row.users.length }"
                    :aria-hidden="!row.users.length"
                    :data-stored-in-use="row.users.length ? '' : undefined"
                    >{{ strings.inUse }}</span
                >
                <button
                    type="button"
                    :class="[buttonClass, 'ml-auto']"
                    :aria-describedby="`${uid}-${row.meta.key}`"
                    data-stored-remove
                    @click="remove(row)"
                >
                    {{ strings.remove }}
                </button>
            </span>
            <p
                v-if="failedKey === row.meta.key"
                class="relative w-full pl-[3.25rem] text-sm"
                role="alert"
                data-stored-remove-failed
            >
                <AssetGlyph type="warning" class="absolute left-[1.75rem] top-[0.1875rem]" />{{
                    strings.removeFailed
                }}
            </p>
        </li>
    </ul>
</template>
