import type { RawData } from '../../analytics/catalogue'
import type { FileErrorCode } from '../../platform/types'
import type { RangeKind } from './clipRange'

export type VideoReportSettings = {
    format: 'mp4' | 'webm'
    support: 'full' | 'webmOnly'
    resolution: 720 | 1080 | 1440 | 2160
    frameRate: 30 | 60
    aspect: '16:9' | '21:9' | '4:3'
    quality: 'low' | 'standard' | 'high' | 'custom'
    renderScale: 1 | 1.5 | 2
    antialias: boolean
    audio: 'both' | 'bgm' | 'sfx' | 'none'
    range: RangeKind
    source: 'live' | 'peek'
}
export type VideoReportEnd = {
    outcome: 'done' | 'cancelled' | 'failed'
    stage?: 'prepare' | 'pick' | 'render' | 'finish'
    reason?: FileErrorCode | 'config' | 'encoder' | 'audio' | 'graphics' | 'memory' | 'hidden'
    target: 'picker' | 'download' | 'share' | 'none' | 'memory'
    hidden: boolean
    lengthSeconds: number
    sizeBytes?: number
    tookMs?: number
    renderingMs?: number
}
export const videoSpeed = (
    lengthSeconds: number,
    renderingMs: number | undefined,
): RawData<'exportVideo'>['speed'] => {
    if (
        renderingMs === undefined ||
        !Number.isFinite(renderingMs) ||
        renderingMs <= 0 ||
        !Number.isFinite(lengthSeconds) ||
        lengthSeconds < 0
    )
        return undefined
    const speed = (lengthSeconds * 1000) / renderingMs
    return speed < 0.25
        ? '<0.25'
        : speed < 0.5
          ? '0.25-0.5'
          : speed < 1
            ? '0.5-1'
            : speed < 2
              ? '1-2'
              : speed < 4
                ? '2-4'
                : speed < 8
                  ? '4-8'
                  : '8+'
}

/** Call once at the attempt's end, with work time captured before the wait for delivery. */
export const videoReport = (settings: VideoReportSettings, end: VideoReportEnd) => ({
    format: settings.format,
    support: settings.support,
    resolution: `${settings.resolution}` as const,
    frameRate: `${settings.frameRate}` as const,
    aspect: settings.aspect,
    quality: settings.quality,
    renderScale: `${settings.renderScale}` as const,
    antialias: settings.antialias,
    audio: settings.audio,
    range: settings.range,
    source: settings.source,
    outcome: end.outcome,
    ...(end.outcome !== 'done' && end.stage !== undefined && { stage: end.stage }),
    ...(end.outcome !== 'done' && end.reason !== undefined && { reason: end.reason }),
    target: end.target,
    hidden: end.hidden,
    length: end.lengthSeconds * 1000,
    ...(end.outcome === 'done' && end.sizeBytes !== undefined && { size: end.sizeBytes }),
    ...(end.tookMs !== undefined && { took: end.tookMs }),
    ...(videoSpeed(end.lengthSeconds, end.renderingMs) !== undefined && {
        speed: videoSpeed(end.lengthSeconds, end.renderingMs),
    }),
})
