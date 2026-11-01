import { closeExportAssets, type ExportAssets } from '../../exportVideo/types'
import { copyPreviewAtlases } from '../../preview/copyPreviewAtlases'

export const copyExportAssets = async (signal: AbortSignal): Promise<ExportAssets> => {
    const result = await copyPreviewAtlases(signal, true)
    if (result.status !== 'copied')
        throw result.status === 'failed'
            ? result.error
            : new DOMException('Atlas copy cancelled', 'AbortError')
    const assets: ExportAssets = { skin: result.skin, particle: result.particle }
    const background = result.background
    if (background)
        assets.background = {
            texture: background.texture,
            url: background.url,
            aspectRatio: background.aspectRatio,
            fit: background.fit,
            color: background.color,
            blur: background.blur,
            mask: background.mask,
        }
    if (signal.aborted) {
        closeExportAssets(assets)
        signal.throwIfAborted()
    }
    return assets
}
