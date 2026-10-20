import { AssertError } from 'typebox/value'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { openState } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { captureName } from '../../../history/operations'
import { createSessionDescriptor } from '../../../history/session'
import { i18n } from '../../../i18n'
import { formatDateInSentence } from '../../../i18n/when'
import { parseLevelData } from '../../../levelData/parse'
import { LevelDataReport } from '../../../levelData/report'
import { getLevelDataRevision, LATEST_REVISION } from '../../../levelData/revision'
import { summaryOf } from '../../../local/flush'
import {
    bindingName,
    bindingOptions,
    earlierNotice,
    levelState,
    matchesHead,
    mediaHash,
    partialLine,
    type EarlierNotice,
    type PartialLine,
} from '../../../local/open/decide'
import type { NxspReply } from '../../../local/open/project'
import { noteCountOf, stateFromRecords } from '../../../local/records/records'
import { stateBatch } from '../../../local/stateBatch'
import { showModal } from '../../../modals'
import { showChoice } from '../../../modals/choice'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { appVersion } from '../../../platform'
import { loadBgm } from '../../../player'
import { PRODUCT_NAME } from '../../../product'
import { settings } from '../../../settings'
import type { State } from '../../../state'
import { storageGet } from '../../../storage'
import { interpolate, interpolateRaw } from '../../../utils/interpolate'
import { createWaveform } from '../../../waveform'
import { confirmDownloads } from '../../file/flags'
import { dismissNoticeCard, notify } from '../../notification'
import { notifyLeft } from '../../switch'
import { withSwitchRequest, type SwitchRequest } from '../../switchRequest'
import { changeBgm } from '../bgm'

// Open File… on a `.nxsp` (Part 1 §1.5.4): read and checked in the storage worker, its level
// through the level-data path, the confirms first (a newer major version, values this build
// doesn't know), then a new session stored at once and shown, bound to the file unless the open
// is partial or the file is open in another tab, with the open's notice and its background import.

const title = () => i18n.value.commands.open.title

/** Refused before anything opens, with the message the loading dialog shows. */
class OpenRefused extends Error {}

const refuse = (message: string): never => {
    throw new OpenRefused(message)
}

/** Whether `project.json` says a newer build wrote it: a parser refusal then reads as that. */
const newerFile = (read: NxspReply) =>
    read.report.some(({ reason }) =>
        ['newer-version', 'newer-minor', 'newer-level'].includes(reason),
    )

/**
 * Whether a newer `patch` was seen: it leaves the open whole (Replace may keep such a file), but a
 * level that then fails to parse is still a newer file's.
 */
const newerPatch = (read: NxspReply) => read.report.some(({ reason }) => reason === 'newer-patch')

/** The level, parsed through the level-data path with its report (§1.5.4 step 2). */
const parseLevel = (read: NxspReply) => {
    const report = new LevelDataReport()
    try {
        const levelData = parseLevelData(read.level)
        const chart = parseLevelDataChart(
            levelData.entities,
            read.project?.editor.defaultGuideColors,
            undefined,
            report,
        )
        validateChart(chart)
        return { levelData, chart, report }
    } catch (error) {
        const newer =
            newerFile(read) ||
            newerPatch(read) ||
            (error instanceof ImportRefusal &&
                getLevelDataRevision(
                    (read.level as { entities?: [] } | undefined)?.entities ?? [],
                ) > LATEST_REVISION)
        // A refusal in a newer file is the newer-version refusal, never the parser's text.
        if (newer) return refuse(interpolateRaw(i18n.value.open.newerRefused, PRODUCT_NAME))
        if (error instanceof ImportRefusal)
            return refuse(
                interpolateRaw(
                    i18n.value.commands.open.invalidLevel,
                    interpolateRaw(
                        i18n.value.commands.open.refusals[error.reason],
                        ...error.params,
                    ),
                ),
            )
        if (error instanceof AssertError) return refuse(i18n.value.open.damagedUnopened)
        throw error
    }
}

const partialMessage = (line: PartialLine) => {
    const { open } = i18n.value
    switch (line.kind) {
        case 'damaged':
            return open.damaged
        case 'historyUnreadable':
            return open.historyUnreadable
        case 'newerVersion':
            return interpolateRaw(open.newerVersion, PRODUCT_NAME)
        case 'newerPatch':
            return interpolateRaw(open.newerPatch, PRODUCT_NAME)
        case 'mediaBad':
            return interpolateRaw(open.mediaBad, open.media[line.media])
    }
}

/** The browser this one is, as revisions record it (§1.3.3): `deviceId` in localStorage. */
const thisDevice = () => {
    const id = storageGet('deviceId', undefined)
    return typeof id === 'string' ? id : undefined
}

const restoreAction = (sessionId: string) => ({
    label: () => i18n.value.open.restoreIt,
    run: () => {
        void withSwitchRequest(undefined, async (request) => {
            const { confirmSwitch } = await import('../../switch')
            if (!(await confirmSwitch()) || !request.isCurrent()) return
            const { restoreSession } = await import('../../../local/startup/api')
            if (!request.isCurrent()) return
            if ((await restoreSession(sessionId, request)) && request.isCurrent())
                dismissNoticeCard()
        })
    },
})

const earlierMessage = (notice: EarlierNotice, name: string) => {
    const when = formatDateInSentence(notice.chain.updatedAt)
    const { open } = i18n.value
    switch (notice.kind) {
        case 'unsavedChanges':
            return () => interpolateRaw(open.unsavedChanges, name, when)
        case 'unsavedEarlier':
            return () => interpolateRaw(open.unsavedEarlier, name, when)
        case 'olderVersion':
            return () => interpolateRaw(open.olderVersion, name, when)
    }
}

/** Shows the open's notice: an earlier session's, or "Opened coconut.nxsp" with Reopen. */
const notifyOpened = (
    name: string,
    notice: EarlierNotice | undefined,
    leftSessionId: string | undefined,
) => {
    // The chain with unsaved changes is the session just left: only Reopen shows (§1.4.1).
    if (!notice || (notice.kind === 'unsavedChanges' && notice.chain.sessionId === leftSessionId)) {
        notifyLeft(interpolate(() => i18n.value.history.openedFile, name))
        return
    }
    dismissNoticeCard()
    const message = earlierMessage(notice, name)
    if (notice.kind === 'unsavedEarlier') notify(message, { card: true, severity: 'info' })
    else notify(message, { action: restoreAction(notice.chain.sessionId), severity: 'info' })
}

/** Decodes the BGM read from the file, as Choose Audio… does, without its dialog. */
const decodeBgm = async (data: ArrayBuffer) => {
    const buffer = await loadBgm(data)
    const waveform = await createWaveform(buffer, settings.waveform)
    return { buffer, ...(waveform ? { waveform } : {}) }
}

/**
 * Opens a picked `.nxsp`; resolves once its session shows (or nothing opened). Throws `Error`s
 * whose message the loading dialog shows.
 */
export const openProject = (
    file: File,
    handle: FileSystemFileHandle | undefined,
    supplied?: SwitchRequest,
) => withSwitchRequest(supplied, (request) => openRequestedProject(file, handle, request))

const openRequestedProject = async (
    file: File,
    handle: FileSystemFileHandle | undefined,
    request: SwitchRequest,
) => {
    const project = await import('../../../local/open/project')
    const { previousSession } = await import('../../../local/startup/events')
    if (!request.isCurrent()) return

    // Read and checked in the worker, the level parsed here (§1.5.4 steps 2–3).
    let read: NxspReply | undefined
    let parsed: ReturnType<typeof parseLevel> | undefined
    let refusal: string | undefined
    await showModal(LoadingModal, {
        title,
        async *task(signal: AbortSignal) {
            const stopAbort = request.observeAbort(signal)
            try {
                yield () => i18n.value.commands.open.loading
                const result = await project.readProjectFile(file)
                if (!request.isCurrent()) {
                    if (result.kind === 'nxsp') project.dropProjectRead(result.id)
                    return
                }
                if (result.kind === 'not-project') throw new Error(i18n.value.open.notProject)
                if (result.kind === 'unreadable') throw new Error(i18n.value.open.damagedUnopened)
                read = result
                // A newer major version asks first; its level is parsed after.
                if (result.report.some(({ reason }) => reason === 'newer-version')) return
                yield () => i18n.value.commands.open.importing
                try {
                    parsed = parseLevel(result)
                } catch (error) {
                    if (!(error instanceof OpenRefused)) throw error
                    refusal = error.message
                }
            } catch (error) {
                if (request.isCurrent()) throw error
            } finally {
                stopAbort()
            }
        },
    })
    if (!read) return
    if (!request.isCurrent()) {
        project.dropProjectRead(read.id)
        return
    }
    const opened = read
    const cancel = () => {
        project.dropProjectRead(opened.id)
    }
    if (refusal !== undefined) {
        cancel()
        await showModal(LoadingModal, {
            title,
            // eslint-disable-next-line require-yield
            *task() {
                throw new Error(refusal)
            },
        })
        return
    }

    // A newer major version: only the level can be opened (§1.5.4).
    if (opened.report.some(({ reason }) => reason === 'newer-version')) {
        const choice = await showChoice({
            title: interpolate(() => i18n.value.open.newerMajor, PRODUCT_NAME),
            message: () => i18n.value.open.newerMajorNote,
            choices: [{ value: true, label: () => i18n.value.open.openLevel, default: true }],
        })
        if (!choice || !request.isCurrent()) {
            cancel()
            return
        }
        try {
            parsed = parseLevel(opened)
        } catch (error) {
            cancel()
            if (!(error instanceof OpenRefused)) throw error
            notify(() => error.message, { card: true, severity: 'error' })
            return
        }
    }
    if (!parsed) {
        cancel()
        return
    }
    const { levelData, chart, report } = parsed

    // Values this build doesn't know: nothing opens before the user confirms (round 11, G1).
    if (report.hasUnknownValue) {
        const choice = await showChoice({
            title: interpolate(() => i18n.value.open.newerValues.title, file.name),
            message: () => i18n.value.open.newerValues.body,
            choices: [
                { value: true, label: () => i18n.value.open.newerValues.openCopy, default: true },
            ],
        })
        if (!choice || !request.isCurrent()) {
            cancel()
            return
        }
    }

    const line = partialLine(opened.report, report)
    const whole = opened.open === 'full' && report.isEmpty && !!opened.project
    const history = opened.history
    const head: State | undefined = history ? stateFromRecords(history.headRecords) : undefined
    // The history's head is the live state when the file matches it (§1.6.11.6), so the chart
    // keeps its ids; otherwise level.json and project.json win, with "Changed outside the editor".
    const headLive =
        head &&
        opened.project &&
        report.isEmpty &&
        matchesHead(levelData.entities, levelData.bgmOffset, opened.project, head)
            ? head
            : undefined
    const asHead = !!headLive
    const live = headLive ?? levelState(chart, levelData.bgmOffset, opened.project, head)

    // The same file bound in another tab's open session opens as a separate copy (§1.3.2).
    const elsewhere = whole && !!handle && (await project.boundInAnotherTab(handle))
    if (!request.isCurrent()) {
        cancel()
        return
    }
    const identity = whole && !elsewhere
    const name = bindingName(file.name, opened.project?.revision?.fileName, !!handle)
    const copyOf = identity ? undefined : { name, bound: true as const }

    // Earlier sessions on this file, recognised by revision (§1.5.4 step 4).
    const revision = identity ? opened.project?.revision : undefined

    // Nothing can be stored (safe mode, a newer database): the level opens, as an import does.
    const { storageStatus } = await import('../../../local/startup/events')
    if (storageStatus.value?.mode === 'readOnly') {
        cancel()
        const descriptor = createSessionDescriptor({ sourceName: file.name })
        if (
            request.publish({ state: live, sessionId: descriptor.sessionId, reset: true }, () => {
                // A level opened in safe mode is an import, not a recovery; nothing is stored.
                openState(live, descriptor, { origin: 'import', source: captureName(name) })
            })
        )
            notifyLeft(interpolate(() => i18n.value.history.openedFile, name))
        return
    }

    if (!request.isCurrent()) {
        cancel()
        return
    }
    let stored: Awaited<ReturnType<typeof project.storeAndShow>> | undefined
    let committing: Promise<Awaited<ReturnType<typeof project.storeAndShow>>> | undefined
    await showModal(LoadingModal, {
        title,
        async *task(signal: AbortSignal) {
            const stopAbort = request.observeAbort(signal)
            try {
                yield () => i18n.value.commands.open.importing
                if (!request.isCurrent()) return
                committing = project.storeAndShow(
                    {
                        read: opened,
                        file,
                        ...(handle ? { handle } : {}),
                        ...(identity && opened.project
                            ? {
                                  bind: {
                                      name,
                                      options: bindingOptions(opened.project, live),
                                  },
                              }
                            : {}),
                        identity,
                        ...(asHead
                            ? {
                                  summary: summaryOf(
                                      live,
                                      noteCountOf(history?.headRecords.kinds ?? []),
                                  ),
                              }
                            : { level: stateBatch(live) }),
                        ...(copyOf ? { copyOf } : {}),
                        sourceName: file.name,
                        operations: {
                            opened: createHistoryOperation({
                                id: 'nse.origin',
                                data: { origin: 'import', source: captureName(name) },
                            }),
                            changedOutside: createHistoryOperation({
                                id: 'nse.externalChange',
                                data: {},
                            }),
                        },
                        appVersion: appVersion().appVersion,
                    },
                    request,
                )
                const bgm = opened.media.bgm
                committing = committing.then((result) => {
                    if (
                        result.kind === 'stored' &&
                        result.shown &&
                        bgm &&
                        live.bgm.meta?.hash === mediaHash(bgm.form)
                    )
                        void project
                            .attachOpenedBgm(
                                bgm.bytes,
                                live.bgm.meta.hash,
                                decodeBgm,
                                result.sessionId,
                            )
                            .catch(() => undefined)
                    return result
                })
                request.retainUntil(committing)
                stored = await committing
            } catch (error) {
                if (request.isCurrent()) throw error
            } finally {
                stopAbort()
            }
        },
    })
    if (!committing) cancel()
    if (stored?.kind !== 'stored' || !stored.shown || !request.isCurrent()) return

    // A file this browser wrote confirms that its downloads work (§1.3.4); no other row changes.
    const device = opened.project?.revision?.device.id
    if (identity && device !== undefined && device === thisDevice()) confirmDownloads()

    // The session this open left, which Reopen offers.
    const left = previousSession.value?.sessionId
    const earlier = revision
        ? earlierNotice(
              { id: revision.id, ancestors: revision.ancestors },
              await project.earlierChains(opened.project?.id ?? '', stored.chainId),
          )
        : undefined
    if (!request.isCurrent()) return
    const bgm = opened.media.bgm
    const bgmMissing =
        live.bgm.meta !== undefined && (!bgm || mediaHash(bgm.form) !== live.bgm.meta.hash)
    if (elsewhere)
        notify(
            interpolate(() => i18n.value.notice.sameFileElsewhere, file.name),
            { card: true, severity: 'info' },
        )
    // A newer `patch` alone gives way to an earlier session's unsaved changes: that notice has the
    // action that keeps work, and the open is whole either way.
    else if (line && !(line.kind === 'newerPatch' && earlier)) {
        const message = partialMessage(line)
        notify(() => message, { card: true, severity: 'warning' })
    } else if (!earlier && bgmMissing) {
        // A BGM the file records but doesn't hold (§1.5.4 step 5): not loaded, with Choose Audio….
        dismissNoticeCard()
        notify(() => i18n.value.notice.bgmNotLoaded, {
            severity: 'info',
            action: {
                label: () => i18n.value.notice.chooseAudio,
                run: () => {
                    void changeBgm()
                },
            },
        })
    } else notifyOpened(name, earlier, left)
}

/** How Replace's keep-first went (§1.4.7): only `kept` lets it write. */
export type Kept = 'kept' | 'newer' | 'damaged' | 'failed'

/**
 * Replace's keep-first (§1.4.7, Part 0 §0.9.6): the file on disk, read from the `File` the check
 * pinned, stored whole as a new, unbound, ordinary session named `name`, its level through the
 * level-data path as an open's is. A file this build can't import whole is refused.
 */
export const keepReplaced = async (file: File, name: string): Promise<Kept> => {
    const project = await import('../../../local/open/project')
    let read: NxspReply
    try {
        const result = await project.readProjectFile(file)
        if (result.kind !== 'nxsp') return 'damaged'
        read = result
    } catch {
        return 'failed'
    }
    const drop = (kept: Kept) => {
        project.dropProjectRead(read.id)
        return kept
    }
    if (newerFile(read)) return drop('newer')
    let parsed: ReturnType<typeof parseLevel>
    try {
        parsed = parseLevel(read)
    } catch {
        return drop('damaged')
    }
    const { levelData, chart, report } = parsed
    if (report.hasUnknownValue) return drop('newer')
    if (read.open !== 'full' || !report.isEmpty || !read.project) return drop('damaged')
    const history = read.history
    const head = history ? stateFromRecords(history.headRecords) : undefined
    const headLive =
        head && matchesHead(levelData.entities, levelData.bgmOffset, read.project, head)
            ? head
            : undefined
    const live = headLive ?? levelState(chart, levelData.bgmOffset, read.project, head)
    const kept = await project.storeKept({
        read,
        file,
        sourceName: file.name,
        name,
        ...(headLive
            ? { summary: summaryOf(live, noteCountOf(history?.headRecords.kinds ?? [])) }
            : { level: stateBatch(live) }),
        operations: {
            opened: createHistoryOperation({
                id: 'nse.origin',
                data: { origin: 'import', source: captureName(file.name) },
            }),
            changedOutside: createHistoryOperation({ id: 'nse.externalChange', data: {} }),
        },
        appVersion: appVersion().appVersion,
    })
    return kept ? 'kept' : 'failed'
}
