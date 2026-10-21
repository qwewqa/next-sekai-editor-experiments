import { reactive } from 'vue'
import { isPeeking } from '../../history'
import { getHistoryOperationContext } from '../../history/createHistoryOperation'
import { i18n } from '../../i18n'
import { formatDate } from '../../i18n/when'
import type { SaveSizeEstimate } from '../../local/save/estimate'
import type { MediaKind } from '../../local/save/media'
import { showModal } from '../../modals'
import { showChoice, type Choice } from '../../modals/choice'
import { PRODUCT_NAME } from '../../product'
import { interpolate } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'
import { formatSize, formatTime } from '../commands/exportLevel/format'
import { showNotPutBack } from '../commands/exportLevel/ui'
import { confirmFile, downloadNotConfirmed } from '../file'
import { savedOnText } from '../history/rowPresentation'
import { notify } from '../notification'
import PreparingDialog from './PreparingDialog.vue'
import SaveDialog from './SaveDialog.vue'

// The Save flows' dialogs and feedback (Part 1 §1.4.7), as the core calls them. These bodies are
// minimal working defaults; the Save UI package replaces them, keeping the signatures and the
// accessible names the specs use (work/step6/save-interface.md).

/** Which Save dialog: the first Save, Save As…, or Recent Sessions' Save to File…. */
export type SaveDialogKind = 'save' | 'saveAs' | 'saveToFile'

/** The History row. */
export type HistoryRow =
    /** Ticked or not; `locked` when the target file holds history (ticked, disabled). */
    | { kind: 'available'; ticked: boolean; locked: boolean; keptIn?: string }
    /** An insecure origin: "History cannot be included on this connection." */
    | { kind: 'insecure' }

/** The BGM row: disabled with no size for "No BGM" and "BGM not loaded". */
export type BgmRow =
    | { kind: 'none' }
    | { kind: 'notLoaded' }
    /** `keptIn` only when the target file's `bgm` is the head's ("Already in …"). */
    | { kind: 'held'; name: string; ticked: boolean; locked: boolean; keptIn?: string }

export type SaveDialogInput = {
    kind: SaveDialogKind
    /** The File Name field's first value, without `.nxsp`; empty shows the placeholder. */
    name: string
    /** Lines shown first, such as `file.replacedElsewhere` or `open.damagedHistory`. */
    lines: (() => string)[]
    history: HistoryRow
    bgm: BgmRow
    /** "For Sonolus level data, use Export Level Data… (Shift+P)." with its link. */
    exportLine: boolean
    /** Safari, iPhone and iPad, the first Save: the storage line's first sentence. */
    storageLine?: () => string
    /** "Saves the current version." */
    peeking: boolean
    /**
     * The size preview: a cached estimate shows at once; `load` refreshes it (never blocking). An
     * estimate still counting (an open's import running) is never shown: `load` resolves once it
     * has the count, and `signal` ends its wait when the dialog closes.
     */
    estimate: {
        cached?: SaveSizeEstimate
        load: (signal?: AbortSignal) => Promise<SaveSizeEstimate | undefined>
    }
}

export type SaveDialogResult =
    /** `fileName` ends in `.nxsp`, valid by Part 0 §0.9.9; an empty field gives `Untitled.nxsp`. */
    | { action: 'save'; fileName: string; history: boolean; bgm: boolean }
    /** The Export line's link: this dialog closes and Export's opens. */
    | { action: 'export' }
    | undefined

/** The small dialog a slow build shows (§1.4.7, §1.5.6), opened at once and kept to the end. */
export type Preparing = {
    /** Aborted by the dialog's Cancel, × or Escape: the Save stops (an accepted pick runs on). */
    readonly signal: AbortSignal
    /** The import's progress while the Save waits for it. */
    importing: (progress: { done: number; total: number }) => void
    /** The file's size: the estimate while it builds, the built size once known. */
    built: (size: number) => void
    /**
     * The build outlasted the press: the button becomes `[Download]` or `[Save]` (focused), whose
     * press is the gesture; true on it, false on Cancel.
     */
    ready: (action: 'download' | 'save', size: number) => Promise<boolean>
    close: () => void
}

/** What the default Preparing dialog shows. */
export type PreparingModel = {
    size: number
    importing?: { done: number; total: number }
    ready?: 'download' | 'save'
    closed: boolean
}

/** What the file on disk is, read from its `project.json` (Part 0 §0.9.6). */
export type DiskVersion =
    | {
          kind: 'saved'
          device: { id: string; label: string }
          savedAt: number
          /** Absent when the file has no summary for its revision. */
          notes?: number
      }
    /** A file of another project; `name` when its `project.json` has one. */
    | { kind: 'otherProject'; name?: string }
    /** Our project's file that went back: its revision is one of ours, from before our base. */
    | { kind: 'notDescendant'; savedAt: number }
    /** A file whose `project.json` doesn't read: only the title and body show. */
    | { kind: 'unknown' }

export type ConflictInput = {
    name: string
    disk: DiskVersion
    /** Replace disabled, with its reason line under it; Save as a Separate File stays focused. */
    replaceDisabled?: () => string
}

export type ConflictChoice = 'separate' | 'openOther' | 'replace'

/** A save picker's pick of a file the editor won't write over (R7), or a takeover in `?safe`. */
export type RefusedReason = 'notKept' | 'notProject' | 'levelData' | 'safeMode'

/** The feedback after a write (§1.4.7). */
export type SavedFeedback = {
    kind: 'saved' | 'download'
    name: string
    size: number
    /**
     * The second line when the write doesn't carry its base's `completeFrom` (§1.6.11.6): "were not
     * kept" for steps known missing, "may not be included" otherwise.
     */
    stepsLine: 'none' | 'notKept' | 'mayNotBeIncluded'
    /** A save picker took the file from another chain: "Its earlier work is in Recent Sessions." */
    tookOver: boolean
    /** Media written as metadata only, in BGM, cover, preview order. */
    without: MediaKind[]
    /** Those of `without` over the 1 GB cap: no "which is not loaded" (D25). */
    tooLarge: MediaKind[]
    /** Save to File… of a session open in another tab wrote its committed state. */
    committedState?: boolean
}

export type SaveUi = {
    saveDialog: (input: SaveDialogInput) => Promise<SaveDialogResult>
    /** `export`: Export's picker waiting for an open's import (SF3-1), titled and pressed as Export. */
    preparing: (name: string, kind?: 'save' | 'export') => Preparing
    conflict: (input: ConflictInput) => Promise<ConflictChoice | undefined>
    /** ""coconut.nxsp" cannot be found." `[Cancel]` `[Save As…]` (focused). */
    notFound: (name: string) => Promise<'saveAs' | undefined>
    /** The permission prompt refused: `[Cancel]` `[Save As…]` `[Try Again]` (focused). */
    denied: (name: string) => Promise<'saveAs' | 'tryAgain' | undefined>
    /** A read-only folder or file: `[Cancel]` `[Save As…]` (focused). */
    readOnly: (name: string) => Promise<'saveAs' | undefined>
    /** Other errors, with the plain reason; `saveAs` false where there is no other place. */
    failed: (name: string, message: () => string, saveAs: boolean) => Promise<'saveAs' | undefined>
    /** `[Cancel]` `[Export Level Data…]` (level data only) `[Choose Another…]` (focused). */
    refused: (
        name: string,
        reason: RefusedReason,
    ) => Promise<'chooseAnother' | 'export' | undefined>
    /**
     * Bytes held of a picked file that could not be put back; Download keeps them. Without
     * `downloadable` there is nothing to give: [OK] only. `replaced`: Save to File… wrote another
     * document over the chain's own file.
     */
    notPutBack: (
        name: string,
        emptied: boolean,
        downloadable: boolean,
        replaced?: boolean,
    ) => Promise<'download' | undefined>
    saved: (feedback: SavedFeedback) => void
    /** "No changes since … was saved/opened/downloaded", the last with Download Again. */
    noChanges: (
        name: string,
        event: 'saved' | 'opened' | 'downloaded',
        downloadAgain?: () => void,
    ) => void
    /** A Save that could not go on, with its reason. */
    error: (message: () => string) => void
}

const title = () => i18n.value.commands.save.title

const saveAsChoice = (focused: boolean): Choice<'saveAs'> => ({
    value: 'saveAs',
    label: () => i18n.value.commands.saveAs.title,
    ...(focused ? { default: true } : {}),
})

const describe = (disk: DiskVersion) => {
    const { conflict } = i18n.value
    switch (disk.kind) {
        case 'saved': {
            // The device is worded as the Timeline words it, once (Part 0 §0.9.3).
            const device = savedOnText(getHistoryOperationContext(), disk.device.label)
            if (disk.notes === undefined)
                return interpolate(() => conflict.savedNoNotes, device, formatTime(disk.savedAt))()
            const notes = interpolate(() => i18n.value.peek.notes, formatCount(disk.notes))()
            return interpolate(() => conflict.saved, device, formatTime(disk.savedAt), notes)()
        }
        case 'otherProject':
            return disk.name === undefined
                ? conflict.otherProjectUnnamed
                : interpolate(() => conflict.otherProject, disk.name)()
        case 'notDescendant':
            return interpolate(() => conflict.notDescendant, formatDate(disk.savedAt))()
        case 'unknown':
            return ''
    }
}

const withoutKey = (feedback: SavedFeedback) => {
    const { save } = i18n.value
    const [only, ...more] = feedback.without
    if (!only) return
    const large = feedback.without.every((kind) => feedback.tooLarge.includes(kind))
    if (more.length) return large ? save.savedWithoutMediaLarge : save.savedWithoutMedia
    if (large)
        return only === 'bgm'
            ? save.savedWithoutBgmLarge
            : only === 'cover'
              ? save.savedWithoutCoverLarge
              : save.savedWithoutPreviewLarge
    return only === 'bgm'
        ? save.savedWithoutBgm
        : only === 'cover'
          ? save.savedWithoutCover
          : save.savedWithoutPreview
}

/** A Save with nothing to add to "Saved to {0}". */
const simple = (feedback: SavedFeedback) =>
    feedback.stepsLine === 'none' && !feedback.tookOver && feedback.without.length === 0

/** The feedback's text: the first line, then the steps line (`stepsLine`) where it applies. */
export const savedText = (feedback: SavedFeedback) => {
    const { save } = i18n.value
    const line =
        feedback.stepsLine === 'notKept'
            ? save.someStepsNotKeptLine
            : save.someStepsMayNotBeIncludedLine
    const withLine = (first: string) =>
        feedback.stepsLine === 'none' ? first : `${first}\n${line}`
    if (feedback.kind === 'download') {
        const first = interpolate(
            () => save.downloadStarted,
            feedback.name,
            () => formatSize(feedback.size),
        )()
        return withLine(first)
    }
    const without = withoutKey(feedback)
    if (without) {
        const first = interpolate(() => without, feedback.name)()
        return withLine(first)
    }
    if (feedback.tookOver) {
        const first = interpolate(() => save.tookOver, feedback.name)()
        return withLine(first)
    }
    if (feedback.stepsLine !== 'none')
        return interpolate(
            () =>
                feedback.stepsLine === 'notKept'
                    ? save.someStepsNotKept
                    : save.someStepsMayNotBeIncluded,
            feedback.name,
        )()
    return interpolate(() => save.saved, feedback.name)()
}

/** The defaults: the editor's choice dialogs and notices. */
export const defaultSaveUi: SaveUi = {
    saveDialog: (input) =>
        showModal(SaveDialog, { input }).then((result) => result as SaveDialogResult),
    preparing: (name, kind = 'save') => {
        const controller = new AbortController()
        const model: PreparingModel = reactive({ size: 0, closed: false })
        let answer: ((go: boolean) => void) | undefined
        void showModal(PreparingDialog, { name, model, kind }).then((go) => {
            if (answer) answer(go === true)
            else if (!model.closed) controller.abort()
            answer = undefined
        })
        return {
            signal: controller.signal,
            importing: (progress) => {
                model.importing = progress
            },
            built: (size) => {
                model.size = size
            },
            // A dialog already cancelled or closed has no press to wait for.
            ready: (action, size) =>
                new Promise<boolean>((resolve) => {
                    if (controller.signal.aborted || model.closed) {
                        resolve(false)
                        return
                    }
                    answer = resolve
                    model.size = size
                    model.ready = action
                }),
            close: () => {
                model.closed = true
            },
        }
    },
    conflict: (input) =>
        showChoice<ConflictChoice>({
            title: interpolate(() => i18n.value.conflict.title, input.name),
            message: () =>
                [interpolate(() => i18n.value.conflict.body, input.name)(), describe(input.disk)]
                    .filter(Boolean)
                    .join('\n'),
            // Cancel, Replace (danger), Open the Other Version, then Save as a Separate File,
            // focused. A Replace that cannot be offered stays, with its reason under it.
            choices: [
                {
                    value: 'replace',
                    label: () => i18n.value.conflict.replace,
                    description: input.replaceDisabled ?? (() => i18n.value.conflict.replaceNote),
                    danger: true,
                    ...(input.replaceDisabled ? { disabled: true } : {}),
                },
                {
                    value: 'openOther',
                    label: () => i18n.value.conflict.openOther,
                    description: () => i18n.value.conflict.openOtherNote,
                },
                { value: 'separate', label: () => i18n.value.conflict.separate, default: true },
            ],
        }),
    notFound: (name) =>
        showChoice({
            title,
            message: interpolate(() => i18n.value.save.notFound, name),
            choices: [saveAsChoice(true)],
        }),
    denied: (name) =>
        showChoice<'saveAs' | 'tryAgain'>({
            title,
            message: interpolate(() => i18n.value.save.denied, name),
            choices: [
                saveAsChoice(false),
                { value: 'tryAgain', label: () => i18n.value.save.tryAgain, default: true },
            ],
        }),
    readOnly: (name) =>
        showChoice({
            title,
            message: interpolate(() => i18n.value.save.readOnly, name),
            choices: [saveAsChoice(true)],
        }),
    failed: async (_name, message, saveAs) => {
        if (saveAs) return showChoice({ title, message, choices: [saveAsChoice(true)] })
        await showChoice({
            title,
            message,
            choices: [],
            cancelIsDefault: true,
            cancelLabel: () => i18n.value.modals.info.ok,
        })
        return undefined
    },
    refused: (name, reason) => {
        const { save } = i18n.value
        const message =
            reason === 'notKept'
                ? interpolate(() => i18n.value.save.notKept, name)
                : reason === 'safeMode'
                  ? () => i18n.value.save.notKeptSafe
                  : reason === 'levelData'
                    ? () =>
                          `${interpolate(() => i18n.value.save.notProject, name)()}\n${save.exportHint}`
                    : interpolate(() => i18n.value.save.notProject, name)
        return showChoice<'chooseAnother' | 'export'>({
            title,
            message,
            choices: [
                ...(reason === 'levelData'
                    ? [{ value: 'export' as const, label: () => i18n.value.save.openExport }]
                    : []),
                {
                    value: 'chooseAnother',
                    label: () => i18n.value.save.chooseAnother,
                    default: true,
                },
            ],
        })
    },
    notPutBack: (name, emptied, downloadable, replaced = false) =>
        showNotPutBack(title, name, emptied, downloadable, replaced),
    saved: (feedback) => {
        // A download that leaves the session not confirmed carries the chip's action, so the
        // confirm is where the user is looking (§1.3.4); its announcement names the chip.
        const unconfirmed = feedback.kind === 'download' && downloadNotConfirmed.value
        const text =
            feedback.kind === 'saved' && isPeeking.value && simple(feedback)
                ? interpolate(() => i18n.value.notice.savedCurrent, feedback.name)
                : () => savedText(feedback)
        const announced = unconfirmed
            ? interpolate(
                  () => i18n.value.confirm.announce,
                  text,
                  () => i18n.value.state.notConfirmed,
              )
            : undefined
        // Save to File… of a session another tab has open wrote its stored state: said to
        // assistive technology with the notice (§1.6.11.6), not shown as another line.
        const announcement = feedback.committedState
            ? () => `${(announced ?? text)()} ${i18n.value.save.committedState}`
            : announced
        notify(text, {
            ...(unconfirmed
                ? { action: { label: () => i18n.value.confirm.haveFile, run: confirmFile } }
                : {}),
            ...(announcement ? { announcement } : {}),
        })
    },
    noChanges: (name, event, downloadAgain) => {
        const key =
            event === 'saved'
                ? () => i18n.value.save.noChangesSaved
                : event === 'opened'
                  ? () => i18n.value.save.noChangesOpened
                  : () => i18n.value.save.noChanges
        notify(
            interpolate(key, name),
            downloadAgain
                ? { action: { label: () => i18n.value.save.downloadAgain, run: downloadAgain } }
                : undefined,
        )
    },
    error: (message) => {
        notify(message, { card: true, severity: 'error' })
    },
}

/** The Save flows' UI: the defaults until the Save UI package's bodies replace them. */
export let saveUi: SaveUi = defaultSaveUi

/** Tests swap the UI; undefined restores the defaults. */
export const setSaveUiForTests = (ui: Partial<SaveUi> | undefined) => {
    saveUi = ui ? { ...defaultSaveUi, ...ui } : defaultSaveUi
}

/** "Made by a newer version of Next SEKAI Editor.", Replace's reason line over a newer file. */
export const replaceNewerLine = () =>
    interpolate(() => i18n.value.conflict.replaceNewer, PRODUCT_NAME)()
