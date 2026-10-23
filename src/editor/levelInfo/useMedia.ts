import { onBeforeUnmount, shallowRef, watch } from 'vue'
import { readMediaBlob } from '../../local/mediaBlob'
import type { MediaRef } from '../../state/levelInfo'

/**
 * The bytes of the media item a slot names, as a Blob and an object URL: held by this tab or
 * stored, else `absent` ("not loaded"). It reads again when the slot names another item, and
 * `reload` reads again for the same one, as after a same-file attach.
 */
export const useMedia = (ref: () => MediaRef | undefined) => {
    const status = shallowRef<'none' | 'loading' | 'ready' | 'absent'>('none')
    const blob = shallowRef<Blob>()
    const url = shallowRef<string>()
    let latest = 0

    const revoke = () => {
        if (url.value) URL.revokeObjectURL(url.value)
        url.value = undefined
    }

    const reload = async () => {
        const mine = ++latest
        const target = ref()
        if (!target) {
            blob.value = undefined
            revoke()
            status.value = 'none'
            return
        }
        status.value = 'loading'
        const result = await readMediaBlob(target)
        // A read for an item the slot no longer names is dropped.
        if (mine !== latest) return
        revoke()
        if (result.kind === 'blob') {
            blob.value = result.blob
            url.value = URL.createObjectURL(result.blob)
            status.value = 'ready'
        } else {
            blob.value = undefined
            status.value = 'absent'
        }
    }

    watch(
        () => ref()?.hash,
        () => {
            void reload()
        },
        { immediate: true },
    )
    onBeforeUnmount(() => {
        latest++
        revoke()
    })

    return { status, blob, url, reload }
}
