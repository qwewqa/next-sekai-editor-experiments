import { builtinProviders } from './builtin'
import type { AssetDefaults, BundledProviders, PackageUrls } from './types'

/** The Built-in background loads like any package, so nothing shows before it. */
export const firstPaintBackgroundUrl: string | undefined = undefined

/** The apps' Default is Built-in: the four SCPs staged by build-native.mjs. */
export default builtinProviders satisfies AssetDefaults

/** The apps bundle nothing besides Built-in. */
export const bundled: BundledProviders = {}
export const packageUrls: PackageUrls = {}
