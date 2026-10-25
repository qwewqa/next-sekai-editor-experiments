<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { analyticsTarget } from '../../analytics/start'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { showChoice } from '../../modals/choice'
import { resetKeybinds, resetSettings } from '../../settings'
import { closeSettingsKey } from './closeSettings'
import { requestedSection } from './openSettings'
import type { SettingsSectionId } from './sections'
import SettingsAbout from './SettingsAbout.vue'
import SettingsEditor from './SettingsEditor.vue'
import SettingsIndex from './SettingsIndex.vue'
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

// A reset cannot be undone, so each asks first, with Cancel as the safe default.
const confirmReset = async (title: () => string, message: () => string, reset: () => void) => {
    const confirmed = await showChoice({
        title,
        message,
        choices: [{ value: true, label: title, danger: true }],
        cancelIsDefault: true,
    })
    if (confirmed) reset()
}
// Reset Settings keeps Send Usage Statistics, and says so where the build shows it.
const resetSettingsHint = computed(() =>
    analyticsTarget
        ? i18n.value.settings.resetSettingsHintStatistics
        : i18n.value.settings.resetSettingsHint,
)
const askResetSettings = () =>
    confirmReset(
        () => i18n.value.settings.resetSettings,
        () =>
            analyticsTarget
                ? i18n.value.settings.resetSettingsMessageStatistics
                : i18n.value.settings.resetSettingsMessage,
        resetSettings,
    )
const askResetKeybinds = () =>
    confirmReset(
        () => i18n.value.settings.resetKeybinds,
        () => i18n.value.settings.resetKeybindsMessage,
        resetKeybinds,
    )

// A short screen (a landscape phone) lets the index scroll away with the sections.
const shortQuery = matchMedia('(max-height: 500px)')
const short = ref(shortQuery.matches)
const onShort = () => {
    short.value = shortQuery.matches
}
onMounted(() => {
    shortQuery.addEventListener('change', onShort)
})
onBeforeUnmount(() => {
    shortQuery.removeEventListener('change', onShort)
})
</script>

<template>
    <BaseModal :title="i18n.settings.title" fill @close="emit('close')">
        <SettingsIndex v-if="!short" class="px-4 py-2" @go="goTo($event)" />
        <div
            v-scroll-edges
            class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-2"
        >
            <SettingsIndex v-if="short" class="py-1" @go="goTo($event)" />
            <div class="flex flex-wrap gap-2">
                <button
                    type="button"
                    class="btn btn-danger-quiet h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    :title="resetSettingsHint"
                    @click="askResetSettings"
                >
                    {{ i18n.settings.resetSettings }}
                </button>
                <button
                    type="button"
                    class="btn btn-danger-quiet h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    @click="askResetKeybinds"
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
