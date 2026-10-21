<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import type { StageId, StageObject, Stages } from '../../../../../chart/stages'
import { pushState, state } from '../../../../../history'
import { onHistoryAction } from '../../../../../history/actions'
import { isPeeking, liveState, stackGeneration } from '../../../../../history/stack'
import { stages } from '../../../../../history/stages'
import { i18n } from '../../../../../i18n'
import GenerateSimLinesField from '../../../../../modals/form/GenerateSimLinesField.vue'
import IsFromStartField from '../../../../../modals/form/IsFromStartField.vue'
import IsUntilEndField from '../../../../../modals/form/IsUntilEndField.vue'
import NameField from '../../../../../modals/form/NameField.vue'
import PropertiesModal from '../../../../../modals/form/PropertiesModal.vue'
import type { StageEditKey } from '../../../../headerLabelText'
import { stageEditOperation } from '../../../../headerLabels'
import { notify } from '../../../../notification'
import { normalizeName } from '../../../../workspace/manager/model'

const props = defineProps<{
    stageId: StageId
    /** Opened while peeking: the peeked revision's values, shown and not changed. */
    readOnly?: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const generation = stackGeneration()
let expected = stages.value.get(props.stageId)
let last: StageObject = expected ?? {
    name: '',
    isFromStart: false,
    isUntilEnd: false,
    generateSimLines: 'global',
}
let current = true
const close = () => {
    if (!current) return
    current = false
    emit('close')
}
// A read-only form follows the peeked revision, whichever step is shown, until the peek ends.
const isCurrent = () =>
    current &&
    (props.readOnly
        ? isPeeking.value
        : !isPeeking.value && !!expected && stages.value.get(props.stageId) === expected) &&
    generation === stackGeneration()
const validate = () => {
    if (!isCurrent()) close()
}
const stopState = watch([liveState, isPeeking], validate, { flush: 'sync' })
const stopActions = onHistoryAction(({ kind }) => {
    if (kind === 'reset' || kind === 'undo' || kind === 'redo' || kind === 'restore') close()
    else validate()
})
onMounted(validate)
onUnmounted(() => {
    current = false
    stopState()
    stopActions()
})

const createModel = <K extends StageEditKey>(key: K) =>
    computed({
        get: () => {
            const object = stages.value.get(props.stageId)
            if (props.readOnly) return (object ?? last)[key]
            return current && object && object === expected ? object[key] : last[key]
        },
        set: (value) => {
            const object = stages.value.get(props.stageId)
            if (props.readOnly || !object || !isCurrent()) return

            const operation = stageEditOperation(props.stageId, object, key, value)
            const newObject = { ...object, [key]: value }

            const newStages: Stages = new Map(stages.value)
            newStages.set(props.stageId, newObject)
            expected = newObject
            last = newObject

            const pushed = pushState(operation, {
                ...state.value,
                stages: newStages,
            })

            // An edit that changes nothing is no step, and the stored object stays as it was.
            if (!pushed) expected = object
            else notify(() => operation.fallback.text)
        },
    })

const storedName = createModel('name')
// A blank name would list as a blank entry; keep the current one.
const name = computed({
    get: () => storedName.value,
    set: (value: string) => {
        const name = normalizeName(value)
        if (name && name !== storedName.value) storedName.value = name
    },
})
const isFromStart = createModel('isFromStart')
const isUntilEnd = createModel('isUntilEnd')
const generateSimLines = createModel('generateSimLines')
</script>

<template>
    <PropertiesModal
        :title="i18n.commands.manageStages.modal.properties.modal.title"
        @close="close"
    >
        <fieldset class="contents" :disabled="readOnly">
            <NameField v-model="name" />
            <IsFromStartField v-model="isFromStart" />
            <IsUntilEndField v-model="isUntilEnd" />
            <GenerateSimLinesField v-model="generateSimLines" />
        </fieldset>
    </PropertiesModal>
</template>
