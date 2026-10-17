import type { AssetType } from '../../../preview/assets'

export const previewAssetsTabs = ['skin', 'particle', 'background', 'effect', 'stored'] as const

export type PreviewAssetsTab = (typeof previewAssetsTabs)[number]

export const isAssetTab = (tab: PreviewAssetsTab): tab is AssetType => tab !== 'stored'
