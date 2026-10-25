import { shallowRef, watch, type ShallowRef } from 'vue'
import { choiceKey } from './choice'
import { reasonOf, type AssetLoader } from './loader'
import { release } from './release'
import type { AssetChoice, AssetStatus, AssetType, LoadContext, Loaded } from './types'

export type AssetSlot<T extends AssetType> = {
    /** idle: not asked for yet; loading: nothing to show yet; failed: the whole chain failed. */
    state: 'idle' | 'loading' | 'ready' | 'failed'
    value?: Loaded[T]
    /** How the shown value was chosen; its reason says why the choice was not used. */
    status?: AssetStatus
    /** The choice the shown value (or the load in flight) is for. */
    choice?: AssetChoice
    /** The last switch failed and the previous value still shows; a retry may load it again. */
    stale?: boolean
    error?: unknown
}

export type AssetSession = ReturnType<typeof createAssetSession>

const types: AssetType[] = ['skin', 'particle', 'background', 'effect']

/**
 * What the preview shows of each asset type: one load per type, started on first
 * use and again when its choice changes. Only the shown asset is kept; a replaced one is closed.
 */
export const createAssetSession = (options: {
    loader: AssetLoader
    choices: () => Record<AssetType, AssetChoice>
    decodeAudio: LoadContext['decodeAudio']
}) => {
    const { loader, choices, decodeAudio } = options
    const slots = {
        skin: shallowRef<AssetSlot<'skin'>>({ state: 'idle' }),
        particle: shallowRef<AssetSlot<'particle'>>({ state: 'idle' }),
        background: shallowRef<AssetSlot<'background'>>({ state: 'idle' }),
        effect: shallowRef<AssetSlot<'effect'>>({ state: 'idle' }),
    } satisfies { [T in AssetType]: ShallowRef<AssetSlot<T>> }
    const controllers: Partial<Record<AssetType, AbortController>> = {}

    const start = async (type: AssetType) => {
        controllers[type]?.abort()
        const controller = new AbortController()
        controllers[type] = controller
        const choice = choices()[type]
        const slot = slots[type] as ShallowRef<AssetSlot<AssetType>>
        // The shown asset stays until its replacement is ready.
        slot.value = { ...slot.value, state: slot.value.value ? 'ready' : 'loading' }
        try {
            const loaded = await loader.load(type, choice, {
                signal: controller.signal,
                decodeAudio,
            })
            if (!loaded) return
            const previous = slot.value.value
            slot.value = { state: 'ready', value: loaded.value, status: loaded.status, choice }
            if (previous !== loaded.value) release(type, previous)
        } catch (error) {
            if (controller.signal.aborted) return
            if (slot.value.value) {
                console.error(`Failed to load the ${type}:`, error)
                // The old asset keeps showing, reported as a fallback from the failed choice.
                const shown = slot.value.status?.active
                const title = (slot.value.value as { title?: string }).title
                const status: AssetStatus | undefined =
                    shown === 'default' || shown === 'builtin'
                        ? { active: shown, reason: reasonOf(error) }
                        : shown === 'chosen'
                          ? { active: shown, reason: reasonOf(error), usingTitle: title }
                          : slot.value.status
                slot.value = { ...slot.value, state: 'ready', status, choice, stale: true }
                return
            }
            slot.value = { state: 'failed', error, choice }
        } finally {
            if (controllers[type] === controller) controllers[type] = undefined
        }
    }

    // A choice changed after the type was first asked for loads again, in place.
    for (const type of types)
        watch(
            () => choiceKey(choices()[type]),
            () => {
                if (slots[type].value.state !== 'idle') void start(type)
            },
            { flush: 'sync' },
        )

    return {
        slots,
        /** Starts a type's load unless it has started, or is shown, already. */
        ensure: (type: AssetType) => {
            if (slots[type].value.state === 'idle') void start(type)
        },
        /** Loads a failed type again, or one whose last switch failed. */
        retry: (type: AssetType) => {
            const { state, stale } = slots[type].value
            if (state === 'failed' || stale) void start(type)
        },
        /** Loads a shown type again, as when its decoded atlas went to a worker that stopped. */
        reload: (type: AssetType) => {
            if (slots[type].value.state !== 'idle') void start(type)
        },
        /** Aborts every load and closes what is shown. */
        dispose: () => {
            for (const type of types) {
                controllers[type]?.abort()
                release(type, slots[type].value.value)
                slots[type].value = { state: 'idle' }
            }
        },
    }
}
