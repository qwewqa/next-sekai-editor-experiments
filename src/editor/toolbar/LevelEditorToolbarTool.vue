<script setup lang="ts">
import { computed } from 'vue'
import { isPeeking } from '../../history/stack'
import { settings } from '../../settings'
import { formatShortcut, isPunctuationShortcut } from '../controls/bindings'
import { commands, type CommandName } from '../commands'
import { isCoarsePointer } from '../workspace'
import { pressedIconProps, type CommandState } from './pressed'

const props = withDefaults(
    defineProps<{
        name: CommandName
        showLabel?: boolean
        /** A tool, mode or value and whether it is in use; only the editor's toolbar shows it. */
        state?: CommandState
        /** Beside a label, a column checking the value in use. */
        checkColumn?: boolean
        /** In the editor's toolbar: drawn disabled while peeking refuses it. */
        gated?: boolean
    }>(),
    { state: undefined },
)

const pressed = computed(() => props.state?.current)
const refused = computed(() => {
    const command = commands[props.name]
    return props.gated && isPeeking.value && !command.readOnly && !command.leavesPeek
})
// Only a tool, mode or open panel takes the selected look; a value in use is checked.
const selected = computed(() => props.state?.kind !== 'value' && !!props.state?.current)
const checked = computed(() => props.state?.kind === 'value' && props.state.current)

const title = computed(() => commands[props.name].title())

// A pressed Custom member shows the value in use.
const iconProps = computed(
    () =>
        (pressed.value ? pressedIconProps(props.name) : undefined) ??
        commands[props.name].icon.props,
)

// Tools float over the dark canvas and also sit in the light Settings dialog; the recipes
// (controls.css) give the on look, the press, and the focus ring in the face's own ink. Labelled
// flyout items get a 44px target on touch, and drop the shortcut hints there, as the context
// menu does. High contrast leaves SVG fills alone, so monochrome icons take ButtonText.
const shortcut = computed(() =>
    isCoarsePointer.value ? undefined : formatShortcut(settings.keyboardShortcuts[props.name]),
)
</script>

<template>
    <button
        class="btn btn-secondary flex items-center rounded-full p-2"
        :class="[
            // Only a tool, mode or open panel takes the on look; a value in use keeps its check.
            { 'btn-toggle': state?.kind !== 'value' },
            // High contrast: icons take ButtonText, and the tool in use keeps its edge in the
            // selected text colour (it is unforced, so the transparent edge would stay clear).
            selected
                ? 'forced-colors:outline-[color:HighlightText]'
                : 'forced-colors:fill-[ButtonText]',
            { '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3': showLabel },
            // A refused tool dims only its content: the face, shadow and on-state stay opaque
            // over the chart.
            { '*:opacity-40': refused },
        ]"
        :title
        :aria-pressed="pressed"
        :aria-disabled="refused || undefined"
    >
        <span v-if="showLabel && checkColumn" class="mr-2 flex w-4 shrink-0 justify-center">
            <svg
                v-if="checked"
                class="size-4 fill-current"
                viewBox="0 0 448 512"
                aria-hidden="true"
                data-value-check
            >
                <!--! Font Awesome Free 6.6.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2024 Fonticons, Inc. -->
                <path
                    d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
                />
            </svg>
        </span>
        <!-- Beside a label, icons share a 20px column so names line up. -->
        <span v-if="showLabel" class="flex w-5 shrink-0 justify-center" data-icon-column>
            <component :is="commands[name].icon.is" class="h-4 w-auto min-w-4" v-bind="iconProps" />
        </span>
        <component :is="commands[name].icon.is" v-else class="size-4" v-bind="iconProps" />
        <template v-if="showLabel">
            <span class="ml-2 flex-grow text-left text-sm">{{ title }}</span>
            <span
                v-if="shortcut"
                aria-hidden="true"
                class="ml-4"
                :class="[
                    isPunctuationShortcut(shortcut)
                        ? 'text-sm font-bold leading-4'
                        : 'text-xs opacity-80',
                    { 'forced-colors:text-[HighlightText]': selected },
                ]"
                >{{ shortcut }}</span
            >
        </template>
    </button>
</template>
