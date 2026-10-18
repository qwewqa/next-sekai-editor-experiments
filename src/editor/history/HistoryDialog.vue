<script setup lang="ts">
import { inject, watch } from 'vue'
import { i18n } from '../../i18n'
import { modalTitleKey } from '../../modals/title'
import HistoryPanel from './HistoryPanel.vue'

// The History dialog (Part 1 §1.4.10.2): a sheet over the live chart, shown by the tool dialog
// host. The same band and lists as the tab, with its own close button; the dialog has no title row.

defineEmits<{ close: [] }>()

// The host names the dialog.
const modalTitle = inject(modalTitleKey, undefined)
if (modalTitle)
    watch(
        () => i18n.value.history.title,
        (title) => (modalTitle.value = title),
        { immediate: true },
    )
</script>

<template>
    <HistoryPanel surface="dialog" @close="$emit('close')" />
</template>
