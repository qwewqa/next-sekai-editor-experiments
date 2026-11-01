import Value from 'typebox/value'
import { takeStoppedVideoMarkers } from '../../platform/videoRunning'
import { refreshSettings, settings } from '../../settings'
import {
    exportVideoChoices,
    exportVideoStop,
    type ExportVideoChoices,
} from '../../settings/exportVideo'

export const rememberedVideoChoices = (): ExportVideoChoices => ({
    resolution: settings.exportVideoResolution,
    frameRate: settings.exportVideoFrameRate,
    quality: settings.exportVideoQuality,
    format: settings.exportVideoFormat,
    antialias: settings.exportVideoAntialias,
    renderScale: settings.exportVideoRenderScale,
    audioBitrate: settings.exportVideoAudioBitrate,
})

export const openingVideoChoices = () =>
    settings.exportVideoStops.last
        ? (settings.exportVideoLastFinished ?? Value.Create(exportVideoChoices))
        : rememberedVideoChoices()

export const countStoppedExports = () => {
    refreshSettings([
        'exportVideoStops',
        'exportVideoLastFinished',
        'exportVideoResolution',
        'exportVideoFrameRate',
        'exportVideoQuality',
        'exportVideoFormat',
        'exportVideoAntialias',
        'exportVideoRenderScale',
        'exportVideoAudioBitrate',
    ])
    return takeStoppedVideoMarkers((value) => {
        if (!Value.Check(exportVideoStop, value)) return
        const { resolution, renderScale } = value
        const key = `${resolution}:${renderScale}`
        const { counts } = settings.exportVideoStops
        settings.exportVideoStops = {
            counts: { ...counts, [key]: Math.min(255, (counts[key] ?? 0) + 1) },
            last: { resolution, renderScale },
        }
    })
}

export const finishedVideoExport = (choices: ExportVideoChoices) => {
    settings.exportVideoLastFinished = choices
    settings.exportVideoStops = { counts: {}, last: null }
}

export const resetVideoChoices = () => {
    const defaults = Value.Create(exportVideoChoices)
    settings.exportVideoResolution = defaults.resolution
    settings.exportVideoFrameRate = defaults.frameRate
    settings.exportVideoQuality = defaults.quality
    settings.exportVideoFormat = defaults.format
    settings.exportVideoAntialias = defaults.antialias
    settings.exportVideoRenderScale = defaults.renderScale
    settings.exportVideoAudioBitrate = defaults.audioBitrate
    settings.exportVideoLastFinished = null
    settings.exportVideoStops = { counts: {}, last: null }
    return takeStoppedVideoMarkers()
}
