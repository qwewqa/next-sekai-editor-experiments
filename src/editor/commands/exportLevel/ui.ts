import { markExported } from '../../../history'
import { i18n } from '../../../i18n'
import { showChoice, type Choice } from '../../../modals/choice'
import type { FileError } from '../../../platform'
import { inlineName } from '../../../utils/inlineName'
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
    interpolate(() => i18n.value.save[fileErrorKey(error)], inlineName(error.fileName ?? name))()

/**
 * A failure's message, and "The file is now empty." below it when the write left the file empty.
 */
export const failureMessage = (message: () => string, emptied: boolean | undefined) =>
    emptied ? { lines: () => [message(), i18n.value.save.fileNowEmpty] } : { message }

/** Always Download: the setting becomes Disabled and the same action downloads. */
export const alwaysDownloadChoice = (offered: boolean | undefined): Choice<'alwaysDownload'>[] =>
    offered ? [{ value: 'alwaysDownload', label: () => i18n.value.save.alwaysDownload }] : []

const chooseAnother = {
    value: 'chooseAnother' as const,
    label: () => i18n.value.save.chooseAnother,
    default: true,
}

export const exportUi: ExportUi = {
    // Choose Another… is the safe default; Replace overwrites, keeping nothing.
    conflict: (name, disk, opened) =>
        showChoice({
            title: interpolate(() => i18n.value.conflict.exportTitle, inlineName(name)),
            message: () =>
                `${interpolate(
                    () =>
                        opened
                            ? i18n.value.conflict.exportBodyOpened
                            : i18n.value.conflict.exportBody,
                    inlineName(name),
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
            message: interpolate(() => i18n.value.export.notLevelData, inlineName(name)),
            choices: [chooseAnother],
        }),
    notFound: (name) =>
        showChoice({
            title,
            // No hint to pick the moved file: a save picker would empty it.
            message: interpolate(() => i18n.value.save.notFound, inlineName(name)),
            choices: [chooseAnother],
        }),
    denied: (name, download) =>
        showChoice<'chooseAnother' | 'tryAgain' | 'alwaysDownload'>({
            title,
            message: interpolate(() => i18n.value.save.denied, inlineName(name)),
            choices: [
                ...alwaysDownloadChoice(download),
                { ...chooseAnother, default: undefined },
                {
                    value: 'tryAgain' as const,
                    label: () => i18n.value.save.tryAgain,
                    default: true,
                },
            ],
        }),
    failed: (name, error, emptied, download) =>
        showChoice<'chooseAnother' | 'alwaysDownload'>({
            title,
            ...failureMessage(() => fileErrorText(name, error), emptied),
            choices: [...alwaysDownloadChoice(download), chooseAnother],
        }),
    exported: (name) => {
        notify(interpolate(() => i18n.value.export.exported, inlineName(name)))
    },
    // Called, not referenced: history imports this module's importers at load.
    markExported: (name, delivery) => {
        markExportUsed()
        markExported(name, delivery)
    },
    downloadReady: async ({ name, size }) => {
        // Loaded on use: the Save dialogs import this module.
        const { saveUi } = await import('../../save/dialogs')
        const dialog = saveUi.preparing(name, 'export')
        try {
            return await dialog.ready('download', size)
        } finally {
            dialog.close()
        }
    },
    downloadStarted: (name, size) => {
        notify(
            interpolate(
                () => i18n.value.save.downloadStarted,
                inlineName(name),
                () => formatSize(size),
            ),
        )
    },
}
