<script setup lang="ts">
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections'

defineEmits<{
    go: [id: SettingsSectionId]
}>()

const pill = 'btn btn-secondary h-8 shrink-0 rounded-full px-3 text-sm'
</script>

<template>
    <!-- The section index: one swipeable row of pills on touch, which fades at the edge that has
    more; a mouse has no swipe, so the pills wrap and none is hidden. -->
    <nav
        v-scroll-edges:x
        :aria-label="i18n.settings.sections"
        class="flex shrink-0 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [@media(pointer:fine)]:flex-wrap [@media(pointer:fine)]:overflow-x-visible"
        data-settings-index
    >
        <button
            v-for="id in SETTINGS_SECTIONS"
            :key="id"
            type="button"
            :class="pill"
            :data-settings-pill="id"
            @click="$emit('go', id)"
        >
            {{ i18n.settings[id].title }}
        </button>
    </nav>
</template>
