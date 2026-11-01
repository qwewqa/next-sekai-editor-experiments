<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import SectionIndex from '../SectionIndex.vue'
import { landOn } from '../sectionLanding'
import AboutLinks from '../settings/AboutLinks.vue'
import { isCoarsePointer } from '../workspace'
import { helpSections, type HelpEntryDef, type HelpEntryId, type HelpSectionId } from './content'
import HelpEntry from './HelpEntry.vue'
import { requestedEntry } from './openHelp'

const emit = defineEmits<{
    close: []
}>()

// The current pointer's input entries come first and the other pointer's last.
const ordered = (entries: readonly HelpEntryDef[]) => {
    const current = isCoarsePointer.value ? 'touch' : 'pointer'
    return [
        ...entries.filter((entry) => entry.input === current),
        ...entries.filter((entry) => !entry.input),
        ...entries.filter((entry) => entry.input && entry.input !== current),
    ]
}

const sections = computed(() =>
    helpSections.map((section) => ({
        id: section.id,
        title: section.title(),
        entries: ordered(section.entries),
    })),
)

const index = computed(() => ({
    items: sections.value.map((section) => ({ id: section.id, label: section.title })),
    label: i18n.value.settings.sections,
    indexAttribute: 'data-help-index',
    pillAttribute: 'data-help-pill',
}))

// A pill scrolls its section to the top and focuses the section's heading.
const goToSection = (id: HelpSectionId) => {
    const section = document.getElementById(`help-${id}`)
    if (section) landOn(section, section.querySelector<HTMLElement>('[data-help-section-heading]'))
}

// An entry is scrolled to the top and its heading focused. The first entry of a section scrolls
// the section instead, so that the section's heading shows too.
const goToEntry = (id: HelpEntryId) => {
    const entry = document.getElementById(`help-entry-${id}`)
    if (!entry) return
    const section = entry.closest<HTMLElement>('section[data-help-section]')
    const first = section?.querySelector('[data-help-heading]')
    const heading = entry.querySelector<HTMLElement>('[data-help-heading]')
    landOn(first === heading && section ? section : entry, heading)
}

// The dialog moves focus to its first button as it opens; the entry's heading follows it.
let timer: ReturnType<typeof setTimeout> | undefined
watch(
    requestedEntry,
    (request) => {
        if (!request) return
        clearTimeout(timer)
        timer = setTimeout(() => {
            goToEntry(request.id)
        }, 0)
    },
    { immediate: true },
)
onBeforeUnmount(() => {
    clearTimeout(timer)
})

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
    <BaseModal :title="i18n.help.modal.title" fill @close="emit('close')">
        <SectionIndex v-if="!short" v-bind="index" class="px-4 py-2" @go="goToSection" />
        <div
            v-scroll-edges
            class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-2 [scrollbar-gutter:stable]"
        >
            <SectionIndex v-if="short" v-bind="index" class="py-1" @go="goToSection" />
            <section
                v-for="(section, i) in sections"
                :id="`help-${section.id}`"
                :key="section.id"
                data-help-section
                class="flex scroll-mt-2 flex-col gap-4"
                :class="i > 0 && 'border-t border-fg/15 pt-4'"
            >
                <h2
                    tabindex="-1"
                    data-help-section-heading
                    class="focus-out rounded text-lg font-bold outline outline-2 outline-transparent"
                >
                    {{ section.title }}
                </h2>
                <AboutLinks v-if="section.id === 'about'" />
                <HelpEntry v-for="entry in section.entries" :key="entry.id" :entry="entry" />
            </section>
        </div>
    </BaseModal>
</template>
