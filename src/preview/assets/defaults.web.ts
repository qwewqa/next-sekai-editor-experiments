import normalTickUrl from '../../assets/se_live_connect.mp3?url'
import criticalTickUrl from '../../assets/se_live_connect_critical.mp3?url'
import criticalTapUrl from '../../assets/se_live_critical.mp3?url'
import normalFlickUrl from '../../assets/se_live_flick.mp3?url'
import criticalFlickUrl from '../../assets/se_live_flick_critical.mp3?url'
import normalActiveUrl from '../../assets/se_live_long.mp3?url'
import criticalActiveUrl from '../../assets/se_live_long_critical.mp3?url'
import normalTapUrl from '../../assets/se_live_perfect.mp3?url'
import normalTraceUrl from '../../assets/se_live_trace.mp3?url'
import criticalTraceUrl from '../../assets/se_live_trace_critical.mp3?url'
import backgroundUrl from '../bg.png'
import { TARGET_ASPECT_RATIO } from '../engine/layout'
import { loadParticleFromScp } from '../particle'
import { loadPreviewResource } from '../resource'
import { loadSkinFromScp } from '../skin'
import { syntheticBackground } from './background'
import { loadEffectFromUrls } from './effect'
import type { AssetDefaults } from './types'

declare const __APP_VERSION__: string

const resourceUrl = (name: string) =>
    `${import.meta.env.BASE_URL}resource/${name}.scp?v=${encodeURIComponent(__APP_VERSION__)}`

/** Shown from the first frame, before the background provider resolves. */
export const firstPaintBackgroundUrl: string | undefined = backgroundUrl

/** The web's Default: today's resource/*.scp, bg.png and the se_live_* clips. */
export default {
    skin: ({ signal }) => loadPreviewResource(resourceUrl('skin'), loadSkinFromScp, signal),
    particle: ({ signal }) =>
        loadPreviewResource(resourceUrl('particle'), loadParticleFromScp, signal),
    background: () => Promise.resolve(syntheticBackground(backgroundUrl, TARGET_ASPECT_RATIO)),
    effect: (context) =>
        loadEffectFromUrls(
            'Default',
            {
                normalTap: normalTapUrl,
                criticalTap: criticalTapUrl,
                normalFlick: normalFlickUrl,
                criticalFlick: criticalFlickUrl,
                normalTrace: normalTraceUrl,
                criticalTrace: criticalTraceUrl,
                normalTick: normalTickUrl,
                criticalTick: criticalTickUrl,
                normalActive: normalActiveUrl,
                criticalActive: criticalActiveUrl,
            },
            context,
        ),
} satisfies AssetDefaults
