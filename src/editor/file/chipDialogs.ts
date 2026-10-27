import { i18n } from '../../i18n'
import { showChoice, type Choice } from '../../modals/choice'
import { inlineName } from '../../utils/inlineName'
import { interpolateRaw } from '../../utils/interpolate'
import { runCommand } from '../commands/runCommand'
import { save } from '../commands/save'
import { confirmSwitch } from '../switch'
import { fileActions } from './actions'
import type { ChipKind } from './chip'
import { notStored, type NotStoredCause } from './notStored'
import { pausedReasonLine } from './notStoredReason'
import { boundFile, chip } from './state'
import { tryStoringAgain } from './tryAgain'

// The chip's text and the dialog a tap opens: the first state's dialog, with the
// lower-priority states as extra lines.

/** The chip's string. */
export const chipText = (kind: ChipKind) => {
    const { state } = i18n.value
    switch (kind) {
        case 'fileMissing':
            return state.fileMissing
        case 'changedOnDisk':
            return state.changedOnDisk
        case 'newerOnDisk':
            return state.newerOnDisk
        case 'notStored':
            return state.notStored
    }
}

/** A state as a sentence: the chip's accessible name and its line in a higher state's dialog. */
export const chipSentence = (kind: ChipKind) => {
    const file = boundFile.value
    const name = inlineName(file?.name ?? '')
    const { state, save } = i18n.value
    switch (kind) {
        case 'fileMissing':
            return interpolateRaw(save.notFound, name)
        case 'changedOnDisk':
            return interpolateRaw(state.changedOnDiskName, name)
        case 'newerOnDisk':
            return interpolateRaw(state.newerOnDiskName, name)
        case 'notStored':
            return i18n.value.notSaving.bar
    }
}

const lines = (first: string, rest: readonly ChipKind[], reason?: string) =>
    [first, ...(reason ? [reason] : []), ...rest.map(chipSentence)].join('\n')

/** Why changes are not stored, by cause; a browser without storage has nothing more to say. */
const reasonLine = (cause: NotStoredCause | undefined) => {
    if (cause?.kind === 'readOnly') return i18n.value.storage.reason.readOnly
    return cause?.kind === 'paused' ? pausedReasonLine(cause.reason) : undefined
}

type NotStoredChoice = 'localData' | 'retry' | 'reload' | 'save'

/** The buttons between Cancel and Save, by cause: a way to get storing going again. */
const notStoredChoices = (cause: NotStoredCause | undefined): Choice<NotStoredChoice>[] => {
    const reload = { value: 'reload', label: () => i18n.value.notStored.reload } as const
    const retry = { value: 'retry', label: () => i18n.value.load.tryAgain } as const
    const localData = { value: 'localData', label: () => i18n.value.load.localData } as const
    if (cause?.kind === 'readOnly') return [reload]
    if (cause?.kind !== 'paused') return []
    switch (cause.reason) {
        case 'full':
            return [localData, retry]
        case 'upgrading':
            return [reload]
        case 'failed':
        case 'olderTabs':
            return [retry]
    }
}

/** The Not stored dialog: why, what to do about it, and Save as the way out. */
const openNotStored = async (rest: readonly ChipKind[]) => {
    const cause = notStored.value
    const choice = await showChoice<NotStoredChoice>({
        title: () => i18n.value.prompt.title,
        // The reason is read again, so a change while the dialog is open shows.
        message: () => lines(chipSentence('notStored'), rest, reasonLine(notStored.value ?? cause)),
        choices: [
            ...notStoredChoices(cause),
            {
                value: 'save',
                label: () => i18n.value.prompt.save,
                default: true,
            },
        ],
    })
    switch (choice) {
        case 'save':
            await runCommand(save, 'button')
            return
        case 'localData':
            void import('../settings/openSettings').then(({ openSettings }) =>
                openSettings('localData'),
            )
            return
        case 'retry':
            await tryStoringAgain()
            return
        case 'reload':
            // iOS has no leave prompt, so unstored work is asked about here.
            if (await confirmSwitch()) location.reload()
            return
        case undefined:
            return
    }
}

/** Opens the dialog of the state in the chip slot. */
export const openChipDialog = async () => {
    const shown = chip.value
    if (!shown) return
    const { kind, rest } = shown
    // A session needs no bound file for it.
    if (kind === 'notStored') {
        await openNotStored(rest)
        return
    }
    const file = boundFile.value
    if (!file) return
    switch (kind) {
        case 'changedOnDisk':
        case 'newerOnDisk': {
            // Keep Editing is the safe default, in Cancel's place.
            const choice = await showChoice<'open'>({
                title: () => interpolateRaw(i18n.value.conflict.title, inlineName(file.name)),
                message: () =>
                    lines(interpolateRaw(i18n.value.conflict.body, inlineName(file.name)), rest),
                cancelIsDefault: true,
                cancelLabel: () => i18n.value.conflict.keepEditing,
                choices: [
                    {
                        value: 'open',
                        label: () => i18n.value.conflict.openOther,
                        description: () => i18n.value.conflict.openOtherNote,
                    },
                ],
            })
            if (choice === 'open') fileActions.openOtherVersion?.()
            return
        }
        case 'fileMissing': {
            const choice = await showChoice<'saveAs'>({
                title: () => i18n.value.commands.save.title,
                message: () => lines(chipSentence(kind), rest),
                choices: [
                    {
                        value: 'saveAs',
                        label: () => i18n.value.commands.saveAs.title,
                        default: true,
                    },
                ],
            })
            if (choice === 'saveAs') fileActions.saveAs?.()
            return
        }
    }
}
