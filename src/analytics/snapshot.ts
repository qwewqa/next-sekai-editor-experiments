import { settings } from '../settings'
import { bucket, type EventData } from './catalogue'

// The `settings` event: the curated settings as values, once a visit (docs/analytics.md). Only
// coarse values. Never the shortcuts, the toolbar’s contents, presets, names or server addresses.

type Settings = EventData<'settings'>

const scales = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'] as const

/** The settings snapshot. The two touch options are included only on a touch screen. */
export const settingsSnapshot = (touch: boolean, toolbarCustomized: boolean): Settings => {
    const assets = settings.previewAssets
    // A package from a server is a package of its own: the same kind as a file.
    const source = (type: keyof typeof assets) =>
        assets[type].source === 'server' ? 'file' : assets[type].source
    const step = Math.min(2, Math.max(0.25, Math.round(settings.previewRenderScale * 4) / 4))
    return {
        theme: settings.theme,
        themeShown: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
        locale: settings.locale as Settings['locale'],
        previewInWorker: settings.previewInWorker,
        previewRenderScale: scales[step * 4 - 1] ?? '1',
        previewAntialias: settings.previewAntialias,
        previewShowHitboxes: settings.previewShowHitboxes,
        previewNoteSpeed: bucket('noteSpeed', settings.previewNoteSpeed),
        'previewAssets.skin': source('skin'),
        'previewAssets.particle': source('particle'),
        'previewAssets.background': source('background'),
        'previewAssets.effect': source('effect'),
        showPreview: settings.showPreview,
        previewPosition: settings.previewPosition,
        showMinimap: settings.showMinimap === null ? 'auto' : settings.showMinimap ? 'on' : 'off',
        showHistory: settings.showHistory,
        historyPosition: settings.historyPosition,
        dimUnchangedObjects: settings.dimUnchangedObjects,
        waveform: settings.waveform,
        beatDisplay: settings.beatDisplay,
        toolbarQuickSwitch: settings.toolbarQuickSwitch,
        toolbarCustomized,
        mouseSecondaryTool: settings.mouseSecondaryTool,
        playFollow: settings.playFollow,
        confirmCloseUnsavedFile: settings.confirmCloseUnsavedFile,
        ...(touch && {
            touchQuickScrollShow: settings.touchQuickScrollShow,
            touchLongPressContextMenu: settings.touchLongPressContextMenu,
        }),
    }
}
