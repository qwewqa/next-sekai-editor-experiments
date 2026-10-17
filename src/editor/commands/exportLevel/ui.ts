import { i18n } from '../../../i18n'
import { showChoice } from '../../../modals/choice'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import type { ExportUi } from './flow'
import { formatSize, formatTime } from './format'

// Export's follow-up dialogs and feedback (Part 1 §1.4.8, Part 0 §0.9.6).

const title = () => i18n.value.export.title

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
    failed: (_name, reason) =>
        showChoice({
            title,
            message: () => reason,
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
