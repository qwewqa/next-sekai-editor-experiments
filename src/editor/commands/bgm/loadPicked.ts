import { busy, record } from '../../../analytics/tally'
import { i18n } from '../../../i18n'
import { captureMedia, durationMsOf } from '../../../local/media'
import { loadBgm } from '../../../player'
import { settings } from '../../../settings'
import { getFilename } from '../../../utils/file'
import { timeout } from '../../../utils/promise'
import { createWaveform, releaseWaveform } from '../../../waveform'
import type { PickedBgm } from '../../media/applyPick'

const FORMATS = [
    ['mp3', /mpeg|mp3/],
    ['ogg', /ogg|opus/],
    ['wav', /wav/],
    ['flac', /flac/],
    ['m4a', /m4a|mp4|aac/],
] as const

/** The file’s format for the usage statistics, from its type or its extension. */
const formatOf = (file: File) => {
    const text = `${file.type} ${file.name.split('.').at(-1) ?? ''}`.toLowerCase()
    return FORMATS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other'
}

/**
 * Loads a picked file for the loading dialog, reporting each step. `cancelled` is asked after each
 * await; a throw there is the dialog's AbortError. The waveform belongs to the caller once this
 * returns, and is released here when the load is cancelled after it was drawn.
 */
export async function* loadPickedBgm(
    file: File,
    cancelled: () => boolean,
    signal: AbortSignal,
): AsyncGenerator<() => string, PickedBgm> {
    // The usage statistics’ `bgm` event, with the load as its time.
    const began = performance.now()
    const base = { format: formatOf(file), size: file.size } as const
    busy(true)
    try {
        const picked = yield* load(file, cancelled, signal)
        record('bgm', { ...base, length: picked.buffer.duration * 1000, outcome: 'done' }, began)
        return picked
    } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError'
        record('bgm', { ...base, outcome: aborted ? 'cancelled' : 'failed' }, began)
        throw error
    } finally {
        busy(false)
    }
}

async function* load(
    file: File,
    cancelled: () => boolean,
    signal: AbortSignal,
): AsyncGenerator<() => string, PickedBgm> {
    const check = () => {
        if (cancelled()) throw new DOMException('BGM import cancelled', 'AbortError')
    }
    check()
    yield () => i18n.value.commands.bgm.modal.loading

    const data = await file.arrayBuffer()
    check()
    // Hashed and copied before decoding, which detaches the buffer.
    const captured = await captureMedia(data, file)
    check()

    yield () => i18n.value.commands.bgm.modal.decoding

    const buffer = await loadBgm(data)
    check()

    yield () => i18n.value.commands.bgm.modal.generating
    await timeout(50)
    check()

    const waveform = await createWaveform(buffer, settings.waveform, signal)
    try {
        check()
    } catch (error) {
        releaseWaveform(waveform)
        throw error
    }
    const durationMs = durationMsOf(buffer.duration)
    return {
        filename: getFilename(file),
        buffer,
        ...(waveform ? { waveform } : {}),
        source: captured.source,
        // Every pick records its own metadata and bytes, never the previous BGM's.
        meta: { ...captured.meta, ...(durationMs === undefined ? {} : { durationMs }) },
    }
}
