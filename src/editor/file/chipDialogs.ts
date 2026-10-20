import { i18n } from '../../i18n'
import { formatWhen } from '../../i18n/when'
import { showChoice } from '../../modals/choice'
import { interpolateRaw } from '../../utils/interpolate'
import { fileActions } from './actions'
import type { ChipKind } from './chip'
import { boundFile, chip, confirmFile } from './state'

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

const lines = (first: string, rest: readonly ChipKind[]) =>
    [first, ...rest.map(chipSentence)].join('\n')

/** Opens the dialog of the state in the chip slot. */
export const openChipDialog = async () => {
    const shown = chip.value
    if (!shown) return
    const { kind, rest } = shown
    // Step 8's dialog (§1.6.7), which lists the others by `chip.value.rest`; a session needs no
    // bound file for it.
    if (kind === 'notStored') {
        if (fileActions.openNotStored) fileActions.openNotStored()
        else
            await showChoice({
                title: () => i18n.value.prompt.title,
                message: () => lines(chipSentence(kind), rest),
                choices: [],
                cancelIsDefault: true,
                cancelLabel: () => i18n.value.modals.close,
            })
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
