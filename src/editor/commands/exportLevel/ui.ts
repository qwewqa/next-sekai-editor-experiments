import { markExported } from '../../../history'
import { i18n } from '../../../i18n'
import { showChoice } from '../../../modals/choice'
import type { FileError } from '../../../platform'
import { interpolate } from '../../../utils/interpolate'
import { markExportUsed } from '../../file/flags'
import { notify } from '../../notification'
import { fileErrorKey } from './errorText'
import type { ExportUi } from './flow'
import { formatSize, formatTime } from './format'

// Export's follow-up dialogs and feedback.

const title = () => i18n.value.export.title

/** What the user reads for a failed file operation, naming the file that failed. */
export const fileErrorText = (name: string, error: FileError) =>
    interpolate(() => i18n.value.save[fileErrorKey(error)], error.fileName ?? name)()

/**
 * What the pick could not put back, emptied or not: Download keeps the bytes. Without `downloadable`
 * there is nothing to give: [OK] only. `replaced`: Save to File… wrote another document over the
 * chain's own file. Export's dialog and the Save family's are this one, each with its own title.
 */
export const showNotPutBack = async (
    dialogTitle: () => string,
    name: string,
    emptied: boolean,
    downloadable: boolean,
    replaced = false,
) => {
    const message = interpolate(
        () =>
            replaced
                ? i18n.value.save.replacedContentGone
                : emptied
                  ? i18n.value.save.notPutBack
                  : i18n.value.save.openedContentGone,
        name,
    )
    if (!downloadable) {
        await showChoice({
            title: dialogTitle,
            message,
            choices: [],
            cancelIsDefault: true,
            cancelLabel: () => i18n.value.modals.info.ok,
        })
        return undefined
    }
    return showChoice({
        title: dialogTitle,
        message,
        choices: [
            {
                value: 'download' as const,
                label: () => i18n.value.save.download,
                default: true,
            },
        ],
    })
}

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
                )()}\n${formatSize(disk.size)}${
                    disk.lastModified === undefined ? '' : ` · ${formatTime(disk.lastModified)}`
                }`,
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
    notPutBack: (name, emptied, downloadable) => showNotPutBack(title, name, emptied, downloadable),
    notFound: (name) =>
        showChoice({
            title,
            // No hint to pick the moved file: a save picker would empty it.
            message: interpolate(() => i18n.value.save.notFound, name),
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
    // Called, not referenced: history imports this module's importers at load.
    markExported: (name, delivery) => {
        markExportUsed()
        markExported(name, delivery)
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
