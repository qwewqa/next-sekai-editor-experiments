<script setup lang="ts">
import { computed } from 'vue'
import type { NoteType } from '../../chart/note'
import { i18n } from '../../i18n'
import OptionalSelectField from './OptionalSelectField.vue'
import { noteTypeGlyph } from './noteGlyphs'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<NoteType | undefined>({ required: true })

// Unset and mixed values have no picture.
const glyph = computed(() =>
    modelValue.value === undefined ? null : noteTypeGlyph(modelValue.value),
)
const description = usePropertyDescription((t) => t.modals.form.descriptions.noteType)
</script>

<template>
    <OptionalSelectField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.noteType.label"
        :options="[
            [i18n.modals.form.noteType.default, 'default'],
            [i18n.modals.form.noteType.trace, 'trace'],
            [i18n.modals.form.noteType.anchor, 'anchor'],
            [i18n.modals.form.noteType.damage, 'damage'],
            [i18n.modals.form.noteType.forceTick, 'forceTick'],
            [i18n.modals.form.noteType.forceNonTick, 'forceNonTick'],
        ]"
        :option-glyph="noteTypeGlyph"
    >
        <template v-if="glyph" #leading><component :is="glyph" /></template>
    </OptionalSelectField>
</template>
