<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import type { GroupId, GroupObject } from '../../../../../chart/groups'
import { pushState, state } from '../../../../../history'
import { onHistoryAction } from '../../../../../history/actions'
import { isPeeking, liveState, stackGeneration } from '../../../../../history/stack'
import { groups } from '../../../../../history/groups'
import { i18n } from '../../../../../i18n'
import NameField from '../../../../../modals/form/NameField.vue'
import OptionalNumberField from '../../../../../modals/form/OptionalNumberField.vue'
import PropertiesModal from '../../../../../modals/form/PropertiesModal.vue'
import type { GroupEditKey } from '../../../../headerLabelText'
import { groupEditOperation } from '../../../../headerLabels'
import { notify } from '../../../../notification'
import { normalizeName } from '../../../../workspace/manager/model'

const props = defineProps<{
    groupId: GroupId
    /** Opened while peeking: the peeked revision's values, shown and not changed. */
    readOnly?: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const generation = stackGeneration()
let expected = groups.value.get(props.groupId)
let last: GroupObject = expected ?? { name: '' }
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
        : !isPeeking.value && !!expected && groups.value.get(props.groupId) === expected) &&
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

const createModel = <K extends GroupEditKey>(key: K) =>
    computed({
        get: () => {
            const object = groups.value.get(props.groupId)
            if (props.readOnly) return (object ?? last)[key]
            return current && object && object === expected ? object[key] : last[key]
        },
        set: (value) => {
            const object = groups.value.get(props.groupId)
            if (props.readOnly || !object || !isCurrent()) return

            const operation = groupEditOperation(props.groupId, object, key, value)
            const newObject = { ...object, [key]: value }

            const newGroups = new Map(groups.value)
            newGroups.set(props.groupId, newObject)
            expected = newObject
            last = newObject

            const pushed = pushState(operation, {
                ...state.value,
                groups: newGroups,
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
const forceNoteSpeed = createModel('forceNoteSpeed')
</script>

<template>
    <PropertiesModal
        :title="i18n.commands.manageGroups.modal.properties.modal.title"
        @close="close"
    >
        <fieldset class="contents" :disabled="readOnly">
            <NameField v-model="name" />
            <OptionalNumberField
                v-model="forceNoteSpeed"
                :label="i18n.commands.manageGroups.modal.properties.modal.forceNoteSpeed"
                :min="1"
                :max="12"
                step="any"
            />
        </fieldset>
    </PropertiesModal>
</template>
