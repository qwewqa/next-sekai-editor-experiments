<script setup lang="ts">
import { computed, h } from 'vue'
import { i18n } from '../../i18n'
import { noteStyleOptions } from './noteStyleOptions'
import MultiSelectField from './MultiSelectField.vue'
import { noteStyles, type NoteStyle } from '../../chart/noteStyle'
import NoteStyleSwatch from './NoteStyleSwatch.vue'
import type { OptionGlyph } from './optionGlyph'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<NoteStyle | undefined>({ required: true })

// Unset, mixed and unknown values have no swatch.
const glyph = computed(() => noteStyles.find((style) => style === modelValue.value))
const swatch: OptionGlyph<NoteStyle> = (value) => h(NoteStyleSwatch, { value })
const description = usePropertyDescription((t) => t.modals.form.descriptions.noteStyle)
</script>

<template>
    <MultiSelectField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.noteStyle.label"
        :options="noteStyleOptions"
        :option-glyph="swatch"
    >
        <template v-if="glyph" #leading><NoteStyleSwatch :value="glyph" /></template>
    </MultiSelectField>
</template>
