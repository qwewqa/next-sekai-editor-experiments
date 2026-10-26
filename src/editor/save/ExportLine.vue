<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import SeverityIcon from '../SeverityIcon.vue'

// The Save dialog's Export line: "Export Level Data…" in it is the link. A character touching it
// on either side stays on its line, so a Japanese 「 never ends a line before it. `emphasis` puts
// the info glyph beside it at the body's size; the plain line takes the notes block's size.
defineProps<{ emphasis?: boolean; id?: string }>()

const emit = defineEmits<{ export: [] }>()

const hint = computed(() => i18n.value.save.exportHint)
const link = computed(() => i18n.value.commands.exportLevel.title)
const hintParts = computed(() => {
    const at = hint.value.indexOf(link.value)
    if (at < 0) return undefined
    const before = hint.value.slice(0, at)
    const after = hint.value.slice(at + link.value.length)
    const lead = /\S$/u.exec(before)?.[0] ?? ''
    const trail = /^\S/u.exec(after)?.[0] ?? ''
    return {
        before: before.slice(0, before.length - lead.length),
        lead,
        link: link.value,
        trail,
        after: after.slice(trail.length),
    }
})
</script>

<template>
    <p :id="id" :class="{ 'relative pl-6': emphasis }" data-save-export>
        <SeverityIcon v-if="emphasis" severity="info" class="absolute left-0 top-1 size-4" />
        <template v-if="hintParts"
            >{{ hintParts.before
            }}<span class="whitespace-nowrap"
                >{{ hintParts.lead
                }}<button
                    type="button"
                    class="focus-out whitespace-normal rounded-sm underline outline outline-2 outline-transparent"
                    @click="emit('export')"
                >
                    {{ hintParts.link }}</button
                >{{ hintParts.trail }}</span
            >{{ hintParts.after }}</template
        >
        <button
            v-else
            type="button"
            class="focus-out rounded-sm text-left underline outline outline-2 outline-transparent"
            @click="emit('export')"
        >
            {{ hint }}
        </button>
    </p>
</template>
