<script setup lang="ts">
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { isCoarsePointer } from '../workspace'
import HelpInputSections from './HelpInputSections.vue'
import HelpSection from './HelpSection.vue'
</script>

<template>
    <BaseModal :title="i18n.help.modal.title">
        <HelpSection :title="i18n.help.modal.gettingStarted.title">
            <li>{{ i18n.help.modal.gettingStarted.bgm }}</li>
            <li>{{ i18n.help.modal.gettingStarted.bpm }}</li>
            <li>{{ i18n.help.modal.gettingStarted.notes }}</li>
            <li>{{ i18n.help.modal.gettingStarted.save }}</li>
        </HelpSection>

        <HelpInputSections :input="isCoarsePointer ? 'touch' : 'pointer'" />

        <HelpSection :title="i18n.help.fileTitle">
            <li>{{ i18n.help.moveBetweenDevices }}</li>
            <li>{{ i18n.help.recentSessions }}</li>
        </HelpSection>

        <HelpSection command="select">
            <li>{{ i18n.help.modal.selectTool.select }}</li>
            <li>{{ i18n.help.modal.selectTool.selectMultiple }}</li>
            <li>{{ i18n.help.modal.selectTool.move }}</li>
            <li>{{ i18n.help.modal.selectTool.resize }}</li>
            <li>{{ i18n.help.modal.selectTool.modifiers }}</li>
        </HelpSection>

        <HelpSection command="eraser">
            <li>{{ i18n.help.modal.eraserTool.erase }}</li>
            <li>{{ i18n.help.modal.eraserTool.selection }}</li>
        </HelpSection>

        <HelpSection command="brush">
            <li>{{ i18n.help.modal.brushTool.properties }}</li>
            <li>{{ i18n.help.modal.brushTool.brush }}</li>
            <li>{{ i18n.help.modal.brushTool.shift }}</li>
        </HelpSection>

        <HelpSection command="paste">
            <li>{{ i18n.help.modal.pasteTool.paste }}</li>
        </HelpSection>

        <HelpSection command="generateSlideNotes">
            <li>{{ i18n.help.modal.generateSlideNotesTool.generate }}</li>
            <li>{{ i18n.help.modal.generateSlideNotesTool.generateMultiple }}</li>
        </HelpSection>

        <HelpSection :title="i18n.help.modal.adding.title">
            <li>{{ i18n.help.modal.adding.add }}</li>
            <li>{{ i18n.help.modal.adding.edit }}</li>
            <li>{{ i18n.help.modal.adding.move }}</li>
            <li>{{ i18n.help.modal.adding.resize }}</li>
            <li>{{ i18n.help.modal.adding.modifiers }}</li>
        </HelpSection>

        <HelpSection command="note">
            <li>{{ i18n.help.modal.noteTool.presets }}</li>
            <li>{{ i18n.help.modal.noteTool.quickEdit }}</li>
        </HelpSection>

        <HelpSection command="slide">
            <li>{{ i18n.help.modal.slideTool.connect }}</li>
            <li>{{ i18n.help.modal.slideTool.presets }}</li>
            <li>{{ i18n.help.modal.slideTool.quickEdit }}</li>
            <li>{{ i18n.help.modal.slideTool.splitCombine }}</li>
        </HelpSection>

        <HelpSection command="bpm">
            <li>{{ i18n.help.modal.bpmTool.first }}</li>
            <li>{{ i18n.help.modal.bpmTool.replace }}</li>
        </HelpSection>

        <HelpSection command="timeScale">
            <li>{{ i18n.help.modal.timeScaleTool.markers }}</li>
            <li>{{ i18n.help.modal.timeScaleTool.ease }}</li>
        </HelpSection>

        <HelpSection command="event">
            <li>{{ i18n.help.modal.event.next }}</li>
            <li>{{ i18n.help.modal.event.defaults }}</li>
            <li>{{ i18n.help.modal.event.quickEdit }}</li>
        </HelpSection>

        <HelpSection command="offset">
            <li>{{ i18n.help.modal.offset.drag }}</li>
        </HelpSection>

        <HelpInputSections :input="isCoarsePointer ? 'pointer' : 'touch'" />
    </BaseModal>
</template>
