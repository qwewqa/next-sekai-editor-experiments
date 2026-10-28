<script setup lang="ts" generic="const T">
import ChevronIcon from '../../editor/workspace/ChevronIcon.vue'
import { computed } from 'vue'
import BaseField from './BaseField.vue'
import { hasGlyphColumn, OptionGlyphSlot, type OptionGlyph } from './optionGlyph'
import { resyncSelect } from './resync'
import SelectValue from './SelectValue.vue'
import { isUnknownValue, optionName } from './fieldUsage'
import { unknownLabel } from './unknownLabel'

const props = defineProps<{
    label: string
    options: (readonly [string, NoInfer<T>])[]
    disabled?: boolean
    /** Each value's picture in the shared list. */
    optionGlyph?: OptionGlyph<NoInfer<T>>
    /** What the setting does, behind an ⓘ after the label. */
    description?: string
}>()

const modelValue = defineModel<T>({ required: true })
const unknown = computed(() => isUnknownValue(modelValue.value, props.options))
// The shown value, also on hover where it truncates.
const shown = computed(() =>
    unknown.value ? unknownLabel(modelValue.value) : optionName(modelValue.value, props.options),
)
const glyphs = computed(() =>
    hasGlyphColumn(
        props.optionGlyph,
        props.options.map(([, value]) => value),
    ),
)
</script>

<template>
    <BaseField :label :description>
        <div class="form-field-select group" :class="{ 'opacity-40': disabled }">
            <select
                v-model.lazy="modelValue"
                :disabled
                :title="shown"
                class="btn btn-secondary w-full appearance-none rounded-full px-4 py-1 disabled:opacity-70"
                required
                @change="resyncSelect($event, () => modelValue)"
            >
                <!-- A value no option names; shown, never listed or committed. -->
                <option v-if="unknown" :value="modelValue" disabled hidden>
                    {{ shown }}
                </option>
                <option v-for="([name, value], index) in options" :key="index" :value>
                    <OptionGlyphSlot v-if="glyphs" :glyph="optionGlyph!(value)" />{{ name }}
                </option>
            </select>
            <SelectValue :value="shown" class="group-active:text-fg-strong" />
            <span class="form-field-select-icon group-active:text-fg-strong" aria-hidden="true">
                <ChevronIcon direction="down" />
            </span>
        </div>
    </BaseField>
</template>
