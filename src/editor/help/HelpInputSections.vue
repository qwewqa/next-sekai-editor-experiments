<script setup lang="ts">
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { commands } from '../commands'
import HelpSection from './HelpSection.vue'

defineProps<{
    input: 'touch' | 'pointer'
}>()
</script>

<template>
    <HelpSection v-if="input === 'touch'" :title="i18n.help.modal.touchscreen.title">
        <li v-if="settings.touchLongPressContextMenu">
            {{ i18n.help.modal.touchscreen.longPress }}
        </li>
        <li>{{ i18n.help.modal.touchscreen.scroll }}</li>
        <li v-if="settings.touchQuickScrollWidth > 0">
            {{ i18n.help.modal.touchscreen.quickScroll }}
        </li>
        <li>{{ i18n.help.modal.touchscreen.gestures }}</li>
    </HelpSection>

    <template v-else>
        <HelpSection :title="i18n.help.modal.mouse.title">
            <li v-if="settings.mouseSecondaryTool === 'selectContextMenu'">
                {{ i18n.help.modal.mouse.contextMenu }}
            </li>
            <li v-else>
                {{
                    interpolateRaw(
                        i18n.help.modal.mouse.secondary,
                        commands[settings.mouseSecondaryTool].title(),
                    )
                }}
            </li>
            <li>{{ i18n.help.modal.mouse.scrollX }}</li>
            <li>{{ i18n.help.modal.mouse.zoom }}</li>
            <li>{{ i18n.help.modal.mouse.autoscroll }}</li>
        </HelpSection>

        <HelpSection :title="i18n.help.modal.keyboard.title">
            <li>{{ i18n.help.modal.keyboard.settings }}</li>
            <li>{{ i18n.help.altN }}</li>
            <li>{{ i18n.help.shiftF10 }}</li>
        </HelpSection>
    </template>
</template>
