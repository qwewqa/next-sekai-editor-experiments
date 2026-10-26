import type { BackgroundFit } from '../engine/background'
import type { LoadedParticle } from '../particle'
import type { LoadedSkin } from '../skin'

/** A package that ships with the web build besides Default. */
export type BundledId = 'skin2' | 'effect2'

export type AssetType = 'skin' | 'particle' | 'background' | 'effect'

export type AssetChoice =
    | { source: 'default' }
    | { source: 'builtin' }
    | { source: 'bundled'; id: BundledId }
    | {
          source: 'file' | 'server'
          /** sha256 of the stored package */
          key: string
          name: string
          title: string
          author: string
          /** file name or server URL */
          origin: string
      }

export type { BackgroundFit }

export type LoadedBackground = {
    /** The item's title, for a stored background. */
    title?: string
    /** Object URL or asset URL */
    url: string
    aspectRatio: number
    fit: BackgroundFit
    /** CSS colour behind the image */
    color: string
    blur: number
    /** CSS colour of an overlay, if any */
    mask: string | undefined
    /** Releases an object URL when the background is replaced. */
    dispose?: () => void
}

export const sfxSlots = [
    'normalTap',
    'criticalTap',
    'normalFlick',
    'criticalFlick',
    'normalTrace',
    'criticalTrace',
    'normalTick',
    'criticalTick',
    'normalActive',
    'criticalActive',
] as const
export type SfxSlot = (typeof sfxSlots)[number]

export type LoadedEffect = {
    title: string
    /** A slot whose clip is missing or won't decode is undefined. */
    buffers: Record<SfxSlot, AudioBuffer | undefined>
}

export type Loaded = {
    skin: LoadedSkin
    particle: LoadedParticle
    background: LoadedBackground
    effect: LoadedEffect
}

/** `offline`: a server item could not be downloaded again with the device offline. */
export type AssetErrorCode = 'missing' | 'corrupt' | 'unavailable' | 'offline'

/** The typed failure of a provider; the code picks the reason shown to the user. */
export class AssetError extends Error {
    constructor(
        readonly code: AssetErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'AssetError'
    }
}

export type LoadContext = {
    signal: AbortSignal
    decodeAudio: (data: ArrayBuffer) => Promise<AudioBuffer>
}

/** A provider returns the decoded resource, undefined when it is absent or aborted. */
export type DefaultProvider<T extends AssetType> = (
    context: LoadContext,
) => Promise<Loaded[T] | undefined>

/** One per build: the web's files, or the apps' Built-in. */
export type AssetDefaults = { [T in AssetType]: DefaultProvider<T> }

/** Providers for stored choices. */
export type ChoiceProviders = {
    [T in AssetType]?: (
        choice: Extract<AssetChoice, { source: 'file' | 'server' }>,
        context: LoadContext,
    ) => Promise<Loaded[T]>
}

/** The bundled packages of a build, by the type they are for. */
export type BundledProviders = {
    [T in AssetType]?: Partial<Record<BundledId, DefaultProvider<T>>>
}

/** Where the web's packages are served from, for the chooser to read their details. */
export type PackageUrls = Partial<Record<'skin' | 'particle' | 'effect' | BundledId, string>>

export type AssetStatus = {
    active: 'chosen' | 'default' | 'builtin'
    /** Why the chosen source was not used, if it was not. */
    reason?: AssetErrorCode
    /** With `chosen` and a reason: the stored item that keeps showing in place of the failed one. */
    usingTitle?: string
}

export type AssetResult<T extends AssetType> = { value: Loaded[T]; status: AssetStatus }
