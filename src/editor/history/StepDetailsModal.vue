<script setup lang="ts">
import { watch } from 'vue'
import type { OperationRecipe } from '../../history/operationPresentation'
import { peekSourceGeneration } from '../../history/peek'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import OperationDetailsContent from './OperationDetailsContent.vue'
import { sourceGeneration } from './source'
import { historyViewGeneration } from './state'

const props = defineProps<{
    recipe: OperationRecipe
    time: number
    source: number
    peekSource: number
    generation: number
}>()
const emit = defineEmits<{ close: [] }>()
watch(
    [sourceGeneration, peekSourceGeneration, historyViewGeneration],
    ([source, peekSource, generation]) => {
        if (source !== props.source || peekSource !== props.peekSource || generation !== props.generation) emit('close')
    },
    { flush: 'sync', immediate: true },
)
</script>

<template>
    <BaseModal :title="i18n.history.details.title" @close="emit('close')">
        <OperationDetailsContent :recipe="recipe" :time="time" />
    </BaseModal>
</template>
