import type { Inventory, PackageLevel } from '../../../files/package/inventory'
import { resetImportedState } from '../../../history'
import { captureName } from '../../../history/operations'
import { createSessionDescriptor } from '../../../history/session'
import { i18n } from '../../../i18n'
import { getLevelDataRevision, getRevisionWarning } from '../../../levelData/revision'
import { COVER_MAX_SIDE, readCoverSize } from '../../../local/media'
import { showModal } from '../../../modals'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { savePoint } from '../../../platform/testPause'
import { settings } from '../../../settings'
import { createState } from '../../../state'
import type { Bgm } from '../../../state/bgm'
import type { LevelInfo } from '../../../state/levelInfo'
import { isAbort } from '../../../utils/error'
import { interpolate } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { createWaveform, releaseWaveform } from '../../../waveform'
import { trackHeldPicks } from '../../levelInfo/heldPicks'
import { capturePicked, type Picked } from '../../levelInfo/picked'
import { attachHeld, cacheBgm, cacheHeld, refusalOf, runHeld } from '../../media/heldBgm'
import type { NoticeLine } from '../../notification'
import { notifyLeft } from '../../switch'
import type { SwitchRequest } from '../../switchRequest'
import { refusalLine } from '../bgm/chooseAudio'
import { loadPickedBgm } from '../bgm/loadPicked'
import { exportMemory, rememberExport } from '../exportLevel/memory'
import { confirmNewerValues, localizedOpenError, showOpenWarning, type OpenWarning } from './index'
import { LevelUnreadableError, RefusedFileError, type Parsed } from './levelData'
import { levelInfoOf, readDescription, readLevelData, readMedia } from './packageData'
import { endOpen, openFormat } from './report'

// Opening one level of a Sonolus package: a new session with its chart, Level Info, cover,
// preview audio, BGM and offset, as level data opens. Nothing changes until the publish, and the
// package never becomes an Export target.

/** What the dialog read, ready to publish. */
type Prepared = {
    parsed: Parsed
    levelInfo: LevelInfo
    bgm: Bgm
    lines: NoticeLine[]
}

const withoutLine = (slot: 'bgm' | 'cover' | 'preview'): NoticeLine => ({
    message: interpolate(
        () => i18n.value.open.package.withoutMedia,
        () => i18n.value.open.media[slot],
    ),
    severity: 'info',
})

/** A media item's bytes as Level Info's pickers take a file. */
const sourceOf = (bytes: Uint8Array) => ({
    name: '',
    type: '',
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
})

/**
 * Opens one level of a package in the Open loading dialog, as a new session. Resolves true once
 * it is shown; false when it failed, was cancelled, or a newer switch took over. Media held for
 * an open that did not publish is released.
 */
export const openPackageLevel = async (
    { pkg }: Inventory,
    level: PackageLevel,
    request: SwitchRequest,
): Promise<boolean> => {
    openFormat('scp')
    const holds = trackHeldPicks()
    // Set inside the dialog task.
    const read: { prepared?: Prepared; newerValues?: true } = {}
    let published = false
    try {
        await showModal(LoadingModal, {
            title: () => i18n.value.commands.open.dialogTitle,
            async *task(signal: AbortSignal) {
                const stopAbort = request.observeAbort(signal)
                const cancelled = () => signal.aborted || !request.isCurrent()
                const check = () => {
                    signal.throwIfAborted()
                    if (!request.isCurrent()) throw new DOMException('Superseded', 'AbortError')
                }
                try {
                    yield () => i18n.value.commands.open.importing
                    await timeout(50)
                    check()
                    const parsed = await readLevelData(pkg, level)
                    check()
                    const levelInfo = levelInfoOf(
                        level.item,
                        await readDescription(pkg, level.name),
                    )
                    const lines: NoticeLine[] = []
                    let info = levelInfo

                    // Each medium is optional: one the editor cannot use is left out with a line.
                    const cover = await readMedia(pkg, level.item, 'cover')
                    check()
                    if (cover.kind === 'bytes') {
                        const size = readCoverSize(cover.bytes)
                        const fits =
                            size === 'unknown' ||
                            (size !== undefined &&
                                size.width <= COVER_MAX_SIDE &&
                                size.height <= COVER_MAX_SIDE)
                        const picked = fits ? await capture('cover', cover.bytes) : undefined
                        check()
                        if (picked) {
                            holds.hold(picked)
                            info = { ...info, cover: picked.ref }
                        } else lines.push(withoutLine('cover'))
                    } else if (cover.kind === 'unusable') lines.push(withoutLine('cover'))

                    const preview = await readMedia(pkg, level.item, 'preview')
                    check()
                    if (preview.kind === 'bytes') {
                        const picked = await capture('preview', preview.bytes)
                        check()
                        if (picked) {
                            holds.hold(picked)
                            info = { ...info, preview: picked.ref }
                        } else lines.push(withoutLine('preview'))
                    } else if (preview.kind === 'unusable') lines.push(withoutLine('preview'))

                    let bgm: Bgm = { offset: parsed.offset }
                    const audio = await readMedia(pkg, level.item, 'bgm')
                    check()
                    if (audio.kind === 'bytes') {
                        try {
                            // Decoded before the switch, so a problem is known before anything changes.
                            const loaded = yield* loadPickedBgm(
                                new File([new Uint8Array(audio.bytes)], ''),
                                cancelled,
                                signal,
                                { record: false, waveform: false },
                            )
                            bgm = {
                                offset: parsed.offset,
                                filename: loaded.filename,
                                buffer: loaded.buffer,
                                source: loaded.source,
                                meta: loaded.meta,
                            }
                        } catch (error) {
                            if (isAbort(error)) throw error
                            const refusal = refusalOf(error)
                            lines.push(refusal ? refusalLine(refusal) : withoutLine('bgm'))
                        }
                    } else if (audio.kind === 'unusable') lines.push(withoutLine('bgm'))
                    check()

                    const prepared = { parsed, levelInfo: info, bgm, lines }
                    read.prepared = prepared
                    // Values this build does not know: the level opens only after its confirm.
                    if (parsed.type === 'levelData' && parsed.report.hasUnknownValue) {
                        read.newerValues = true
                        return
                    }
                    published = publish(request, level, prepared)
                } catch (error) {
                    if (isAbort(error) || !request.isCurrent()) return
                    if (error instanceof LevelUnreadableError) endOpen('refused', 'unsupported')
                    else if (error instanceof RefusedFileError) endOpen('refused', 'invalid')
                    else endOpen('failed')
                    throw localizedOpenError(error)
                } finally {
                    stopAbort()
                    // A spec waits for this to know the task has settled, cancelled or not.
                    void savePoint('packageLevelEnded')
                }
            },
        })
        const { prepared, newerValues } = read
        if (!prepared || !request.isCurrent()) return published
        if (newerValues) {
            const choice = await confirmNewerValues(level.title)
            // Cancel opens nothing and leaves the session as it was.
            if (!choice || !request.isCurrent()) return false
            published = publish(request, level, prepared)
        }
        if (published) await after(request, prepared)
        return published
    } finally {
        if (published) holds.applied()
        else holds.release(() => false)
    }
}

/** Captures a cover or preview clip as Level Info does; undefined when it does not decode. */
const capture = async (
    slot: 'cover' | 'preview',
    bytes: Uint8Array,
): Promise<Picked | undefined> => {
    try {
        return await capturePicked(slot, sourceOf(bytes))
    } catch {
        return
    }
}

/** The new session, its state published whole: the media bytes are held, so the first flush stores them. */
const publish = (request: SwitchRequest, level: PackageLevel, prepared: Prepared) => {
    const { chart, offset } = prepared.parsed
    const name = level.title
    const descriptor = createSessionDescriptor({ sourceName: name })
    const base = createState(chart, offset, {
        levelInfo: prepared.levelInfo,
        ...(prepared.bgm.meta ? { bgm: prepared.bgm.meta } : {}),
    })
    const state = { ...base, bgm: { ...prepared.bgm, offset } }
    const shown = request.publish({ state, sessionId: descriptor.sessionId, reset: true }, () => {
        resetImportedState(state, descriptor, captureName(name))
    })
    if (!shown) return false
    cacheBgm(state.bgm)
    runHeld(drawWaveform(descriptor.sessionId, state.bgm))
    return true
}

/** After the publish: the partial flag stored, the notice, then what the level left out. */
const after = async (request: SwitchRequest, prepared: Prepared) => {
    const { parsed, lines } = prepared
    // Parts left out make it partial, so pickers suggest a copy's name, as for level data.
    const complete = parsed.type !== 'levelData' || parsed.report.isEmpty
    const warning: OpenWarning | undefined =
        parsed.type !== 'levelData'
            ? undefined
            : complete
              ? getRevisionWarning(getLevelDataRevision(parsed.levelData.entities), parsed.chart)
              : 'unsupportedParts'
    if (!complete) exportMemory.partial = true
    await rememberExport()
    endOpen('done')
    if (!request.isCurrent()) return
    notifyLeft(
        () => i18n.value.commands.open[parsed.type === 'chcy' ? 'importedChcy' : 'opened'],
        true,
        lines,
    )
    if (warning) showOpenWarning(warning)
}

/** The waveform, drawn after the switch: a reset revokes the waveforms drawn before it. */
const drawWaveform = async (sessionId: string, bgm: Bgm) => {
    const { buffer, source, meta } = bgm
    if (!buffer || !source || !meta) return
    let waveform
    try {
        waveform = await createWaveform(buffer, settings.waveform)
    } catch {
        return
    }
    if (!waveform) return
    const parts = { buffer, source, waveform }
    if (!attachHeld(sessionId, meta.hash, parts)) {
        releaseWaveform(waveform)
        return
    }
    cacheHeld(meta.hash, parts)
}
