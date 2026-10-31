<script setup lang="ts">
import { computed } from 'vue'
import { vScrollEdges } from '../../../directives/scrollEdges'
import type { PackageLevel } from '../../../files/package/inventory'
import BaseModal from '../../../modals/BaseModal.vue'
import type { PackageList } from './packageList'
import PackageRow from './PackageRow.vue'

// Open's list of a Sonolus package: Open on each level whose data is in the file, and Import or
// Use on each asset. Open closes the list with the level; the header's close button or Escape
// closes it with nothing.
const props = defineProps<{
    title: string
    list: PackageList
}>()

const emit = defineEmits<{
    close: [level?: PackageLevel]
}>()

const rows = computed(() => props.list.rows.value)
const busy = computed(() => props.list.working.value !== undefined)

// The first row with a button takes the focus.
const focusId = computed(
    () =>
        rows.value.find((row) =>
            row.kind === 'level'
                ? row.level.data !== undefined
                : row.state === 'import' || row.state === 'use',
        )?.id,
)
const firstAsset = computed(() => rows.value.find((row) => row.kind === 'asset')?.id)
</script>

<template>
    <BaseModal :title="title" fill @close="emit('close')">
        <div v-scroll-edges class="min-h-0 flex-1 overflow-y-auto p-2" data-package-list>
            <template v-for="row in rows" :key="row.id">
                <p
                    v-if="row.id === firstAsset && list.safeModeLine.value"
                    class="px-3 pb-1 pt-2 text-sm text-fg/80"
                    data-package-safe-mode
                >
                    {{ list.safeModeLine.value }}
                </p>
                <PackageRow
                    :row="row"
                    :image="list.pictures.value.get(row.id)"
                    :disabled="busy && list.working.value !== row.id"
                    :working="list.working.value === row.id"
                    :error="list.errors.value.get(row.id)"
                    :autofocus="row.id === focusId"
                    @open="row.kind === 'level' && emit('close', row.level)"
                    @import="row.kind === 'asset' && list.importRow(row)"
                    @use="row.kind === 'asset' && list.useRow(row)"
                />
            </template>
        </div>
    </BaseModal>
</template>
