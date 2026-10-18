<script setup lang="ts">
import { onMounted, ref, useId } from 'vue'
import { i18n } from '../i18n'
import { readBrowserFacts } from './settings/storageLine'
import { openLevelInfoStub } from './levelInfo'
import { raised } from './file/state'
import { statusLabel, statusName } from './labelText'

defineProps<{ compact: boolean }>()

// The status bar's label (Part 1 §1.3.4): the displayed name, then the bound file or why there is
// none, and a "•" when the file has changes. It takes the warning colour while changes are not
// stored, and opens Level Info. On phones the reason is left out first, except where it is the
// lasting sign that stored work can be deleted: a suspected private window, Safari, iPhone and
// iPad.
const keepState = ref(false)
onMounted(async () => {
    const facts = await readBrowserFacts()
    keepState.value =
        facts.privateSuspected ||
        facts.os === 'ios' ||
        (facts.engine === 'webkit' && facts.os === 'macos')
})

const describedBy = useId()
const onClick = (event: MouseEvent) => {
    openLevelInfoStub()
    // Pointer clicks return keyboard shortcuts to the editor.
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}
</script>

<template>
    <button
        type="button"
        class="status-label relative flex max-w-[60%] shrink-[1000] items-center px-1"
        :class="[
            compact ? 'min-w-11' : 'min-w-[4.5rem]',
            { 'text-amber-300': raised.notStored.value },
        ]"
        :aria-label="statusName"
        :aria-describedby="describedBy"
        data-status-label
        @click="onClick"
    >
        <span class="flex min-w-0" aria-hidden="true" data-status-text>
            <span
                v-if="statusLabel.name"
                class="min-w-0 truncate"
                :class="statusLabel.file || keepState ? 'shrink-[1000]' : ''"
                data-status-name
                >{{ statusLabel.name }}</span
            >
            <span
                v-if="statusLabel.file"
                class="min-w-0 truncate"
                :class="statusLabel.name ? 'ml-1 opacity-70' : ''"
                data-status-file
            >
                {{ statusLabel.name ? ` · ${statusLabel.file}` : statusLabel.file }}
            </span>
            <span
                v-if="statusLabel.state"
                class="ml-1 min-w-0 truncate opacity-70"
                :class="[
                    keepState && !statusLabel.file ? '' : 'shrink-[10]',
                    compact && !(keepState && !statusLabel.file) ? 'hidden' : '',
                ]"
                data-status-state
                >{{ ` · ${statusLabel.state}` }}</span
            >
            <span v-if="statusLabel.changed" class="ml-1 shrink-0" data-status-changed>{{
                ' •'
            }}</span>
        </span>
        <span :id="describedBy" class="sr-only">{{ i18n.status.opensLevelInfo }}</span>
    </button>
</template>

<style scoped>
.status-label {
    border-radius: 9999px;
    transition: color 150ms;
}

.status-label:active {
    color: theme('colors.white');
}

.status-label:focus-visible {
    outline: 2px solid transparent;
    box-shadow: 0 0 0 2px theme('colors.accent');
}

@media (hover: hover) {
    .status-label:hover {
        color: theme('colors.white');
    }
}
</style>
