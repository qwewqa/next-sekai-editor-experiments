import { i18n } from '../../../i18n'
import { showChoice } from '../../../modals/choice'
import type { FileError } from '../../../platform'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import { fileErrorKey } from './errorText'
import type { ExportUi } from './flow'
import { formatSize, formatTime } from './format'

// Export's follow-up dialogs and feedback (Part 1 §1.4.8, Part 0 §0.9.6).

const title = () => i18n.value.export.title

/** What the user reads for a failed file operation, naming the file that failed. */
export const fileErrorText = (name: string, error: FileError) =>
    interpolate(() => i18n.value.save[fileErrorKey(error)], error.fileName ?? name)()

/** A refused pick whose bytes could not be put back, emptied or not; Download keeps them. */
export const showNotPutBack = (dialogTitle: () => string, name: string, emptied: boolean) =>
    showChoice({
        title: dialogTitle,
        message: interpolate(
            () => (emptied ? i18n.value.save.notPutBack : i18n.value.save.openedContentGone),
            name,
        ),
        choices: [
            {
                value: 'download' as const,
                label: () => i18n.value.save.download,
                default: true,
            },
        ],
    })

const chooseAnother = {
    value: 'chooseAnother' as const,
    label: () => i18n.value.save.chooseAnother,
    default: true,
}

export const exportUi: ExportUi = {
    // Choose Another… is the safe default; Replace overwrites, keeping nothing.
    conflict: (name, disk, opened) =>
        showChoice({
            title: interpolate(() => i18n.value.conflict.exportTitle, name),
            message: () =>
                `${interpolate(
                    () =>
                        opened
                            ? i18n.value.conflict.exportBodyOpened
                            : i18n.value.conflict.exportBody,
                    name,
                )()}\n${formatSize(disk.size)} · ${formatTime(disk.lastModified)}`,
            choices: [
                {
                    value: 'replace' as const,
                    label: () => i18n.value.conflict.replace,
                    danger: true,
                },
                chooseAnother,
            ],
        }),
    notLevelData: (name) =>
        showChoice({
            title,
            message: interpolate(() => i18n.value.export.notLevelData, name),
            choices: [chooseAnother],
        }),
    unsupportedParts: (name) =>
        showChoice({
            title,
            message: interpolate(() => i18n.value.export.unsupportedParts, name),
            choices: [chooseAnother],
        }),
    notPutBack: (name, emptied) => showNotPutBack(title, name, emptied),
    notFound: (name) =>
        showChoice({
            title,
            message: () =>
                `${interpolate(() => i18n.value.save.notFound, name)()}\n${i18n.value.save.notFoundNote}`,
            choices: [chooseAnother],
        }),
    denied: (name) =>
        showChoice({
            title,
            message: interpolate(() => i18n.value.save.denied, name),
            choices: [
                { ...chooseAnother, default: undefined },
                {
                    value: 'tryAgain' as const,
                    label: () => i18n.value.save.tryAgain,
                    default: true,
                },
            ],
        }),
    failed: (name, error) =>
        showChoice({
            title,
            message: () => fileErrorText(name, error),
            choices: [chooseAnother],
        }),
    exported: (name) => {
        notify(interpolate(() => i18n.value.export.exported, name))
    },
    downloadStarted: (name, size) => {
        notify(
            interpolate(
                () => i18n.value.save.downloadStarted,
                name,
                () => formatSize(size),
            ),
        )
    },
}
