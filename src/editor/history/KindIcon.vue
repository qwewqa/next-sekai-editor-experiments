<script setup lang="ts">
import ExportIcon from '../commands/exportLevel/ExportIcon.vue'
import HistoryIcon from '../commands/history/HistoryIcon.vue'
import RedoIcon from '../commands/redo/RedoIcon.vue'
import SaveIcon from '../commands/save/SaveIcon.vue'
import UndoIcon from '../commands/undo/UndoIcon.vue'

// The icon of an entry's kind (Part 1 §1.4.10.5), 16px, in the text colour.
defineProps<{ kind: string }>()
</script>

<template>
    <UndoIcon v-if="kind === 'undo'" class="size-4 shrink-0 fill-current" aria-hidden="true" />
    <RedoIcon v-else-if="kind === 'redo'" class="size-4 shrink-0 fill-current" aria-hidden="true" />
    <SaveIcon v-else-if="kind === 'save'" class="size-4 shrink-0 fill-current" aria-hidden="true" />
    <ExportIcon
        v-else-if="kind === 'export'"
        class="size-4 shrink-0 fill-current"
        aria-hidden="true"
    />
    <HistoryIcon
        v-else-if="kind === 'restore' || kind === 'recovered'"
        class="size-4 shrink-0 fill-current"
        aria-hidden="true"
    />
    <!-- A new session's first state: a ring around a dot. -->
    <svg
        v-else-if="kind === 'init'"
        class="size-4 shrink-0 fill-current"
        viewBox="0 0 512 512"
        aria-hidden="true"
    >
        <path
            d="M256 32a224 224 0 1 0 0 448 224 224 0 1 0 0-448zM80 256a176 176 0 1 1 352 0 176 176 0 1 1-352 0zm176-80a80 80 0 1 0 0 160 80 80 0 1 0 0-160z"
        />
    </svg>
    <!-- Anything else is an edit: a pencil. -->
    <svg v-else class="size-4 shrink-0 fill-current" viewBox="0 0 512 512" aria-hidden="true">
        <!--! Font Awesome Free 6.6.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2024 Fonticons, Inc. -->
        <path
            d="M362.7 19.3L314.3 67.7 444.3 197.7l48.4-48.4c25-25 25-65.5 0-90.5L453.3 19.3c-25-25-65.5-25-90.5 0zm-71 71L58.6 323.5c-10.4 10.4-18 23.3-22.2 37.4L1 481.2C-1.5 489.7 .8 498.8 7 505s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L421.7 220.3 291.7 90.3z"
        />
    </svg>
</template>
