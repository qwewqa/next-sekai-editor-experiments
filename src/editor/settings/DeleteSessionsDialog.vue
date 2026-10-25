<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { i18n } from '../../i18n'
import type { DeleteChain } from '../../local/deleteSessions'
import BaseModal from '../../modals/BaseModal.vue'
import { interpolateRaw } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'
import { DEFAULT_RANGE, chosen, rangeCounts, type DeleteRange } from './deleteChoices'

// Delete Sessions…, the choice: how old, and whether unsaved work goes
// too. Each count follows the box, so it is what the confirm will name and delete. It
// opens on over 90 days with the box unticked, every time. Delete… only goes on to the confirm.
const props = defineProps<{ chains: DeleteChain[] }>()

const emit = defineEmits<{ close: [result: DeleteChain[] | undefined] }>()

const strings = computed(() => i18n.value.settings.localData)
const ids = useId()

const range = ref<DeleteRange>(DEFAULT_RANGE)
const includeNotSaved = ref(false)

const counts = computed(() => rangeCounts(props.chains, includeNotSaved.value))
const picked = computed(() => chosen(props.chains, range.value, includeNotSaved.value))

const label = (item: DeleteRange) =>
    item === 'all' ? strings.value.all : interpolateRaw(strings.value.lastEdited, String(item))

const submit = () => {
    if (picked.value.length) emit('close', picked.value)
}

const buttonClass = 'btn h-9 min-w-24 max-w-full truncate rounded-full px-4'
const rowClass = 'row-select relative flex min-h-10 items-center gap-3 rounded-xl px-3 py-2'
const radioClass =
    'pointer-events-none relative size-4 shrink-0 rounded-full border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-full after:bg-fg after:transition-transform peer-checked:after:scale-100'
const boxClass =
    'pointer-events-none relative size-4 shrink-0 rounded border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-[1px] after:bg-fg after:transition-transform peer-checked:after:scale-100'
</script>

<template>
    <BaseModal :title="strings.deleteTitle" @close="emit('close', undefined)">
        <form
            novalidate
            class="flex flex-col gap-4"
            data-delete-sessions
            @submit.prevent="submit"
            @modalcancel="emit('close', undefined)"
        >
            <div class="flex flex-col">
                <div class="flex flex-col" role="radiogroup" :aria-labelledby="`${ids}-title`">
                    <span :id="`${ids}-title`" class="sr-only">{{ strings.deleteTitle }}</span>
                    <label
                        v-for="item in counts"
                        :key="item.range"
                        :class="rowClass"
                        :data-delete-range="item.range"
                    >
                        <input
                            v-model="range"
                            type="radio"
                            class="peer absolute inset-0 size-full cursor-pointer opacity-0"
                            :name="`${ids}-range`"
                            :value="item.range"
                            :data-autofocus="item.range === DEFAULT_RANGE || undefined"
                        />
                        <span :class="radioClass" aria-hidden="true" />
                        <span class="pointer-events-none min-w-0 flex-1">{{
                            label(item.range)
                        }}</span>
                        <span
                            class="pointer-events-none shrink-0 tabular-nums text-fg/80"
                            data-delete-count
                            >{{ formatCount(item.count) }}</span
                        >
                    </label>
                </div>
                <label :class="[rowClass, 'mt-3']" data-delete-include>
                    <input
                        v-model="includeNotSaved"
                        type="checkbox"
                        class="peer absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                    <span :class="boxClass" aria-hidden="true" />
                    <span class="pointer-events-none min-w-0 flex-1">{{
                        strings.includeNotSaved
                    }}</span>
                </label>
            </div>

            <div class="flex justify-end gap-2">
                <button
                    type="button"
                    class="btn-secondary"
                    :class="buttonClass"
                    @click="emit('close', undefined)"
                >
                    {{ i18n.modals.confirm.cancel }}
                </button>
                <button
                    type="submit"
                    class="btn-danger-quiet"
                    :class="buttonClass"
                    :disabled="picked.length === 0"
                    data-delete-next
                >
                    {{ strings.deleteNext }}
                </button>
            </div>
        </form>
    </BaseModal>
</template>
