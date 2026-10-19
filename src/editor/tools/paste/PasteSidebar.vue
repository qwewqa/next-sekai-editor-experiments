<script setup lang="ts">
import { clipboardEntries, setClipboardEntry } from '../../../clipboard/index.ts'
import { i18n } from '../../../i18n'
import ToolSettings from '../../workspace/properties/ToolSettings.vue'

const onClick = (event: MouseEvent, entry: Parameters<typeof setClipboardEntry>[0]) => {
    setClipboardEntry(entry)
    // Pointer clicks return keyboard shortcuts (such as paste) to the editor.
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}
</script>

<template>
    <ToolSettings :title="i18n.tools.paste.sidebar.title">
        <template v-for="entry in clipboardEntries" :key="entry.name">
            <button
                v-if="entry.data"
                type="button"
                class="btn btn-secondary truncate rounded-full px-4 py-1"
                @click="onClick($event, entry)"
            >
                {{ entry.name }}
            </button>
        </template>
    </ToolSettings>
</template>
