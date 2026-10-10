<script setup lang="ts">
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { settings } from '../../../settings'
import LevelEditorToolbarTool from '../../toolbar/LevelEditorToolbarTool.vue'
import SettingsSection from '../SettingsSection.vue'
import SettingsSelectToolModal from './SettingsSelectToolModal.vue'
import SettingsToolbarAddButton from './SettingsToolbarAddButton.vue'

const onAddToGroup = async (index: number) => {
    const name = await showModal(SettingsSelectToolModal, {})
    if (!name) return

    settings.toolbar = settings.toolbar.map((names, i) => (i === index ? [name, ...names] : names))
}

const onRemoveFromGroup = (i: number, j: number) => {
    settings.toolbar = settings.toolbar.map((names, index) =>
        index === i ? names.filter((_, index) => index !== j) : names,
    )
}

const onAddGroup = async () => {
    const name = await showModal(SettingsSelectToolModal, {})
    if (!name) return

    settings.toolbar = [...settings.toolbar, [name]]
}
</script>

<template>
    <SettingsSection :title="i18n.settings.toolbar.title">
        <!-- Centred pseudo-elements fill each column and half the gaps around it; the faces stay unpositioned. -->
        <div class="flex flex-wrap items-end justify-center gap-1">
            <div v-for="(names, i) in settings.toolbar" :key="i" class="flex flex-col items-center">
                <SettingsToolbarAddButton @click="onAddToGroup(i)" />
                <LevelEditorToolbarTool
                    v-for="(name, j) in names"
                    :key="j"
                    class="justify-center before:absolute before:h-8 before:w-9 last:before:mt-0.5 last:before:h-[2.125rem] [@media(pointer:coarse)]:before:w-12"
                    :name
                    @click="onRemoveFromGroup(i, j)"
                />
            </div>
            <SettingsToolbarAddButton @click="onAddGroup" />
        </div>
    </SettingsSection>
</template>
