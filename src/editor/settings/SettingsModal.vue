<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { analyticsTarget } from '../../analytics/start'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { showChoice } from '../../modals/choice'
import { resetKeybinds, resetSettings } from '../../settings'
import { closeSettingsKey } from './closeSettings'
import { commands } from '../commands'
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

// --- Staged mount.
// Settings is one long scroll, most of it below the first screen, and mounting it all before the
// first frame took most of the opening time on a phone. So the dialog opens with Editor and Local
// Data, and the rest mounts in short tasks after the first frame, in order: stage 1 Panels and
// Preview, 2 Toolbar, 3 Play, Touch and Mouse, then Keyboard Shortcuts with SHORTCUT_BATCH rows
// per stage, and About last. The deferred sections are direct children of the scroller, because
// the gap and the scroll-edge fades require that. A jump to a section not mounted yet mounts the
// stages up to it. It scrolls once the new fields have fitted their labels, since a value that
// stacks below its label moves everything under it.
const SHORTCUT_BATCH = 20
const FIRST_SHORTCUT_STAGE = 4
const LAST_STAGE = FIRST_SHORTCUT_STAGE + Math.ceil(Object.keys(commands).length / SHORTCUT_BATCH)
const stageOf: Record<SettingsSectionId, number> = {
    editor: 0,
    localData: 0,
    panels: 1,
    preview: 1,
    toolbar: 2,
    play: 3,
    touch: 3,
    mouse: 3,
    keyboardShortcuts: FIRST_SHORTCUT_STAGE,
    about: LAST_STAGE,
}
// A section named before the dialog existed mounts with it.
const stage = ref(requestedSection.value ? stageOf[requestedSection.value.id] : 0)
const shortcutRows = computed(() => (stage.value - FIRST_SHORTCUT_STAGE + 1) * SHORTCUT_BATCH)

// Each stage runs in its own task after a frame: a requestAnimationFrame callback, then a timeout.
let stageFrame = 0
let stageTimer: ReturnType<typeof setTimeout> | undefined
const advance = () => {
    stageTimer = undefined
    if (stage.value >= LAST_STAGE) return
    stage.value++
    scheduleStage()
}
const scheduleStage = () => {
    stageFrame = requestAnimationFrame(() => {
        stageFrame = 0
        stageTimer = setTimeout(advance, 0)
    })
}

// The section the index or openSettings(section) names: scrolled to, its heading focused.
const land = (id: SettingsSectionId, focus: boolean) => {
    const section = document.getElementById(`settings-${id}`)
    if (!section) return
    section.scrollIntoView({ block: 'start' })
    if (focus)
        section
            .querySelector<HTMLElement>('[data-settings-heading]')
            ?.focus({ preventScroll: true })
}
let jumpFrame = 0
// True while fields that a jump mounted, or the dialog's first fields, have not yet fitted their
// labels.
let fitting = false
const jumpTo = (id: SettingsSectionId, focus = true, afterFit = false) => {
    const mounting = stage.value < stageOf[id]
    if (mounting) stage.value = stageOf[id]
    if (!mounting && !afterFit && !fitting) {
        land(id, focus)
        return
    }
    cancelAnimationFrame(jumpFrame)
    fitting = true
    // The fields just mounted fit their labels in microtasks; a frame later their heights are final.
    void nextTick(() => {
        jumpFrame = requestAnimationFrame(() => {
            jumpFrame = 0
            fitting = false
            land(id, focus)
        })
    })
}

// The dialog moves focus to its first button as it opens; the section's heading follows it.
let timer: ReturnType<typeof setTimeout> | undefined
watch(
    requestedSection,
    (request) => {
        if (!request) return
        clearTimeout(timer)
        timer = setTimeout(() => {
            jumpTo(request.id)
        }, 0)
    },
    { immediate: true },
)
onMounted(() => {
    scheduleStage()
    // A request made before the dialog existed has its section by now.
    if (requestedSection.value) jumpTo(requestedSection.value.id, false, true)
})
onBeforeUnmount(() => {
    clearTimeout(timer)
    clearTimeout(stageTimer)
    cancelAnimationFrame(stageFrame)
    cancelAnimationFrame(jumpFrame)
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
const askResetSettings = () =>
    confirmReset(
        () => i18n.value.settings.resetSettingsTitle,
        () =>
            analyticsTarget
                ? i18n.value.settings.resetSettingsMessageStatistics
                : i18n.value.settings.resetSettingsMessage,
        resetSettings,
    )
const askResetKeybinds = () =>
    confirmReset(
        () => i18n.value.settings.resetKeybindsTitle,
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
        <SettingsIndex v-if="!short" class="px-4 py-2" @go="jumpTo($event)" />
        <div
            v-scroll-edges
            class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-2 [scrollbar-gutter:stable]"
        >
            <SettingsIndex v-if="short" class="py-1" @go="jumpTo($event)" />
            <div class="flex flex-wrap gap-2">
                <button
                    type="button"
                    class="btn btn-danger-quiet h-9 min-w-24 max-w-full truncate rounded-full px-4"
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

            <SettingsPanels v-if="stage >= 1" />

            <SettingsPreview v-if="stage >= 1" />

            <SettingsToolbar v-if="stage >= 2" />

            <SettingsPlay v-if="stage >= 3" />

            <SettingsTouch v-if="stage >= 3" />

            <SettingsMouse v-if="stage >= 3" />

            <SettingsKeyboardShortcuts v-if="stage >= FIRST_SHORTCUT_STAGE" :rows="shortcutRows" />

            <SettingsAbout v-if="stage >= LAST_STAGE" />
        </div>
    </BaseModal>
</template>
