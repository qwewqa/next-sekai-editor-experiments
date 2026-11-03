// The messages above the Export Video footer, in the order they show: what the export is doing,
// its failure or the finished file's warnings, and advice for the next export.

import { outputSize, type CodecSupport } from '../../exportVideo/codecs'
import { AUDIO_BITRATES, RESOLUTIONS } from '../../exportVideo/estimate'
import { fitsGraphicsLimits, type GraphicsLimits } from '../../exportVideo/graphics'
import type { ExportSettings } from '../../exportVideo/types'
import { i18n } from '../../i18n'
import { formatList } from '../../levelData/statistics'
import { settings } from '../../settings'
import type { ExportVideoChoices } from '../../settings/exportVideo'
import { interpolateRaw } from '../../utils/interpolate'
import { VIDEO_MEMORY_WARNING_BYTES } from './destination'
import type { Outcome, Phase } from './dialog'

/** The fields the unavailable line names. `sound` is BGM and SFX together. */
export type UnavailableField =
    'audioBitrate' | 'frameRate' | 'resolution' | 'format' | 'sound' | 'antialias' | 'renderScale'

export type ExportMessage = {
    kind:
        | 'keepOpen'
        | 'failure'
        | 'delivery'
        | 'finished'
        | 'unavailable'
        | 'memory'
        | 'stopped'
        | 'storage'
    severity: 'info' | 'warning' | 'error'
    text: string
    /** English detail, behind Error Details. */
    detail?: string
    /** The fields the unavailable line names. */
    fields?: UnavailableField[]
}

export type MessageInput = {
    phase: Phase
    outcome?: Outcome
    deliverFailed?: 'download' | 'share'
    /** A phone or tablet, which stops a hidden page's export. */
    coarse: boolean
    form: Pick<
        ExportVideoChoices,
        'resolution' | 'frameRate' | 'format' | 'antialias' | 'renderScale' | 'audioBitrate'
    > &
        Pick<ExportSettings, 'bgm' | 'sfx'> & { aspect: number }
    /** The last settled codec results: an update in progress keeps them. */
    support: { current?: CodecSupport; choices: Record<string, CodecSupport> }
    /** Undefined until read, null when they could not be read. */
    limits: GraphicsLimits | null | undefined
    frames: number
    bytes: number
    memoryRoute?: boolean
    stopped: { resolution: number; renderScale: number } | null
    storageNearlyFull: boolean
}

/** A width and height as the footer's summary shows them. */
export const formatDimensions = ({ width, height }: { width: number; height: number }) =>
    `${width} × ${height}`

/** The sound sources that are on, as a list inside a sentence. */
export const soundList = ({ bgm, sfx }: Pick<ExportSettings, 'bgm' | 'sfx'>) =>
    formatList(
        [...(bgm ? [i18n.value.save.bgm] : []), ...(sfx ? [i18n.value.modals.form.sfx.label] : [])],
        settings.locale,
        'long',
    )

/** Values below the current one, nearest first. */
const lower = <T extends number>(values: readonly T[], current: number) =>
    values.filter((value) => value < current).reverse()

/** Whether a size fits the graphics limits; unknown limits are no evidence that it does not. */
const fits = (input: MessageInput, resolution: number, scale: number, antialias: boolean) =>
    !input.limits ||
    fitsGraphicsLimits(outputSize(resolution, input.form.aspect), scale, antialias, input.limits)

type Found = { field: UnavailableField; items: string[] }

/**
 * At most one line, with the items for each failed check, the codec check first and then the
 * graphics limits check. Each check names the first setting, in its order, that has a working
 * choice.
 */
const unavailable = (input: MessageInput): ExportMessage[] => {
    const { form, support } = input
    const strings = i18n.value.exportVideo
    const found = (field: UnavailableField, ...items: string[]): Found => ({ field, items })
    const kbps = interpolateRaw(strings.kbps, `${form.audioBitrate / 1000}`)
    const fps = interpolateRaw(strings.fps, `${form.frameRate}`)
    const resolutionItem = `${strings.resolution} ${form.resolution}p`
    const sound = form.bgm || form.sfx
    const works = (key: string) => support.choices[key]?.supported === true
    const codecFails = support.current?.supported === false

    // The nearest lower value that the same probes accept.
    const codec = ((): Found | undefined => {
        if (!codecFails) return undefined
        const audio = sound
            ? lower(AUDIO_BITRATES, form.audioBitrate).find((value) =>
                  works(`audioBitrate:${value}`),
              )
            : undefined
        if (audio) return found('audioBitrate', `${strings.audioBitrate} ${kbps}`)
        if (form.frameRate === 60 && works('frameRate:30'))
            return found('frameRate', `${strings.frameRate} ${fps}`)
        const resolution = lower(RESOLUTIONS, form.resolution).find(
            (value) =>
                works(`resolution:${value}`) &&
                fits(input, value, form.renderScale, form.antialias),
        )
        if (resolution) return found('resolution', resolutionItem)
        const other = form.format === 'mp4' ? 'webm' : form.format === 'webm' ? 'mp4' : undefined
        if (other && works(`format:${other}`))
            return found('format', `${strings.format} ${form.format === 'webm' ? 'WebM' : 'MP4'}`)
        if (sound && works('sound:off'))
            return found(
                'sound',
                ...(form.bgm ? [i18n.value.save.bgm] : []),
                ...(form.sfx ? [i18n.value.modals.form.sfx.label] : []),
            )
        return undefined
    })()

    const graphics = ((): Found | undefined => {
        if (fits(input, form.resolution, form.renderScale, form.antialias)) return undefined
        if (form.antialias && fits(input, form.resolution, form.renderScale, false))
            return found('antialias', i18n.value.settings.preview.antialias)
        const scale = lower([1, 1.5, 2], form.renderScale).find((value) =>
            fits(input, form.resolution, value, form.antialias),
        )
        if (scale)
            return found(
                'renderScale',
                `${i18n.value.settings.preview.renderScale} ${form.renderScale}x`,
            )
        // A lower size that the codec probes refused counts only while the codec check fails too.
        // Every choice is then probed with the failing settings.
        const resolution = lower(RESOLUTIONS, form.resolution).find(
            (value) =>
                fits(input, value, form.renderScale, form.antialias) &&
                (codecFails || support.choices[`resolution:${value}`]?.supported !== false),
        )
        return resolution ? found('resolution', resolutionItem) : undefined
    })()

    // The codec's lower resolution already fits the limits.
    const named = (
        codec?.field === 'resolution' && graphics?.field === 'resolution'
            ? [codec]
            : [codec, graphics]
    ).filter((check) => !!check)
    if (!named.length) return []
    const items = named.flatMap((check) => check.items).join(strings.unavailableSeparator)
    return [
        {
            kind: 'unavailable',
            severity: 'warning',
            text: interpolateRaw(strings.unavailable, items),
            fields: named.map((check) => check.field),
        },
    ]
}

/** The memory warning, while the settings work and the export would keep its file in memory. */
const memory = (input: MessageInput): ExportMessage[] => {
    const { form, outcome } = input
    const works =
        input.support.current?.supported === true &&
        input.limits !== undefined &&
        fits(input, form.resolution, form.renderScale, form.antialias) &&
        input.frames > 0
    const large = works && input.memoryRoute && input.bytes > VIDEO_MEMORY_WARNING_BYTES
    // A memory failure gives its own advice. In Ready, an estimate no larger than the file's own
    // has just worked.
    const memoryFailed = outcome?.kind === 'failed' && outcome.failure.reason === 'memory'
    const worked = outcome?.kind === 'ready' && input.bytes <= outcome.asked.bytes
    return large && !memoryFailed && !worked
        ? [{ kind: 'memory', severity: 'warning', text: i18n.value.exportVideo.memoryWarning }]
        : []
}

/**
 * The unavailable line, or the memory warning: one needs a check to fail, the other all to pass.
 */
const advice = (input: MessageInput): ExportMessage[] => [...unavailable(input), ...memory(input)]

/** What the finished file lacks, for the settings of its attempt. */
const finished = (outcome: Extract<Outcome, { kind: 'ready' | 'done' }>): ExportMessage[] => {
    const strings = i18n.value.exportVideo.warnings
    const has = (code: string) => outcome.warnings.some((warning) => warning.code === code)
    const resized = outcome.warnings.find((warning) => warning.code === 'resolutionDiffers')
    const sound = outcome.asked.bgm || outcome.asked.sfx
    const lines: [ExportMessage['severity'], string | undefined][] = [
        [
            'warning',
            has('pictureStopped')
                ? strings.pictureStops
                : has('framesMissing')
                  ? strings.picturePauses
                  : undefined,
        ],
        // A picture that stopped while the page was hidden: advice for the next export.
        [
            'info',
            has('pictureStopped') && outcome.hidden
                ? i18n.value.exportVideo.keepOpenVisible
                : undefined,
        ],
        ['warning', has('timingReassigned') && !sound ? strings.uneven : undefined],
        ['warning', has('framesIncomplete') ? strings.incomplete : undefined],
        [
            'warning',
            resized &&
                interpolateRaw(
                    strings.resolution,
                    formatDimensions(resized),
                    formatDimensions(outcome.asked),
                ),
        ],
        [
            'warning',
            has('audioSyncEstimated') || (has('timingReassigned') && sound)
                ? strings.outOfSync
                : undefined,
        ],
        ['warning', has('soundStopped') ? strings.soundStops : undefined],
    ]
    return lines.flatMap(([severity, text]) =>
        text ? [{ kind: 'finished' as const, severity, text }] : [],
    )
}

/** The messages for the dialog's state, in order. */
export const exportMessages = (input: MessageInput): ExportMessage[] => {
    const { outcome } = input
    const strings = i18n.value.exportVideo
    const storage = (): ExportMessage[] =>
        input.storageNearlyFull && !input.memoryRoute
            ? [{ kind: 'storage', severity: 'warning', text: i18n.value.load.storageNearlyFull }]
            : []
    switch (input.phase) {
        case 'preparing':
        case 'exporting':
            return [
                {
                    kind: 'keepOpen',
                    severity: 'info',
                    text: input.coarse ? strings.keepOpenVisible : strings.keepOpen,
                },
            ]
        case 'cancelling':
        case 'finishing':
            return []
        case 'done':
            return outcome?.kind === 'done' ? finished(outcome) : []
        case 'failed':
            if (outcome?.kind !== 'failed') return []
            return [
                {
                    kind: 'failure',
                    severity: 'error',
                    text: outcome.failure.message(),
                    detail: outcome.failure.detail,
                },
                ...memory(input),
            ]
        case 'ready': {
            const shown: ExportMessage[] = [
                ...(input.deliverFailed
                    ? [
                          {
                              kind: 'delivery',
                              severity: 'error',
                              text:
                                  input.deliverFailed === 'share'
                                      ? strings.errors.share
                                      : strings.errors.download,
                          } as const,
                      ]
                    : []),
                ...(outcome?.kind === 'ready' ? finished(outcome) : []),
                ...advice(input),
            ]
            return shown.length ? shown : storage()
        }
        case 'setup': {
            const shown = advice(input)
            if (shown.length) return shown
            if (input.stopped)
                return [
                    {
                        kind: 'stopped',
                        severity: 'warning',
                        text: interpolateRaw(
                            strings.stopped,
                            `${input.stopped.resolution}p`,
                            `${input.stopped.renderScale}x`,
                        ),
                    },
                ]
            return storage()
        }
    }
}
