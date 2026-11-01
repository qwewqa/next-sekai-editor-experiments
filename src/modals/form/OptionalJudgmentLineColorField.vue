<script setup lang="ts">
import { computed, h } from 'vue'
import { judgmentLineColors, type JudgmentLineColor } from '../../chart/events/stage/style'
import { i18n } from '../../i18n'
import JudgmentLineColorSwatch from './JudgmentLineColorSwatch.vue'
import OptionalSelectField from './OptionalSelectField.vue'
import type { OptionGlyph } from './optionGlyph'

const modelValue = defineModel<JudgmentLineColor | undefined>({ required: true })

// Unset, mixed and unknown values have no swatch.
const glyph = computed(() => judgmentLineColors.find((color) => color === modelValue.value))
const swatch: OptionGlyph<JudgmentLineColor> = (value) => h(JudgmentLineColorSwatch, { value })
</script>

<template>
    <OptionalSelectField
        v-model="modelValue"
        :label="i18n.modals.form.judgmentLineColor.label"
        :options="[
            [i18n.modals.form.judgmentLineColor.neutral, 'neutral'],
            [i18n.modals.form.judgmentLineColor.red, 'red'],
            [i18n.modals.form.judgmentLineColor.green, 'green'],
            [i18n.modals.form.judgmentLineColor.blue, 'blue'],
            [i18n.modals.form.judgmentLineColor.yellow, 'yellow'],
            [i18n.modals.form.judgmentLineColor.purple, 'purple'],
            [i18n.modals.form.judgmentLineColor.cyan, 'cyan'],
            [i18n.modals.form.judgmentLineColor.black, 'black'],
        ]"
        :option-glyph="swatch"
    >
        <template v-if="glyph" #leading><JudgmentLineColorSwatch :value="glyph" /></template>
    </OptionalSelectField>
</template>
