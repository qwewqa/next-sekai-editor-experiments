<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import { linkParts } from '../../utils/linkParts'
import SeverityIcon from '../SeverityIcon.vue'

// The Save dialog's Export line: "Export Level Data…" in it is the link. A character touching it
// on either side stays on its line, so a Japanese 「 never ends a line before it. `emphasis` is the
// first-time form: the info glyph beside the longer text at the body's size, and the file names
// under it in smaller text. The plain line is one short sentence in the notes block's size.
const props = defineProps<{ emphasis?: boolean; id?: string }>()

const emit = defineEmits<{ export: [] }>()

const hint = computed(() =>
    props.emphasis ? i18n.value.save.exportHintFirst : i18n.value.save.exportHint,
)
const hintParts = computed(() => linkParts(hint.value, [i18n.value.commands.exportLevel.title]))
</script>

<template>
    <div
        :id="id"
        :class="emphasis ? 'relative flex flex-col gap-1 pl-6' : undefined"
        data-save-export
    >
        <SeverityIcon v-if="emphasis" severity="info" class="absolute left-0 top-1 size-4" />
        <p>
            <template v-if="hintParts"
                ><template v-for="(part, i) in hintParts" :key="i"
                    ><template v-if="'text' in part">{{ part.text }}</template
                    ><span v-else class="whitespace-nowrap"
                        >{{ part.lead
                        }}<button
                            type="button"
                            class="focus-out whitespace-normal rounded-sm underline outline outline-2 outline-transparent"
                            @click="emit('export')"
                        >
                            {{ part.name }}</button
                        >{{ part.trail }}</span
                    ></template
                ></template
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
        <p v-if="emphasis" class="text-sm text-fg/80" data-save-export-names>
            {{ i18n.save.exportHintNames }}
        </p>
    </div>
</template>
