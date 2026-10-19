<script setup lang="ts">
defineProps<{
    /** On, off, or undefined for a mixed selection. */
    value: boolean | undefined
}>()
</script>

<template>
    <!-- The trailing glyph of an on/off field, where selects show their chevron:
    a small switch, mint with an ink knob when on, its knob centered for a mixed selection. The
    colours come from the switch recipes; the knob is white only when it is not on. High
    contrast draws its edge and knob in the button text colour. -->
    <span class="form-field-toggle-icon" aria-hidden="true">
        <span
            class="switch-track relative h-3.5 w-6 rounded-full outline outline-1 outline-transparent transition-colors forced-colors:outline-[color:ButtonText]"
            :data-on="value ? '' : undefined"
        >
            <span
                class="switch-knob absolute top-0.5 size-2.5 rounded-full transition-[left] forced-colors:bg-[ButtonText]"
                :class="[
                    value ? 'left-3' : value === undefined ? 'left-[0.4375rem]' : 'left-0.5',
                    value ? '' : 'bg-knob shadow-sm',
                ]"
            />
        </span>
    </span>
</template>
