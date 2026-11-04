<script setup lang="ts">
import { computed } from 'vue'
import { languageTag } from '../../i18n/plural'
import { settings } from '../../settings'
import { commands, type CommandName } from '../commands'
import { withoutEllipsis } from '../commands/withoutEllipsis'
import { formatShortcut, isPunctuationShortcut } from '../controls/bindings'
import { isCoarsePointer } from '../workspace'
import type { HelpEntryDef } from './content'

const props = defineProps<{
    entry: HelpEntryDef
}>()

const members = computed(() =>
    (props.entry.commands ?? []).map((name: CommandName) => ({
        name,
        title: withoutEllipsis(commands[name].title()),
        // A coarse pointer has no keyboard to press the shortcut on, as in the toolbar.
        shortcut: isCoarsePointer.value
            ? undefined
            : formatShortcut(settings.keyboardShortcuts[name]),
    })),
)

const lines = computed(() =>
    props.entry.lines
        .filter((line) => !line.shown || line.shown())
        .map((line) => ({
            text: 'text' in line ? line.text() : isCoarsePointer.value ? line.tap() : line.click(),
        })),
)

const visible = computed(
    () => (!props.entry.shown || props.entry.shown()) && lines.value.length > 0,
)

// A family heading would read as one run of names and keys, so it is named as a list.
const label = computed(() =>
    members.value.length > 1
        ? new Intl.ListFormat(languageTag(settings.locale), {
              type: 'conjunction',
              style: 'narrow',
          }).format(
              members.value.map((member) =>
                  member.shortcut ? `${member.title} ${member.shortcut}` : member.title,
              ),
          )
        : undefined,
)
</script>

<template>
    <section v-if="visible" :id="`help-entry-${entry.id}`" class="scroll-mt-2">
        <h3
            tabindex="-1"
            data-help-heading
            :aria-label="label"
            class="focus-out flex items-center rounded-sm font-bold"
            :class="members.length > 1 ? 'flex-wrap gap-x-4 gap-y-1' : 'gap-2'"
        >
            <span
                v-for="member in members"
                :key="member.name"
                class="flex items-center gap-2"
                :class="{ 'flex-1': members.length === 1 }"
            >
                <!-- Flat, unlike the raised toolbar button, so it does not read as clickable.
                An icon column, so text glyphs fit and the titles line up. -->
                <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-full bg-button font-normal"
                    aria-hidden="true"
                    data-icon-column
                >
                    <component
                        :is="commands[member.name].icon.is"
                        class="h-4 w-auto min-w-4 fill-current"
                        v-bind="commands[member.name].icon.props"
                    />
                </span>
                {{ member.title }}
                <!-- Right-aligned and styled as in the toolbar flyout and the context menu. -->
                <kbd
                    v-if="member.shortcut"
                    class="font-sans"
                    :class="[
                        members.length === 1 && 'ml-auto',
                        isPunctuationShortcut(member.shortcut)
                            ? 'text-sm leading-4 font-bold'
                            : 'text-xs font-normal opacity-80',
                    ]"
                    >{{ member.shortcut }}</kbd
                >
            </span>
            <template v-if="!members.length">{{ entry.title?.() }}</template>
        </h3>

        <ul class="mt-2 list-outside list-disc pl-5">
            <li v-for="(line, i) in lines" :key="i">{{ line.text }}</li>
        </ul>
    </section>
</template>
