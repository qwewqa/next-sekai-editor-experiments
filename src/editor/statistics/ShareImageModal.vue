<script setup lang="ts">
import { i18n } from '../../i18n'
import type { Category, ChartStatistics } from '../../levelData/statistics'
import BaseModal from '../../modals/BaseModal.vue'

defineProps<{
    stats: ChartStatistics
    times: Record<Category, Float64Array>
    every: Float64Array
    bgmEnd: number | undefined
    drawable: boolean
    summary: string
}>()

const emit = defineEmits<{
    close: []
}>()
</script>

<template>
    <BaseModal :title="i18n.statistics.shareImageTitle" @close="emit('close')" />
</template>
