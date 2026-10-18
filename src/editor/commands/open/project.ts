import { AssertError } from 'typebox/value'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { isPeeking } from '../../../history'
import { i18n } from '../../../i18n'
import { formatDate } from '../../../i18n/when'
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
import { storageGet, storageSet } from '../../../storage'
import { interpolate, interpolateRaw } from '../../../utils/interpolate'
import { createWaveform } from '../../../waveform'
import { dismissNoticeCard, notify } from '../../notification'
import { notifyLeft } from '../../switch'

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
        case 'mediaBad':
            return interpolateRaw(open.mediaBad, open.media[line.media])
    }
}

/** The browser this one is, as revisions record it (§1.3.3): `deviceId` in localStorage. */
const thisDevice = () => {
    const id = storageGet('deviceId', undefined)
    return typeof id === 'string' ? id : undefined
}

/**
 * A file this browser downloaded confirms its downloads work (§1.3.4): `downloadConfirmed`, the
 * settings flag beside the first-Save flag (§1.5.6).
 */
export const DOWNLOAD_CONFIRMED_KEY = 'downloadConfirmed'

const restoreAction = (sessionId: string) => ({
    label: () => i18n.value.open.restoreIt,
    run: () => {
        void (async () => {
            const { confirmSwitch } = await import('../../switch')
            if (!(await confirmSwitch())) return
            const { restoreSession } = await import('../../../local/startup/api')
            if (await restoreSession(sessionId)) dismissNoticeCard()
        })()
    },
})

const earlierMessage = (notice: EarlierNotice, name: string) => {
    const when = formatDate(notice.chain.updatedAt)
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
    if (notice.kind === 'unsavedEarlier') notify(message, { card: true })
    else notify(message, { action: restoreAction(notice.chain.sessionId) })
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
export const openProject = async (file: File, handle: FileSystemFileHandle | undefined) => {
    const project = await import('../../../local/open/project')
    const { previousSession } = await import('../../../local/startup/events')

    // Read and checked in the worker, the level parsed here (§1.5.4 steps 2–3).
    let read: NxspReply | undefined
    let parsed: ReturnType<typeof parseLevel> | undefined
    let refusal: string | undefined
    await showModal(LoadingModal, {
        title,
        async *task(signal: AbortSignal) {
            yield () => i18n.value.commands.open.loading
            const result = await project.readProjectFile(file)
            if (signal.aborted) {
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
        },
    })
    if (!read) return
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
        if (!choice) {
            cancel()
            return
        }
        try {
            parsed = parseLevel(opened)
        } catch (error) {
            cancel()
            if (!(error instanceof OpenRefused)) throw error
            notify(() => error.message, { card: true })
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
        if (!choice) {
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
    const identity = whole && !elsewhere
    const name = bindingName(file.name, opened.project?.revision?.fileName, !!handle)
    const copyOf = identity ? undefined : { name, bound: true as const }

    // Earlier sessions on this file, recognised by revision (§1.5.4 step 4).
    const revision = identity ? opened.project?.revision : undefined

    let stored: Awaited<ReturnType<typeof project.storeAndShow>> | undefined
    await showModal(LoadingModal, {
        title,
        async *task() {
            yield () => i18n.value.commands.open.importing
            // Never cancelled once sent: a stored session always shows.
            stored = await project.storeAndShow({
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
                    ? { summary: summaryOf(live, noteCountOf(history?.headRecords.kinds ?? [])) }
                    : { level: stateBatch(live) }),
                ...(copyOf ? { copyOf } : {}),
                sourceName: file.name,
                labels: {
                    opened: interpolateRaw(i18n.value.history.openedFile, name),
                    changedOutside: i18n.value.entry.changedOutside,
                },
                appVersion: appVersion().appVersion,
            })
        },
    })
    if (!stored) {
        cancel()
        return
    }

    // A file this browser wrote confirms that its downloads work (§1.3.4); no other row changes.
    const device = opened.project?.revision?.device.id
    if (identity && device !== undefined && device === thisDevice())
        storageSet(DOWNLOAD_CONFIRMED_KEY, true)

    // The session this open left, which Reopen offers.
    const left = previousSession.value?.sessionId
    const earlier = revision
        ? earlierNotice(
              { id: revision.id, ancestors: revision.ancestors },
              await project.earlierChains(opened.project?.id ?? '', stored.chainId),
          )
        : undefined
    if (elsewhere)
        notify(
            interpolate(() => i18n.value.notice.sameFileElsewhere, file.name),
            { card: true },
        )
    else if (line) {
        const message = partialMessage(line)
        notify(() => message, { card: true })
    } else notifyOpened(name, earlier, left)

    // The file's BGM decodes in the background (§1.6.8.4).
    const bgm = opened.media.bgm
    if (bgm && live.bgm.meta?.hash === mediaHash(bgm.form) && !isPeeking.value)
        void project
            .attachOpenedBgm(bgm.bytes, live.bgm.meta.hash, decodeBgm)
            .catch(() => undefined)
}
