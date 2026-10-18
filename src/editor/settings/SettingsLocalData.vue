<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { i18n } from '../../i18n'
import { formatDate } from '../../i18n/when'
import { storageStatus } from '../../local/startup/events'
import type { RecoveryItem } from '../../local/startup/api'
import { showChoice } from '../../modals/choice'
import { FileError, platform } from '../../platform'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { formatSize } from '../commands/exportLevel/format'
import { fileErrorText } from '../commands/exportLevel/ui'
import { showHistory } from '../history/state'
import { loadNotices, notify } from '../notification'
import { confirmSwitch, notifyLeft } from '../switch'
import { closeSettingsKey } from './closeSettings'
import SettingsSection from './SettingsSection.vue'
import { readBrowserFacts, storageLineKey } from './storageLine'

// Settings › Local Data (Part 1 §1.4.14): the storage line, and the Recovery rows for what the
// recovery order set aside, with this load's notices. The Storage subsection follows in later steps.

const strings = computed(() => i18n.value.settings.localData)
const closeSettings = inject(closeSettingsKey, () => undefined)

// --- The storage line (§1.4.13).
const facts = ref<Awaited<ReturnType<typeof readBrowserFacts>>>()
onMounted(async () => {
    facts.value = await readBrowserFacts()
})
const storageLine = computed(() => {
    const known = facts.value
    const status = storageStatus.value
    if (!known || !status) return
    return i18n.value.storage[
        storageLineKey({
            ...known,
            unavailable: status.mode === 'memory' || status.mode === 'readOnly',
        })
    ]
})

// --- Recovery rows. The storage-side modules load when a row is acted on.
const api = () => import('../../local/startup/api')
const items = ref<RecoveryItem[]>([])
const refresh = async () => {
    items.value = await (await api()).recoveryItems().catch(() => [])
}
onMounted(refresh)

const label = (item: RecoveryItem) => {
    const size = formatSize(item.size)
    const { recovery } = strings.value
    switch (item.kind) {
        case 'journal': {
            const text =
                item.writtenAt === undefined
                    ? interpolateRaw(recovery.journalUndated, size)
                    : interpolateRaw(recovery.journal, formatDate(item.writtenAt), size)
            return item.readable ? text : `${text} ${strings.value.cannotOpen}`
        }
        case 'autoSave': {
            const text = interpolateRaw(recovery.autoSave, size)
            return item.readable ? text : `${text} ${strings.value.cannotOpen}`
        }
        case 'legacy':
            return interpolateRaw(recovery.legacy, size)
        case 'recovered':
            return interpolateRaw(recovery.unreadable, formatDate(item.foundAt), size)
    }
}

const download = async (item: RecoveryItem) => {
    const file = await (await api()).recoveryFile(item)
    if (!file) return
    try {
        const result = await platform.saveFile({
            kind: 'recovery',
            suggestedName: file.name,
            build: () => Promise.resolve(file.blob),
        })
        if (result.status === 'download-started')
            notify(
                interpolate(
                    () => i18n.value.save.downloadStarted,
                    result.name,
                    formatSize(file.blob.size),
                ),
            )
    } catch (error) {
        if (!(error instanceof FileError)) throw error
        notify(() => fileErrorText(file.name, error))
    }
}

// Open replaces what this tab shows, so it asks first when that would lose work. The old auto
// save opens when this build reads it (§1.8 step 5); its key stays until discarded.
const open = async (item: RecoveryItem & { kind: 'journal' | 'autoSave' }) => {
    if (!(await confirmSwitch())) return
    const recovery = await api()
    if (
        item.kind === 'journal'
            ? !recovery.openRecoveryJournal(item)
            : !recovery.openRecoveryAutoSave(item)
    )
        return
    closeSettings()
    notifyLeft(() =>
        item.kind === 'journal' ? i18n.value.load.fallback : i18n.value.load.autoSaveOpened,
    )
}

// Downloading is the safe default, and removes nothing (§1.4.14).
const discard = async (item: RecoveryItem & { kind: 'autoSave' | 'recovered' }) => {
    const size = formatSize(item.size)
    const choice = await showChoice<'discard' | 'download'>({
        title: () => strings.value.discardConfirm,
        message:
            item.kind === 'autoSave'
                ? interpolate(() => strings.value.discardAutoSave, size)
                : interpolate(
                      () => strings.value.discardUnreadable,
                      formatDate(item.foundAt),
                      size,
                  ),
        choices: [
            { value: 'discard', label: () => strings.value.discardConfirm, danger: true },
            { value: 'download', label: () => i18n.value.save.download, default: true },
        ],
    })
    if (choice === 'download') await download(item)
    else if (choice === 'discard') {
        await (await api()).discardRecoveryItem(item)
        await refresh()
    }
}

const buttonClass =
    'inline-flex h-9 max-w-full items-center rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11'

// For people with customised toolbars: closes Settings first, so History is not behind it.
const openHistory = () => {
    closeSettings()
    showHistory()
}

const hasRecovery = computed(() => items.value.length > 0 || loadNotices.value.length > 0)
</script>

<template>
    <SettingsSection id="localData" :title="strings.title">
        <p v-if="storageLine" class="text-sm opacity-75" data-storage-line>{{ storageLine }}</p>

        <div>
            <button type="button" :class="buttonClass" data-open-history @click="openHistory">
                {{ strings.openHistory }}
            </button>
        </div>

        <div v-if="hasRecovery" class="flex flex-col gap-3" data-local-data-recovery>
            <h3 class="text-sm font-bold opacity-75">{{ strings.recoveryHeading }}</h3>

            <div
                v-for="item in items"
                :key="item.kind === 'recovered' ? item.id : item.key"
                class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
                :data-recovery-row="item.kind"
            >
                <span class="min-w-0 flex-1 basis-60">{{ label(item) }}</span>
                <span class="flex flex-wrap gap-2">
                    <button
                        v-if="
                            (item.kind === 'journal' || item.kind === 'autoSave') && item.readable
                        "
                        type="button"
                        :class="buttonClass"
                        data-recovery-open
                        @click="open(item)"
                    >
                        {{ i18n.commands.open.title }}
                    </button>
                    <button
                        type="button"
                        :class="buttonClass"
                        data-recovery-download
                        @click="download(item)"
                    >
                        {{ i18n.save.download }}
                    </button>
                    <button
                        v-if="item.kind === 'autoSave' || item.kind === 'recovered'"
                        type="button"
                        :class="buttonClass"
                        data-recovery-discard
                        @click="discard(item)"
                    >
                        {{ strings.discard }}
                    </button>
                </span>
            </div>

            <div v-if="loadNotices.length" class="flex flex-col gap-1" data-at-load>
                <div class="text-sm font-bold opacity-75">{{ strings.recovery.atLoad }}</div>
                <ul class="flex list-none flex-col gap-1 p-0">
                    <li v-for="(notice, i) in loadNotices" :key="i" class="pl-3">
                        {{ notice.message() }}
                    </li>
                </ul>
            </div>
        </div>
    </SettingsSection>
</template>
