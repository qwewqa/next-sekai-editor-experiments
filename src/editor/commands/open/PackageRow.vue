<script setup lang="ts">
import { computed, shallowRef, useId, watch } from 'vue'
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
    /** Another row's Import is running, so this row's button is disabled. */
    disabled: boolean
    /** This row's Import is running: its button keeps the focus, marked busy. */
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

// A row with nothing to press has no button column, so its reason can wrap instead of being cut.
const hasAction = computed(() =>
    props.row.kind === 'level' ? props.row.level.data !== undefined : props.row.state !== 'none',
)
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
                class="block text-sm text-fg/80"
                :class="hasAction ? 'truncate' : 'wrap-anywhere'"
                data-package-row-detail
                >{{ row.detail }}</span
            >
        </span>
        <span v-if="hasAction" class="flex min-w-24 shrink-0 justify-end">
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
                :disabled="disabled"
                :aria-disabled="working || undefined"
                :aria-describedby="error ? `${titleId} ${errorId}` : titleId"
                :data-autofocus="autofocus || undefined"
                data-package-import
                @click="working || $emit('import')"
            >
                <span :class="{ invisible: working }">{{ i18n.open.package.import }}</span>
                <span v-if="working" class="absolute inset-0 flex items-center justify-center">
                    <WaitSpinner class="size-5" />
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
    <p v-if="error" :id="errorId" class="relative pb-2 pl-22 pr-3 text-sm" data-package-error>
        <SeverityIcon severity="error" class="absolute left-16 top-0.5 size-4" />{{
            error
        }}
    </p>
</template>
