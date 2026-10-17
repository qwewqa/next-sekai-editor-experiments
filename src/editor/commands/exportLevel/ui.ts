import { i18n } from '../../../i18n'
import { showChoice } from '../../../modals/choice'
import type { FileError } from '../../../platform'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import type { ExportUi } from './flow'
import { formatSize, formatTime } from './format'

// Export's follow-up dialogs and feedback (Part 1 §1.4.8, Part 0 §0.9.6).

const title = () => i18n.value.export.title

/** What the user reads for a failed file operation: never a browser's message (§1.4.19). */
export const fileErrorText = (name: string, error: FileError) => {
    const { save } = i18n.value
    switch (error.step) {
        case 'build':
            return interpolate(() => save.buildFailed, name)()
        case 'read':
            return interpolate(() => save.readFailed, name)()
        case 'readBack':
            return interpolate(() => save.changedWhileWriting, name)()
        case 'download':
            return interpolate(() => save.downloadFailed, name)()
        case undefined:
            break
    }
    switch (error.code) {
        case 'denied':
            return interpolate(() => save.denied, name)()
        case 'not-found':
            return interpolate(() => save.notFound, name)()
        case 'conflict':
            return interpolate(() => save.changedWhileWriting, name)()
        case 'not-local':
            return interpolate(() => save.notLocal, name)()
        case 'no-space':
            return interpolate(() => save.noSpace, name)()
        case 'io':
            return interpolate(() => save.writeFailed, name)()
    }
}

/** A refused pick whose bytes could not be put back; Download keeps them. */
export const showNotPutBack = (dialogTitle: () => string, name: string) =>
    showChoice({
        title: dialogTitle,
        message: interpolate(() => i18n.value.save.notPutBack, name),
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
    notPutBack: (name) => showNotPutBack(title, name),
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
