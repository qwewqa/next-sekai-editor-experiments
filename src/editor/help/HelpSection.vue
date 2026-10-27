<script setup lang="ts">
import { computed } from 'vue'
import { settings } from '../../settings'
import { commands, type CommandName } from '../commands'
import { formatShortcut, isPunctuationShortcut } from '../controls/bindings'
import { isCoarsePointer } from '../workspace'

const props = defineProps<{
    /** Defaults to the name of the command. */
    title?: string
    /** The toolbar command this section explains, shown by its icon and shortcut. */
    command?: CommandName
}>()

const text = computed(() => props.title ?? (props.command && commands[props.command].title()))

// A coarse pointer has no keyboard to press the shortcut on, as in the toolbar.
const shortcut = computed(() =>
    props.command && !isCoarsePointer.value
        ? formatShortcut(settings.keyboardShortcuts[props.command])
        : undefined,
)
</script>

<template>
    <section>
        <h2 class="flex items-center gap-2 font-bold">
            <!-- Flat, unlike the raised toolbar button, so it does not read as clickable.
            An icon column, so text glyphs fit and the titles line up. -->
            <span
                v-if="command"
                class="flex size-7 shrink-0 items-center justify-center rounded-full bg-button font-normal"
                aria-hidden="true"
                data-icon-column
            >
                <component
                    :is="commands[command].icon.is"
                    class="h-4 w-auto min-w-4 fill-current"
                    v-bind="commands[command].icon.props"
                />
            </span>
            {{ text }}
            <kbd
                v-if="shortcut"
                class="font-sans text-sm text-fg/80"
                :class="isPunctuationShortcut(shortcut) ? 'font-bold' : 'font-normal'"
                >{{ shortcut }}</kbd
            >
        </h2>

        <ul class="mt-2 list-outside list-disc pl-5">
            <slot />
        </ul>
    </section>
</template>
