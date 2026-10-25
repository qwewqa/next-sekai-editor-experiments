<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { vFocusRescue } from '../../directives/focusRescue'
import { i18n } from '../../i18n'
import { formatDate } from '../../i18n/when'
import { showModal } from '../../modals'
import { storageStatus } from '../../local/startup/events'
import type { RecoveryItem } from '../../local/startup/api'
import { showChoice } from '../../modals/choice'
import ToggleField from '../../modals/form/ToggleField.vue'
import LoadingModal from '../../modals/LoadingModal.vue'
import { FileError, platform } from '../../platform'
import { isSafeMode } from '../../safe'
import { settings } from '../../settings'
import { interpolate, interpolateRaw } from '../../utils/interpolate'
import { commands } from '../commands'
import { formatSize } from '../commands/exportLevel/format'
import { fileErrorText } from '../commands/exportLevel/ui'
import { runCommand } from '../commands/runCommand'
import { notStored } from '../file/notStored'
import { pausedReasonLine } from '../file/notStoredReason'
import { tryStoringAgain } from '../file/tryAgain'
import { showHistoryLink } from '../history/openHistory'
import { loadNotices, notify } from '../notification'
import SeverityIcon from '../SeverityIcon.vue'
import type { RawExportRun } from '../../startup/rawExportNote'
import { confirmSwitch, notifyLeft } from '../switch'
import { closeSettingsKey } from './closeSettings'
import { canDeleteSessions, deleteSessionsRunning } from './deleteSessionsFlow'
import SettingsSection from './SettingsSection.vue'
import { readBrowserFacts, storageLineKey, storageUnavailable } from './storageLine'

// Settings › Local Data: the storage line, the Storage subsection (what the
// browser holds, why changes are not being stored, Delete Sessions…), Recovery (Open History, the
// rows for what the recovery order set aside, Export Raw Data…) and Startup Notices, this load's
// notices. In safe mode it only reads: no Delete Sessions…, no Discard….

const strings = computed(() => i18n.value.settings.localData)
const closeSettings = inject(closeSettingsKey, () => undefined)
const safe = isSafeMode()

// --- The storage line.
const facts = ref<Awaited<ReturnType<typeof readBrowserFacts>>>()
onMounted(async () => {
    facts.value = await readBrowserFacts()
})
const storageLine = computed(() => {
    const known = facts.value
    const status = storageStatus.value
    if (!known || !status) return
    return i18n.value.storage[
        storageLineKey({ ...known, unavailable: storageUnavailable(status, safe) })
    ]
})

// --- Storage: the total the browser holds, the not-stored line, Delete Sessions….
const stored = ref<{ usage: number; quota: number }>()
// Without both figures no number shows: a guess would be worse than none.
const readTotal = async () => {
    try {
        const { usage, quota } = await navigator.storage.estimate()
        stored.value =
            usage !== undefined && quota !== undefined && Number.isFinite(usage) && quota > 0
                ? { usage, quota }
                : undefined
    } catch {
        stored.value = undefined
    }
}
onMounted(readTotal)
const storedText = computed(() => {
    const total = stored.value
    // In memory nothing is stored here, whatever the browser holds for the origin.
    if (!total || !storageStatus.value || storageStatus.value.mode === 'memory') return
    return interpolateRaw(strings.value.stored, formatSize(total.usage), formatSize(total.quota))
})

// Why changes are not stored, for the causes with a reason and something to do about it; an
// unavailable browser and a newer database already change the storage line above.
const notStoredLine = computed(() => {
    const cause = notStored.value
    if (cause?.kind !== 'paused') return
    return {
        text: pausedReasonLine(cause.reason),
        action: cause.reason === 'upgrading' ? ('reload' as const) : ('retry' as const),
    }
})
const retrying = ref(false)
const retryOrReload = async (action: 'retry' | 'reload') => {
    if (action === 'reload') {
        // iOS has no leave prompt, so unstored work is asked about here.
        if (await confirmSwitch()) location.reload()
        return
    }
    retrying.value = true
    try {
        await tryStoringAgain()
    } finally {
        retrying.value = false
    }
}

const hasStorage = computed(
    () =>
        storageLine.value !== undefined ||
        storedText.value !== undefined ||
        notStoredLine.value !== undefined ||
        canDeleteSessions.value,
)

// --- Recovery rows. The storage-side modules load when a row is acted on.
const api = () => import('../../local/startup/api')
const items = ref<RecoveryItem[]>([])
// A listing that fails is its own state, not "nothing to recover".
const unreadable = ref(false)
const refresh = async () => {
    try {
        const listing = await (await api()).recoveryItems()
        items.value = listing.items
        unreadable.value = listing.unreadable
    } catch {
        items.value = []
        unreadable.value = true
    }
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
        case 'recovered':
            return interpolateRaw(recovery.unreadable, formatDate(item.foundAt), size)
    }
}

const download = async (item: RecoveryItem) => {
    const read = await (await api()).recoveryFile(item)
    if (read.storedRead === 'failed') {
        // The row is still there: it can be tried again.
        notify(() => strings.value.recovery.downloadFailed, { card: true, severity: 'error' })
        return
    }
    const file = read.storedValue
    if (!file) {
        // A row gone since it was listed (taken by another tab): the list is read again.
        await refresh()
        return
    }
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
                { card: true },
            )
    } catch (error) {
        if (!(error instanceof FileError)) throw error
        notify(() => fileErrorText(file.name, error), { card: true, severity: 'error' })
    }
}

// Open replaces what this tab shows, so it asks first when that would lose work. The old auto
// save opens when this build reads it; its key stays until discarded.
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

// Downloading is the safe default, and removes nothing.
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

// The setting is the web's: not offered where downloads are never confirmed (iPhone and
// iPad never show the close prompt), and not in the apps, which close on their own terms.
const showsClosePrompt =
    platform.capabilities.browserStorage && !platform.capabilities.unconfirmedDownloads

// The raised-button geometry (design-language §4).
const buttonClass = 'btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4'

// For people with customised toolbars: closes Settings first, so History is not behind it.
const openHistory = () => {
    closeSettings()
    showHistoryLink()
}

// A row that goes with its own button (Discard) leaves focus on the next row, else on Open History.
const afterRowGone = () =>
    document.querySelector<HTMLElement>('[data-recovery-row] button') ??
    document.querySelector<HTMLElement>('[data-open-history]')

// --- Delete Sessions…: the command, as the History band and a bound key run it; the total is read again after.
const deleteSessions = async () => {
    await runCommand(commands.deleteSessions)
    await readTotal()
}

// --- Export Raw Data…: everything stored, as stored, for reporting a problem.
const exportRaw = async () => {
    const outcome: { run?: RawExportRun } = {}
    await showModal(LoadingModal, {
        title: () => strings.value.exportRawTitle,
        async *task(signal) {
            yield () => i18n.value.modals.loading.loading
            const action = await import('../../startup/rawExportAction')
            const run = (outcome.run = await action.runRawExportAction(signal))
            // The modal says what failed, and stays for the user to close.
            if (run.kind === 'failed')
                throw new Error(
                    run.error instanceof FileError
                        ? fileErrorText(run.name, run.error)
                        : interpolateRaw(i18n.value.save.downloadFailed, run.name),
                )
        },
    })
    const done = outcome.run
    if (done?.kind !== 'done') return
    // One notice: the warning when the stored work was left out, else the download's.
    if (done.databaseUnreadable)
        notify(() => strings.value.exportRawUnreadable, { card: true, severity: 'warning' })
    else if (done.started)
        notify(
            interpolate(() => i18n.value.save.downloadStarted, done.name, formatSize(done.size)),
            { card: true },
        )
}
</script>

<template>
    <SettingsSection id="localData" :title="strings.title">
        <ToggleField
            v-if="showsClosePrompt"
            v-model="settings.confirmCloseUnsavedFile"
            :label="strings.confirmClose"
            data-confirm-close
        />

        <div v-if="hasStorage" class="flex flex-col gap-3" data-local-data-storage>
            <h3 class="text-sm font-bold text-fg/80">{{ strings.storageHeading }}</h3>

            <p v-if="storageLine" class="text-sm text-fg/80" data-storage-line>{{ storageLine }}</p>

            <p v-if="storedText" data-stored-total>{{ storedText }}</p>

            <div
                v-if="notStoredLine"
                class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
                data-not-stored-line
            >
                <div class="flex min-w-0 flex-1 basis-60 items-start gap-2">
                    <SeverityIcon severity="warning" class="mt-1 size-4" />
                    <div class="flex min-w-0 flex-col">
                        <span>{{ i18n.notSaving.bar }}</span>
                        <span v-if="notStoredLine.text" data-not-stored-reason>{{
                            notStoredLine.text
                        }}</span>
                    </div>
                </div>
                <button
                    type="button"
                    :class="buttonClass"
                    :disabled="retrying"
                    data-not-stored-action
                    @click="retryOrReload(notStoredLine.action)"
                >
                    {{
                        notStoredLine.action === 'reload'
                            ? i18n.notStored.reload
                            : i18n.load.tryAgain
                    }}
                </button>
            </div>

            <div v-if="canDeleteSessions">
                <button
                    type="button"
                    :class="buttonClass"
                    :disabled="deleteSessionsRunning"
                    data-delete-sessions-open
                    @click="deleteSessions"
                >
                    {{ strings.deleteSessions }}
                </button>
            </div>
        </div>

        <div class="flex flex-col gap-3" data-local-data-recovery>
            <h3 class="text-sm font-bold text-fg/80">{{ strings.recoveryHeading }}</h3>

            <div>
                <button type="button" :class="buttonClass" data-open-history @click="openHistory">
                    {{ strings.openHistory }}
                </button>
            </div>

            <div
                v-for="item in items"
                :key="item.kind === 'recovered' ? item.id : item.key"
                v-focus-rescue="afterRowGone"
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
                        v-if="!safe && (item.kind === 'autoSave' || item.kind === 'recovered')"
                        type="button"
                        :class="buttonClass"
                        data-recovery-discard
                        @click="discard(item)"
                    >
                        {{ strings.discard }}
                    </button>
                </span>
            </div>

            <p v-if="unreadable" data-recovery-unreadable>{{ strings.recovery.listFailed }}</p>

            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button type="button" :class="buttonClass" data-export-raw @click="exportRaw">
                    {{ strings.exportRaw }}
                </button>
                <span class="text-sm text-fg/80">{{ strings.exportRawNote }}</span>
            </div>
        </div>

        <div v-if="loadNotices.length" class="flex flex-col gap-3" data-at-load>
            <h3 class="text-sm font-bold text-fg/80">{{ strings.startupNoticesHeading }}</h3>
            <ul class="flex list-disc flex-col gap-1 pl-5">
                <li v-for="(notice, i) in loadNotices" :key="i">
                    {{ notice.message() }}
                </li>
            </ul>
        </div>
    </SettingsSection>
</template>
