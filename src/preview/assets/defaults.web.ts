import backgroundUrl from '../bg.png'
import { TARGET_ASPECT_RATIO } from '../engine/layout'
import { loadParticleFromScp } from '../particle'
import { loadPreviewResource } from '../resource'
import { loadSkinFromScp } from '../skin'
import { syntheticBackground } from './background'
import { loadEffectPackage } from './builtin'
import type { AssetDefaults, BundledProviders, PackageUrls } from './types'

declare const __APP_VERSION__: string

const resourceUrl = (name: string) =>
    `${import.meta.env.BASE_URL}resource/${name}.scp?v=${encodeURIComponent(__APP_VERSION__)}`

export const packageUrls: PackageUrls = {
    skin: resourceUrl('skin'),
    skin2: resourceUrl('skin2'),
    effect: resourceUrl('effect'),
    effect2: resourceUrl('effect2'),
    particle: resourceUrl('particle'),
}

/** Next SEKAI 02, the skin and the sound effects: loaded only when chosen. */
export const bundled: BundledProviders = {
    skin: {
        skin2: ({ signal }) => loadPreviewResource(resourceUrl('skin2'), loadSkinFromScp, signal),
    },
    effect: {
        effect2: (context) => loadEffectPackage(resourceUrl('effect2'), context),
    },
}

/** Shown from the first frame, before the background provider resolves. */
export const firstPaintBackgroundUrl: string | undefined = backgroundUrl

/** The web's Default: the locked Next SEKAI packages, and bg.png for the background. */
export default {
    skin: ({ signal }) => loadPreviewResource(resourceUrl('skin'), loadSkinFromScp, signal),
    particle: ({ signal }) =>
        loadPreviewResource(resourceUrl('particle'), loadParticleFromScp, signal),
    background: () => Promise.resolve(syntheticBackground(backgroundUrl, TARGET_ASPECT_RATIO)),
    effect: (context) => loadEffectPackage(resourceUrl('effect'), context),
} satisfies AssetDefaults
