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
    <section :id="id && `settings-${id}`" :data-settings-section="id" class="scroll-mt-2">
        <h2
            tabindex="-1"
            data-settings-heading
            class="focus-out mb-2 rounded font-bold outline outline-2 outline-transparent"
        >
            {{ title }}
        </h2>

        <div class="flex flex-col gap-3">
            <slot />
        </div>
    </section>
</template>
