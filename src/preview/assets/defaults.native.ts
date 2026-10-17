import { builtinProviders } from './builtin'
import type { AssetDefaults } from './types'

/** The Built-in background loads like any package, so nothing shows before it. */
export const firstPaintBackgroundUrl: string | undefined = undefined

/** The apps' Default is Built-in: the four SCPs staged by build-native.mjs (Part 2, 2.4.1). */
export default builtinProviders satisfies AssetDefaults
