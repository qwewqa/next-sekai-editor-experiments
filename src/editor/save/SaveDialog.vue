<script setup lang="ts">
import { computed, ref } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { nameProblem } from '../commands/exportLevel/fileName'
import type { SaveDialogInput, SaveDialogResult } from './dialogs'

// The default Save dialog (Part 1 §1.4.7): File Name, History and BGM, Cancel and Save. The Save UI
// package replaces it, keeping the accessible names the specs use: the dialog's title, the "File
// Name" field, the "History" and "BGM" checkboxes and the "Save" button.
const props = defineProps<{ input: SaveDialogInput }>()

const emit = defineEmits<{ close: [result: SaveDialogResult] }>()

const name = ref(props.input.name)
const history = ref(props.input.history.kind === 'available' && props.input.history.ticked)
const bgm = ref(props.input.bgm.kind === 'held' && props.input.bgm.ticked)

const historyLocked = computed(
    () => props.input.history.kind !== 'available' || props.input.history.locked,
)
const bgmLocked = computed(() => props.input.bgm.kind !== 'held' || props.input.bgm.locked)
const problem = computed(() => nameProblem(name.value.replace(/\.nxsp$/i, '')))

const title = computed(() =>
    props.input.kind === 'saveAs' ? i18n.value.save.titleAs : i18n.value.save.title,
)

const submit = () => {
    if (problem.value) return
    const stem = name.value.replace(/\.nxsp$/i, '') || i18n.value.save.placeholder
    emit('close', {
        action: 'save',
        fileName: `${stem}.nxsp`.normalize('NFC'),
        history: history.value,
        bgm: bgm.value,
    })
}

const buttonClass =
    'h-9 min-w-24 rounded-full px-4 shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:h-11'
</script>

<template>
    <BaseModal :title="title" @close="emit('close', undefined)">
        <form novalidate class="flex flex-col gap-3" data-save-dialog @submit.prevent="submit">
            <p v-for="(line, i) in input.lines" :key="i" data-save-line>{{ line() }}</p>
            <label class="flex items-center gap-2">
                <span class="shrink-0">{{ i18n.save.fileName }}</span>
                <input
                    v-model="name"
                    class="w-full min-w-0 rounded-full bg-button px-4 py-1 shadow-md outline-none focus:ring-2 focus:ring-fg"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    data-autofocus
                    :placeholder="i18n.save.placeholder"
                />
                <span class="shrink-0" aria-hidden="true">.nxsp</span>
            </label>
            <label class="flex items-center gap-2">
                <input v-model="history" type="checkbox" :disabled="historyLocked" />
                {{ i18n.save.history }}
            </label>
            <label class="flex items-center gap-2">
                <input v-model="bgm" type="checkbox" :disabled="bgmLocked" />
                {{ i18n.save.bgm }}
            </label>
            <p v-if="input.exportLine" class="text-sm">
                <button
                    type="button"
                    class="underline"
                    @click="emit('close', { action: 'export' })"
                >
                    {{ i18n.save.exportHint }}
                </button>
            </p>
            <p v-if="input.peeking" class="text-sm opacity-75">{{ i18n.peek.savesCurrent }}</p>
            <div class="flex justify-end gap-2">
                <button
                    type="button"
                    class="bg-button active:bg-accent active:text-on-accent"
                    :class="buttonClass"
                    @click="emit('close', undefined)"
                >
                    {{ i18n.modals.confirm.cancel }}
                </button>
                <button
                    type="submit"
                    class="bg-accent text-on-accent active:bg-button active:text-fg"
                    :class="buttonClass"
                    :disabled="!!problem"
                >
                    {{ i18n.commands.save.title }}
                </button>
            </div>
        </form>
    </BaseModal>
</template>
