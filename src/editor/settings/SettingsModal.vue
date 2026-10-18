<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, watch } from 'vue'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { resetKeybinds, resetSettings } from '../../settings'
import { closeSettingsKey } from './closeSettings'
import { requestedSection } from './openSettings'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections'
import SettingsAbout from './SettingsAbout.vue'
import SettingsEditor from './SettingsEditor.vue'
import SettingsKeyboardShortcuts from './SettingsKeyboardShortcuts.vue'
import SettingsLocalData from './SettingsLocalData.vue'
import SettingsMouse from './SettingsMouse.vue'
import SettingsPanels from './SettingsPanels.vue'
import SettingsPlay from './SettingsPlay.vue'
import SettingsPreview from './SettingsPreview.vue'
import SettingsTouch from './SettingsTouch.vue'
import SettingsToolbar from './toolbar/SettingsToolbar.vue'

const emit = defineEmits<{
    close: []
}>()
provide(closeSettingsKey, () => {
    emit('close')
})

// The section the index or openSettings(section) names: scrolled to, its heading focused.
const goTo = (id: SettingsSectionId, focus = true) => {
    const section = document.getElementById(`settings-${id}`)
    if (!section) return
    section.scrollIntoView({ block: 'start' })
    if (focus)
        section
            .querySelector<HTMLElement>('[data-settings-heading]')
            ?.focus({ preventScroll: true })
}

// The dialog moves focus to its first button as it opens; the section's heading follows it.
let timer: ReturnType<typeof setTimeout> | undefined
watch(
    requestedSection,
    (request) => {
        if (!request) return
        clearTimeout(timer)
        timer = setTimeout(() => {
            goTo(request.id)
        }, 0)
    },
    { immediate: true },
)
onMounted(() => {
    // A request made before the dialog existed has its section by now.
    if (requestedSection.value) goTo(requestedSection.value.id, false)
})
onBeforeUnmount(() => {
    clearTimeout(timer)
})

const pill =
    'h-8 shrink-0 rounded-full bg-button px-3 text-sm shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-4'
</script>

<template>
    <BaseModal :title="i18n.settings.title" fill @close="emit('close')">
        <!-- The section index: one row of pills, which stays in reach while the sections scroll. -->
        <nav
            :aria-label="i18n.settings.sections"
            class="flex shrink-0 gap-2 overflow-x-auto px-4 py-2"
            data-settings-index
        >
            <button
                v-for="id in SETTINGS_SECTIONS"
                :key="id"
                type="button"
                :class="pill"
                :data-settings-pill="id"
                @click="goTo(id)"
            >
                {{ i18n.settings[id].title }}
            </button>
        </nav>
        <div v-scroll-edges class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-2">
            <div class="flex flex-wrap gap-2">
                <button
                    type="button"
                    class="h-9 min-w-24 max-w-full truncate rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11"
                    :title="i18n.settings.resetSettingsHint"
                    @click="resetSettings"
                >
                    {{ i18n.settings.resetSettings }}
                </button>
                <button
                    type="button"
                    class="h-9 min-w-24 max-w-full truncate rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11"
                    @click="resetKeybinds"
                >
                    {{ i18n.settings.resetKeybinds }}
                </button>
            </div>
            <SettingsEditor />

            <SettingsLocalData />

            <SettingsPanels />

            <SettingsPreview />

            <SettingsToolbar />

            <SettingsPlay />

            <SettingsTouch />

            <SettingsMouse />

            <SettingsKeyboardShortcuts />

            <SettingsAbout />
        </div>
    </BaseModal>
</template>
