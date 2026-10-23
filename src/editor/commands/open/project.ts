import { AssertError } from 'typebox/value'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { openState } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { captureName } from '../../../history/operations'
import { leavePeek } from '../../../history/peek'
import { createSessionDescriptor, session } from '../../../history/session'
import { liveState } from '../../../history/stack'
import { i18n } from '../../../i18n'
import { formatDateInSentence } from '../../../i18n/when'
import { parseLevelData } from '../../../levelData/parse'
import { LevelDataReport } from '../../../levelData/report'
import { getLevelDataRevision, LATEST_REVISION } from '../../../levelData/revision'
import { summaryOf } from '../../../local/flush'
import { toHex } from '../../../local/hash'
import { heldItem } from '../../../local/heldMedia'
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
import { reopensOwnFile, type ReopenFacts } from '../../../local/open/reopen'
import { noteCountOf, stateFromRecords } from '../../../local/records/records'
import { stateBatch } from '../../../local/stateBatch'
import { storedRead } from '../../../local/storedRead'
import { showModal } from '../../../modals'
import { showChoice } from '../../../modals/choice'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { appVersion } from '../../../platform'
import { loadBgm } from '../../../player'
import { PRODUCT_NAME } from '../../../product'
import { settings } from '../../../settings'
import type { State } from '../../../state'
import { storageGet } from '../../../storage'
import { getFilename } from '../../../utils/file'
import { interpolate, interpolateRaw } from '../../../utils/interpolate'
import { createWaveform } from '../../../waveform'
import { confirmDownloads } from '../../file/flags'
import { confirmFile, fileChanged } from '../../file/state'
import { bgmStatus, claimNotice, isHeldHere } from '../../media/heldBgm'
import { dismissNoticeCard, notify, type NoticeLine } from '../../notification'
import { restoreStored } from '../../restoreStored'
import { bindingHandle, bindingOf, environment, type Env } from '../../save/binding'
import { revokedOf } from '../../save/watch'
import { notifyLeft } from '../../switch'
import { withSwitchRequest, type SwitchRequest } from '../../switchRequest'
import { chooseAudioAction } from '../bgm/chooseAudio'

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
    // The one Restore Session: its card, Reopen and the BGM line, and a copy says it is one.
    run: () => {
        void restoreStored(sessionId, 'restore')
    },
})

const earlierMessage = (notice: EarlierNotice, name: string) => {
    const when = formatDateInSentence(notice.chain.updatedAt)
    const { open } = i18n.value
    switch (notice.kind) {
        case 'unsavedChanges':
            return () =>
                interpolateRaw(
                    notice.maybe ? open.unsavedChangesMaybe : open.unsavedChanges,
                    name,
                    when,
                )
        case 'unsavedEarlier':
            return () =>
                interpolateRaw(
                    notice.maybe ? open.unsavedEarlierMaybe : open.unsavedEarlier,
                    name,
                    when,
                )
        case 'olderVersion':
            return () => interpolateRaw(open.olderVersion, name, when)
    }
}

/**
 * The open's own line: "Opened coconut.nxsp", or, when Recent Sessions could not be checked for
 * other versions of it, the line that says so (it is never an error: the open succeeded).
 */
const openedLine = (name: string, unchecked: boolean) =>
    interpolate(
        () => (unchecked ? i18n.value.open.earlierUnchecked : i18n.value.history.openedFile),
        name,
    )

/**
 * Shows the open's notice: an earlier session's, or "Opened coconut.nxsp" with Reopen (none when
 * the open kept the session, `offer` false).
 */
const notifyOpened = (
    name: string,
    notice: EarlierNotice | undefined,
    leftSessionId: string | undefined,
    unchecked: boolean,
    offer = true,
) => {
    // The chain with unsaved changes is the session just left: only Reopen shows (§1.4.1).
    if (!notice || (notice.kind === 'unsavedChanges' && notice.chain.sessionId === leftSessionId)) {
        notifyLeft(openedLine(name, unchecked), offer)
        return
    }
    dismissNoticeCard()
    const message = earlierMessage(notice, name)
    if (notice.kind === 'unsavedEarlier') notify(message, { card: true, severity: 'info' })
    else notify(message, { action: restoreAction(notice.chain.sessionId), severity: 'info' })
}

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** Whether every media hash the live state names is held in this tab or in storage. */
const mediaHeld = async (env: Env, state: State) => {
    const asked: string[] = []
    if (state.bgm.meta && !isHeldHere(state.bgm)) asked.push(state.bgm.meta.hash)
    for (const ref of [state.levelInfo.cover, state.levelInfo.preview])
        if (ref && !heldItem(ref.hash)) asked.push(ref.hash)
    if (!asked.length) return true
    const held = await env.worker.call('mediaHeld', asked).catch(() => undefined)
    return !!held && asked.every((hash) => held.includes(hash))
}

/**
 * The open session's chain, when the opened file is its own last write, unchanged on both sides
 * (`reopensOwnFile`): Open then keeps the session. Every fact is read as the next Save would read
 * it; a read that fails is no match, and the open goes on as any other.
 */
const ownWriteOf = async (
    opened: NxspReply,
    handle: FileSystemFileHandle | undefined,
    identity: boolean,
    asHead: boolean,
) => {
    if (!identity || !asHead) return
    const env = environment()
    if (env?.session.id !== session.value.sessionId) return
    const read = await storedRead(env.worker, 'readChainRecord', env.chainId)
    if (read.storedRead === 'failed') return
    const record = read.storedValue
    const replaced = !!revokedOf(record, env.session)
    const binding = bindingOf(record, env.session)
    const file = binding.file
    const bound = file ? await bindingHandle(env, file) : undefined
    if (bound?.storedRead === 'failed') return
    const boundHandle = bound?.storedValue
    const sameEntry =
        !!handle && !!boundHandle && (await handle.isSameEntry(boundHandle).catch(() => false))
    const state = liveState.value
    const labelHash = session.value.file?.hash
    const facts: ReopenFacts = {
        identity,
        asHead,
        file: {
            ...(opened.project ? { docId: opened.project.id } : {}),
            ...(opened.project?.revision ? { revisionId: opened.project.revision.id } : {}),
            ...(opened.history ? { head: opened.history.head } : {}),
            ...(opened.disk ? { disk: opened.disk } : {}),
            handle: !!handle,
        },
        binding: {
            docId: binding.docId,
            ...(binding.revision ? { revisionId: binding.revision.id } : {}),
            replaced,
            ...(file
                ? {
                      file: {
                          event: file.event,
                          hash: toHex(file.hash),
                          ...(file.disk ? { disk: file.disk } : {}),
                          handle: !!boundHandle,
                      },
                  }
                : {}),
        },
        // The label's binding is this one, and the live state is the one it holds.
        changed: fileChanged.value || !file || labelHash !== toHex(file.hash),
        sameEntry,
        badChunks: isRow(record) && record.badChunks !== undefined,
        mediaHeld: await mediaHeld(env, state),
    }
    // The live state moved while the facts were read: no match.
    if (!reopensOwnFile(facts) || !file || liveState.value !== state) return
    return { chainId: env.chainId, file }
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
    const bound = whole && handle ? await project.boundInAnotherTab(handle) : 'no'
    const elsewhere = bound !== 'no'
    if (!request.isCurrent()) {
        cancel()
        return
    }
    const identity = whole && !elsewhere
    const name = bindingName(file.name, opened.project?.revision?.fileName, !!handle)
    const copyOf = identity ? undefined : { name, bound: true as const }

    // Earlier sessions on this file, recognised by revision (§1.5.4 step 4).
    const revision = identity ? opened.project?.revision : undefined

    // The file the open session's chain last wrote, unchanged since: Open keeps the session, with
    // the earlier sessions' notice any open of it gives (§1.5.4).
    const own = await ownWriteOf(opened, handle, identity, asHead)
    if (!request.isCurrent()) {
        cancel()
        return
    }
    if (own) {
        cancel()
        let earlier: EarlierNotice | undefined
        let unchecked = false
        if (revision) {
            const chains = await project.earlierChains(opened.project?.id ?? '', own.chainId)
            if (chains.storedRead === 'value')
                earlier = earlierNotice(
                    { id: revision.id, ancestors: revision.ancestors },
                    chains.storedValue,
                )
            else unchecked = true
        }
        if (!request.isCurrent()) return
        // Last: leaving a peek ends the request.
        leavePeek()
        // Opening it proves the user has the download (§1.3.4).
        if (own.file.event === 'downloaded') confirmFile()
        notifyOpened(name, earlier, undefined, unchecked, false)
        return
    }

    // Nothing can be stored (safe mode, a newer database): the level opens, as an import does.
    const { storageStatus } = await import('../../../local/startup/events')
    if (storageStatus.value?.mode === 'readOnly') {
        cancel()
        const descriptor = createSessionDescriptor({ sourceName: getFilename(file) })
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
                        sourceName: getFilename(file),
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
    let earlier: EarlierNotice | undefined
    let unchecked = false
    if (revision) {
        const chains = await project.earlierChains(opened.project?.id ?? '', stored.chainId)
        switch (chains.storedRead) {
            case 'value':
                earlier = earlierNotice(
                    { id: revision.id, ancestors: revision.ancestors },
                    chains.storedValue,
                )
                break
            case 'failed':
                // The open succeeded, so it is never failed by this read: its line says the
                // earlier sessions could not be checked, as the heading of every other row.
                unchecked = true
                break
        }
    }
    if (!request.isCurrent()) return
    const bgm = opened.media.bgm
    const missingMeta =
        live.bgm.meta !== undefined && (!bgm || mediaHash(bgm.form) !== live.bgm.meta.hash)
            ? live.bgm.meta
            : undefined
    // Not loaded only when the media store lacks it too, and said once per hash.
    const bgmUnheld =
        missingMeta !== undefined &&
        (await bgmStatus(missingMeta.hash, missingMeta.size)) === 'absent'
    if (!request.isCurrent()) return
    const bgmMissing = () => bgmUnheld && claimNotice(missingMeta.hash)
    // A newer `patch` is a line of its own, which a whole open shows beside what else it has to
    // say: bound in another tab, or a BGM that is not loaded. Only an earlier session's unsaved
    // changes take the card from it, since that notice has the action that keeps work.
    const patchRow: NoticeLine | undefined =
        line?.kind === 'newerPatch'
            ? { message: () => partialMessage(line), severity: 'warning' }
            : undefined
    const bgmRow: NoticeLine = {
        message: () => i18n.value.load.bgmNotLoaded,
        severity: 'info',
        // A BGM the file records but doesn't hold (§1.5.4 step 5): not loaded, with Choose Audio….
        action: chooseAudioAction,
    }
    const showRows = (rows: NoticeLine[]) => {
        const [only] = rows
        // Alone, a row would read as an open whose earlier sessions were checked and found none.
        if (rows.length === 1 && only && !unchecked)
            notify(only.message, {
                card: true,
                severity: only.severity ?? 'info',
                ...(only.action ? { action: only.action } : {}),
            })
        else
            notify(() => rows.map((row) => row.message()).join(String.fromCharCode(10)), {
                lines: [
                    {
                        message: openedLine(name, unchecked),
                        heading: true,
                    },
                    ...rows,
                ],
            })
    }
    if (elsewhere)
        showRows([
            {
                message: interpolate(
                    () =>
                        bound === 'unknown'
                            ? i18n.value.notice.sameFileMaybeElsewhere
                            : i18n.value.notice.sameFileElsewhere,
                    file.name,
                ),
                severity: 'info',
            },
            ...(patchRow ? [patchRow] : []),
        ])
    else if (line && line.kind !== 'newerPatch') {
        const message = partialMessage(line)
        if (unchecked) showRows([{ message: () => message, severity: 'warning' }])
        else notify(() => message, { card: true, severity: 'warning' })
    } else if (patchRow && !earlier) {
        dismissNoticeCard()
        showRows([patchRow, ...(bgmMissing() ? [bgmRow] : [])])
    } else if (!earlier && bgmMissing()) {
        dismissNoticeCard()
        showRows([bgmRow])
    } else notifyOpened(name, earlier, left, unchecked)
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
        sourceName: getFilename(file),
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
