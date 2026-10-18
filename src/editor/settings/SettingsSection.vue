<script setup lang="ts">
import { provide } from 'vue'
import { stackLongValuesKey } from '../../modals/form/fieldLayout'
import type { SettingsSectionId } from './sections'

defineProps<{
    title: string
    /** Names the section for the index and openSettings(section). */
    id?: SettingsSectionId
}>()

// Settings values such as languages are long; on narrow screens they go below their label.
provide(stackLongValuesKey, true)
</script>

<template>
    <section :id="id && `settings-${id}`" :data-settings-section="id" class="scroll-mt-16">
        <h2
            tabindex="-1"
            data-settings-heading
            class="mb-2 rounded font-bold outline-none focus-visible:ring-2 focus-visible:ring-fg"
        >
            {{ title }}
        </h2>

        <div class="flex flex-col gap-3">
            <slot />
        </div>
    </section>
</template>
