<script setup lang="ts">
import { i18n } from '../../i18n'
import { showModal } from '../../modals'
import BaseModal from '../../modals/BaseModal.vue'
import CoverEditorModal from './coverEditor/CoverEditorModal.vue'
import PreviewEditorModal from './previewEditor/PreviewEditorModal.vue'

const utilities = {
    coverEditor: CoverEditorModal,
    previewEditor: PreviewEditorModal,
}
</script>

<template>
    <BaseModal :title="i18n.utilities.title">
        <div class="flex flex-col gap-2">
            <button
                v-for="(modal, name) in utilities"
                :key="name"
                class="btn btn-secondary h-9 max-w-full min-w-24 truncate rounded-full px-4"
                @click="showModal(modal, {})"
            >
                {{ i18n.utilities[name].title }}
            </button>
        </div>
    </BaseModal>
</template>
