<script setup lang="ts">
// The title, the meta line and the optional summary line that open Step Details and Property
// Changes, so the two dialogs head their content the same way.
defineProps<{
    title: string
    titleLang?: string
    meta?: string
    summary?: string
    /** Names the data attributes: data-<scope>-description, -time and -summary. */
    scope: string
}>()
</script>

<template>
    <div class="flex min-w-0 flex-col gap-0.5">
        <p
            class="whitespace-pre-wrap font-bold"
            :lang="titleLang"
            v-bind="{ [`data-${scope}-description`]: '' }"
        >
            {{ title }}
        </p>
        <p
            v-if="meta"
            class="text-sm tabular-nums text-fg/80"
            v-bind="{ [`data-${scope}-time`]: '' }"
        >
            {{ meta }}
        </p>
        <p v-if="summary" class="whitespace-pre-wrap" v-bind="{ [`data-${scope}-summary`]: '' }">
            {{ summary }}
        </p>
    </div>
</template>
