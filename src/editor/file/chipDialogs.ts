import { i18n } from '../../i18n'
import { formatWhen } from '../../i18n/when'
import { showChoice, type Choice } from '../../modals/choice'
import { PRODUCT_NAME } from '../../product'
import { interpolateRaw } from '../../utils/interpolate'
import { runCommand } from '../commands/runCommand'
import { save } from '../commands/save'
import { fileActions } from './actions'
import type { ChipKind } from './chip'
import { notStored, type NotStoredCause } from './notStored'
import { boundFile, chip, confirmFile } from './state'
import { tryStoringAgain } from './tryAgain'

// The chip's text and the dialog a tap opens (Part 1 §1.3.4): the first state's dialog, with the
// lower-priority states as extra lines.

/** The chip's string: the full one, or the phone's short label (< 768 px). */
export const chipText = (kind: ChipKind, short = false) => {
    const { state } = i18n.value
    switch (kind) {
        case 'fileMissing':
            return short ? state.short.fileMissing : state.fileMissing
        case 'changedOnDisk':
            return short ? state.short.changedOnDisk : state.changedOnDisk
        case 'newerOnDisk':
            return short ? state.short.newerOnDisk : state.newerOnDisk
        case 'notConfirmed':
            return short ? state.short.notConfirmed : state.notConfirmed
        case 'notStored':
            return short ? state.short.notStored : state.notStored
    }
}

/** A state as a sentence: the chip's accessible name and its line in a higher state's dialog. */
export const chipSentence = (kind: ChipKind) => {
    const file = boundFile.value
    const name = file?.name ?? ''
    const { state, save, confirm } = i18n.value
    switch (kind) {
        case 'fileMissing':
            return interpolateRaw(save.notFound, name)
        case 'changedOnDisk':
            return interpolateRaw(state.changedOnDiskName, name)
        case 'newerOnDisk':
            return interpolateRaw(state.newerOnDiskName, name)
        case 'notConfirmed':
            return file?.at === undefined
                ? interpolateRaw(confirm.bodyUndated, name)
                : interpolateRaw(confirm.body, name, formatWhen(file.at))
        case 'notStored':
            return i18n.value.notSaving.bar
    }
}

const lines = (first: string, rest: readonly ChipKind[], reason?: string) =>
    [first, ...(reason ? [reason] : []), ...rest.map(chipSentence)].join('\n')

/** Why changes are not stored, by cause; a browser without storage has nothing more to say. */
const reasonLine = (cause: NotStoredCause | undefined) => {
    const { storage, load } = i18n.value
    if (cause?.kind === 'readOnly') return load.olderVersion
    if (cause?.kind !== 'paused') return undefined
    switch (cause.reason) {
        case 'full':
            return storage.reason.full
        case 'failed':
            return storage.reason.failed
        case 'upgrading':
            return storage.reason.upgrading
        case 'olderTabs':
            return interpolateRaw(storage.reason.olderTabs, PRODUCT_NAME)
    }
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

/** The Not stored dialog (Part 1 §1.6.7): why, what to do about it, and Save as the way out. */
const openNotStored = async (rest: readonly ChipKind[]) => {
    const cause = notStored.value
    const choice = await showChoice<NotStoredChoice>({
        title: () => i18n.value.prompt.title,
        // The reason is read again, so a change while the dialog is open shows.
        message: () => lines(chipSentence('notStored'), rest, reasonLine(notStored.value ?? cause)),
        choices: [
            ...notStoredChoices(cause),
            { value: 'save', label: () => i18n.value.prompt.save, default: true },
        ],
    })
    switch (choice) {
        case 'save':
            await runCommand(save)
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
            location.reload()
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
        case 'notConfirmed': {
            const choice = await showChoice<'confirm' | 'again'>({
                title: () => i18n.value.confirm.title,
                message: () => lines(chipSentence(kind), rest),
                choices: [
                    { value: 'confirm', label: () => i18n.value.confirm.haveFile },
                    {
                        value: 'again',
                        label: () => i18n.value.confirm.downloadAgain,
                        default: true,
                    },
                ],
            })
            if (choice === 'confirm') confirmFile()
            else if (choice === 'again') fileActions.downloadAgain?.()
            return
        }
        case 'changedOnDisk':
        case 'newerOnDisk': {
            // Keep Editing is the safe default, in Cancel's place.
            const choice = await showChoice<'open'>({
                title: () => interpolateRaw(i18n.value.conflict.title, file.name),
                message: () => lines(interpolateRaw(i18n.value.conflict.body, file.name), rest),
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
