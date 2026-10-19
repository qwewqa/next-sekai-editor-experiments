<script setup lang="ts">
import { watch } from 'vue'
import type { OperationRecipe } from '../../history/operationPresentation'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import OperationDetailsContent from './OperationDetailsContent.vue'
import { sourceGeneration } from './source'
import { historyViewGeneration } from './state'

const props = defineProps<{
    recipe: OperationRecipe
    time: number
    source: number
    generation: number
}>()
const emit = defineEmits<{ close: [] }>()
watch(
    [sourceGeneration, historyViewGeneration],
    ([source, generation]) => {
        if (source !== props.source || generation !== props.generation) emit('close')
    },
    { flush: 'sync', immediate: true },
)
</script>

<template>
    <BaseModal :title="i18n.history.details.title" @close="emit('close')">
        <OperationDetailsContent :recipe="recipe" :time="time" />
    </BaseModal>
</template>
