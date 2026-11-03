import type { LoadedBackground } from '../preview/assets/types'
import type { PreviewFrameInput } from '../preview/drawFrame'
import type { LoadedParticle } from '../preview/particle'
import type { LoadedSkin } from '../preview/skin'
import type { MirrorDiff } from '../preview/worker/mirror'
import type { CodecSettings } from './codecs'
import type { MixSettings } from './mix'
import type { SinkConfig } from './worker/sink'

export type ExportTarget =
    | { kind: 'picked'; pick: { handle: FileSystemFileHandle; lastModified?: number } }
    | { kind: 'staged'; name: string }
    | { kind: 'memory' }

export type ExportSettings = CodecSettings &
    MixSettings & {
        renderScale: 1 | 1.5 | 2
        antialias: boolean
        noteSpeed: number
        showEffects: boolean
        showCombo: boolean
        backdrop: NonNullable<PreviewFrameInput['backdrop']>
    }
export type ExportAssets = {
    skin: LoadedSkin
    particle?: LoadedParticle
    background?: LoadedBackground
}
export const closeExportAssets = (assets: ExportAssets) => {
    assets.skin.texture.close()
    assets.particle?.texture.close()
    assets.background?.texture.close()
}
export const assetTransfers = (assets: ExportAssets): Transferable[] => [
    assets.skin.texture,
    ...(assets.particle ? [assets.particle.texture] : []),
    ...(assets.background ? [assets.background.texture] : []),
]
export type ExportScene = {
    mirror: MirrorDiff
    settings: ExportSettings
    assets: ExportAssets
}
export type ExportConfig = SinkConfig & { settings: ExportSettings }
export type ExportStart = ExportScene & ExportConfig
