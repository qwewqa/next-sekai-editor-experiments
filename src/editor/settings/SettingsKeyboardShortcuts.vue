<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import KeyField from '../../modals/form/KeyField.vue'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { commands, isCommandName, type CommandName } from '../commands'
import { withoutEllipsis } from '../commands/withoutEllipsis'
import { normalizeBinding } from '../controls/bindings'
import SettingsSection from './SettingsSection.vue'

const props = defineProps<{
    /** How many rows to show; Settings mounts them in batches. All when unset. */
    rows?: number
}>()

// The rows in the commands' order.
const shown = computed(() => (Object.keys(commands) as CommandName[]).slice(0, props.rows))

const getKey = (name: CommandName) => settings.keyboardShortcuts[name]

// Unbinding saves '', so a later start can't mistake it for a new command.
const setKey = (name: CommandName, key: string | undefined) => {
    settings.keyboardShortcuts = { ...settings.keyboardShortcuts, [name]: key ?? '' }
}

// Commands sharing a binding all run; each row names the others.
const notes = computed(() => {
    const bound = Object.entries(settings.keyboardShortcuts).filter(
        (entry): entry is [CommandName, string] => isCommandName(entry[0]) && !!entry[1],
    )
    const users = new Map<string, CommandName[]>()
    for (const [name, key] of bound) {
        const binding = normalizeBinding(key)
        users.set(binding, [...(users.get(binding) ?? []), name])
    }
    const { key: messages, listJoin } = i18n.value.modals.form
    return new Map(
        bound.map(([name, key]) => {
            const others = (users.get(normalizeBinding(key)) ?? []).filter(
                (other) => other !== name,
            )
            const list: string[] = []
            if (others.length)
                list.push(
                    interpolateRaw(
                        messages.alsoRuns,
                        // Joined in the locale's punctuation, as "、" in Japanese.
                        others
                            .map((other) => withoutEllipsis(commands[other].title()))
                            .reduce((text, title) => interpolateRaw(listJoin, text, title)),
                    ),
                )
            return [name, list]
        }),
    )
})
</script>

<template>
    <SettingsSection id="keyboardShortcuts" :title="i18n.settings.keyboardShortcuts.title">
        <KeyField
            v-for="name in shown"
            :key="name"
            :label="commands[name].title()"
            :model-value="getKey(name)"
            :notes="notes.get(name)"
            @update:model-value="setKey(name, $event)"
        >
            <template #icon>
                <component
                    :is="commands[name].icon.is"
                    class="h-4 w-auto min-w-4 fill-current"
                    v-bind="commands[name].icon.props"
                />
            </template>
        </KeyField>
    </SettingsSection>
</template>
