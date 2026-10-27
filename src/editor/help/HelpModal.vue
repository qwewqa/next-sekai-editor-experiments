<script setup lang="ts">
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import AboutLinks from '../settings/AboutLinks.vue'
import { isCoarsePointer } from '../workspace'
import HelpInputSections from './HelpInputSections.vue'
import HelpSection from './HelpSection.vue'

// A line that names the primary pointer says tap on a touchscreen and click otherwise.
const say = (tap: string, click: string) => (isCoarsePointer.value ? tap : click)
</script>

<template>
    <BaseModal :title="i18n.help.modal.title">
        <HelpSection :title="i18n.help.modal.gettingStarted.title">
            <li>{{ i18n.help.modal.gettingStarted.bgm }}</li>
            <li>
                {{
                    say(i18n.help.modal.gettingStarted.bpm, i18n.help.modal.gettingStarted.bpmClick)
                }}
            </li>
            <li>
                {{
                    say(
                        i18n.help.modal.gettingStarted.notes,
                        i18n.help.modal.gettingStarted.notesClick,
                    )
                }}
            </li>
            <li>{{ i18n.help.modal.gettingStarted.save }}</li>
        </HelpSection>

        <HelpInputSections :input="isCoarsePointer ? 'touch' : 'pointer'" />

        <HelpSection :title="i18n.help.fileTitle">
            <li>{{ i18n.help.moveBetweenDevices }}</li>
            <li>{{ i18n.help.recentSessions }}</li>
        </HelpSection>

        <HelpSection command="select">
            <li>
                {{ say(i18n.help.modal.selectTool.select, i18n.help.modal.selectTool.selectClick) }}
            </li>
            <li>{{ i18n.help.modal.selectTool.selectMultiple }}</li>
            <li>{{ i18n.help.modal.selectTool.move }}</li>
            <li>{{ i18n.help.modal.selectTool.resize }}</li>
            <li>{{ i18n.help.modal.selectTool.modifiers }}</li>
        </HelpSection>

        <HelpSection command="eraser">
            <li>
                {{ say(i18n.help.modal.eraserTool.erase, i18n.help.modal.eraserTool.eraseClick) }}
            </li>
            <li>
                {{
                    say(
                        i18n.help.modal.eraserTool.selection,
                        i18n.help.modal.eraserTool.selectionClick,
                    )
                }}
            </li>
        </HelpSection>

        <HelpSection command="brush">
            <li>{{ i18n.help.modal.brushTool.properties }}</li>
            <li>
                {{ say(i18n.help.modal.brushTool.brush, i18n.help.modal.brushTool.brushClick) }}
            </li>
            <li>{{ i18n.help.modal.brushTool.shift }}</li>
        </HelpSection>

        <HelpSection command="paste">
            <li>
                {{ say(i18n.help.modal.pasteTool.paste, i18n.help.modal.pasteTool.pasteClick) }}
            </li>
        </HelpSection>

        <HelpSection command="generateSlideNotes">
            <li>
                {{
                    say(
                        i18n.help.modal.generateSlideNotesTool.generate,
                        i18n.help.modal.generateSlideNotesTool.generateClick,
                    )
                }}
            </li>
            <li>
                {{
                    say(
                        i18n.help.modal.generateSlideNotesTool.generateMultiple,
                        i18n.help.modal.generateSlideNotesTool.generateMultipleClick,
                    )
                }}
            </li>
        </HelpSection>

        <HelpSection :title="i18n.help.modal.adding.title">
            <li>{{ say(i18n.help.modal.adding.add, i18n.help.modal.adding.addClick) }}</li>
            <li>{{ say(i18n.help.modal.adding.edit, i18n.help.modal.adding.editClick) }}</li>
            <li>{{ i18n.help.modal.adding.move }}</li>
            <li>{{ i18n.help.modal.adding.resize }}</li>
            <li>
                {{ say(i18n.help.modal.adding.modifiers, i18n.help.modal.adding.modifiersClick) }}
            </li>
        </HelpSection>

        <HelpSection command="note">
            <li>{{ i18n.help.modal.noteTool.presets }}</li>
            <li>
                {{
                    say(i18n.help.modal.noteTool.quickEdit, i18n.help.modal.noteTool.quickEditClick)
                }}
            </li>
        </HelpSection>

        <HelpSection command="slide">
            <li>
                {{ say(i18n.help.modal.slideTool.connect, i18n.help.modal.slideTool.connectClick) }}
            </li>
            <li>{{ i18n.help.modal.slideTool.presets }}</li>
            <li>
                {{
                    say(
                        i18n.help.modal.slideTool.quickEdit,
                        i18n.help.modal.slideTool.quickEditClick,
                    )
                }}
            </li>
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
            <li>
                {{ say(i18n.help.modal.event.quickEdit, i18n.help.modal.event.quickEditClick) }}
            </li>
        </HelpSection>

        <HelpSection command="offset">
            <li>{{ i18n.help.modal.offset.drag }}</li>
        </HelpSection>

        <HelpInputSections :input="isCoarsePointer ? 'pointer' : 'touch'" />

        <HelpSection :title="i18n.settings.about.title" plain>
            <AboutLinks />
        </HelpSection>
    </BaseModal>
</template>
