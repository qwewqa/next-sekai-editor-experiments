<script setup lang="ts">
import { shallowRef, useId, watch } from 'vue'
import { i18n } from '../../../i18n'
import SeverityIcon from '../../SeverityIcon.vue'
import WaitSpinner from '../../workspace/WaitSpinner.vue'
import AssetGlyph from '../previewAssets/AssetGlyph.vue'
import type { ListRow } from './packageList'

// One row of Open's package list: a 40 px picture, the title and a detail line, and what the row
// does in a column of its own width, so every row's text ends at the same place.
const props = defineProps<{
    row: ListRow
    image?: string | undefined
    /** Something else works: the row's button waits. */
    disabled: boolean
    /** This row's Import runs. */
    working: boolean
    error?: string | undefined
    autofocus: boolean
}>()

defineEmits<{
    open: []
    import: []
    use: []
}>()

const titleId = useId()
const errorId = useId()

// A picture that fails to load gives way to the glyph.
const failed = shallowRef(false)
watch(
    () => props.image,
    () => (failed.value = false),
)

const buttonClass = 'btn btn-secondary relative h-9 min-w-24 max-w-full truncate rounded-full px-4'
</script>

<template>
    <div class="flex min-h-12 items-center gap-3 rounded-xl px-3 py-1" :data-package-row="row.id">
        <span
            class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-recess"
            aria-hidden="true"
        >
            <img
                v-if="image && !failed"
                :src="image"
                alt=""
                class="size-full object-cover"
                @error="failed = true"
            />
            <AssetGlyph
                v-else
                :type="row.kind === 'level' ? 'level' : row.asset.type"
                class="opacity-60"
            />
        </span>
        <span class="min-w-0 flex-1">
            <span :id="titleId" class="block truncate" data-package-row-title>{{ row.title }}</span>
            <span
                v-if="row.detail"
                class="block truncate text-sm text-fg/80"
                data-package-row-detail
                >{{ row.detail }}</span
            >
        </span>
        <span class="flex min-w-24 shrink-0 justify-end">
            <template v-if="row.kind === 'level'">
                <button
                    v-if="row.level.data !== undefined"
                    type="button"
                    :class="buttonClass"
                    :disabled="disabled"
                    :aria-describedby="titleId"
                    :data-autofocus="autofocus || undefined"
                    data-package-open
                    @click="$emit('open')"
                >
                    {{ i18n.open.package.open }}
                </button>
            </template>
            <span v-else-if="row.state === 'inUse'" class="px-4 text-sm" data-package-in-use>{{
                i18n.commands.previewAssets.inUse
            }}</span>
            <button
                v-else-if="row.state === 'import'"
                type="button"
                :class="buttonClass"
                :disabled="disabled || working"
                :aria-describedby="error ? `${titleId} ${errorId}` : titleId"
                :data-autofocus="autofocus || undefined"
                data-package-import
                @click="$emit('import')"
            >
                <span :class="{ invisible: working }">{{ i18n.open.package.import }}</span>
                <span v-if="working" class="absolute inset-0 flex items-center justify-center">
                    <WaitSpinner class="size-5" />
                    <span class="sr-only" role="status">{{
                        i18n.commands.previewAssets.progress.storing
                    }}</span>
                </span>
            </button>
            <button
                v-else-if="row.state === 'use'"
                type="button"
                :class="buttonClass"
                :disabled="disabled"
                :aria-describedby="titleId"
                :data-autofocus="autofocus || undefined"
                data-package-use
                @click="$emit('use')"
            >
                {{ i18n.commands.previewAssets.use }}
            </button>
        </span>
    </div>
    <p
        v-if="error"
        :id="errorId"
        class="relative pb-2 pl-[5.5rem] pr-3 text-sm"
        aria-live="polite"
        data-package-error
    >
        <SeverityIcon severity="error" class="absolute left-[4rem] top-[0.125rem] size-4" />{{
            error
        }}
    </p>
</template>
